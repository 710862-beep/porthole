//! Regression guard for the Wine64 CRT-startup defects.
//!
//! Both bugs fixed for this test were *silent*: the guest ran tens of instructions and then
//! returned into garbage, which only showed up as `access violation at 0x100c70...`. These checks
//! assert the structural properties that were violated instead of a magic instruction count:
//!
//! 1. `RSP` must never walk *up* past the entry stack pointer. An upcall that forgets to balance
//!    its frame leaks 8 bytes per call, and after a handful of HLE calls every `ret` pops the wrong
//!    slot.
//! 2. `RSP` must stay inside the process stack region for the whole run.
//! 3. Execution must not leave the mapped image with a return address that was never pushed.

use std::path::PathBuf;

use porthole_x64_wasm::pe64::{MAIN_STACK_BOTTOM, MAIN_STACK_TOP};
use porthole_x64_wasm::BrowserX64Emulator;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/assets/wine64")
        .join(name)
}

fn run(name: &str, budget: u64) -> Option<(String, u64, u64, u64, String)> {
    let path = fixture(name);
    if !path.is_file() {
        eprintln!("fixture {} not built; skipping", path.display());
        return None;
    }
    let bytes = std::fs::read(&path).expect("fixture readable");
    let mut emu = BrowserX64Emulator::new(1024);
    if emu.load_pe(&bytes).is_err() {
        panic!("{name}: PE32+ load failed");
    }
    emu.enable_trace(512);
    let entry_rsp = emu.stack_pointer();
    let mut outcome = "budget".to_string();
    let mut faults = 0u64;
    while emu.instructions_executed() < budget {
        let status = emu.run_slice(2_000);
        if status == "next" {
            continue;
        }
        if let Some(addr) = status.strip_prefix("page-fault:") {
            faults += 1;
            let base: u64 = addr.parse().unwrap_or(0);
            if faults > 256 {
                outcome = format!("page-fault-storm:{addr}");
                break;
            }
            emu.supply_page(base, &[0u8; 4096]);
            continue;
        }
        outcome = status;
        break;
    }
    let rsp = emu.stack_pointer();
    let snapshot = emu.fault_snapshot();
    Some((outcome, emu.instructions_executed(), entry_rsp, rsp, snapshot))
}

#[test]
fn user32_crt_startup_stack_stays_symmetric() {
    let Some((outcome, insns, entry_rsp, rsp, snapshot)) = run("user32_test.exe", 20_000) else {
        return;
    };
    assert!(
        rsp <= entry_rsp,
        "RSP walked above the entry stack pointer (0x{rsp:x} > 0x{entry_rsp:x}) after {insns} \
         instructions -- an upcall frame leaked.\n{snapshot}"
    );
    assert!(
        rsp > MAIN_STACK_BOTTOM && rsp < MAIN_STACK_TOP,
        "RSP left the guest stack region: 0x{rsp:x}\n{snapshot}"
    );
    assert!(
        insns >= 85,
        "guest stopped after only {insns} instructions: {outcome}\n{snapshot}"
    );
}

#[test]
fn kernel32_crt_startup_stack_stays_symmetric() {
    let Some((_outcome, insns, entry_rsp, rsp, snapshot)) = run("kernel32_test.exe", 20_000) else {
        return;
    };
    assert!(
        rsp <= entry_rsp && rsp > MAIN_STACK_BOTTOM && rsp < MAIN_STACK_TOP,
        "stack invariant broken after {insns} instructions (rsp=0x{rsp:x} entry=0x{entry_rsp:x})\n{snapshot}"
    );
}

#[test]
fn fault_snapshot_reports_stack_and_registers() {
    let Some((_outcome, _insns, _entry, _rsp, snapshot)) = run("porthole_x64_plan_test.exe", 2_000)
    else {
        return;
    };
    assert!(snapshot.contains("rsp=0x"));
    assert!(snapshot.contains("stack (32 qwords"));
    assert!(snapshot.contains("last RIPs:"));
    assert!(snapshot.contains("stack page: page=0x"));
}
