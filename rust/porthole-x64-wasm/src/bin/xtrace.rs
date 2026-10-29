//! Native (non-Wasm) trace driver for the x86-64 core.
//!
//! Loads a PE32+ image into the same `BrowserX64Emulator` that the browser and the Wine64
//! conformance harness use, arms a data breakpoint over the top of the guest stack, and prints a
//! per-instruction trace plus a full fault snapshot. This is the debugger channel used by CI to
//! publish guest state without artifact downloads.
//!
//! Usage:
//!   cargo run --bin xtrace -- <image.exe> [--budget N] [--slice N] [--trace N] [--no-watch]

use porthole_x64_wasm::pe64::MAIN_STACK_TOP;
use porthole_x64_wasm::BrowserX64Emulator;

struct Options {
    path: String,
    budget: u64,
    slice: u32,
    trace: u32,
    watch: bool,
    watch_span: u64,
    extra_watch: Vec<(u64, u64)>,
    peeks: Vec<u64>,
}

fn parse_u64(v: &str) -> Option<u64> {
    let t = v.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok()
    } else {
        t.parse().ok()
    }
}

fn parse_args() -> Options {
    let mut opts = Options {
        path: "tests/assets/wine64/user32_test.exe".to_string(),
        budget: 250_000,
        slice: 4_000,
        trace: 600,
        watch: true,
        watch_span: 0x400,
        extra_watch: Vec::new(),
        peeks: Vec::new(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--budget" => opts.budget = it.next().and_then(|v| v.parse().ok()).unwrap_or(opts.budget),
            "--slice" => opts.slice = it.next().and_then(|v| v.parse().ok()).unwrap_or(opts.slice),
            "--trace" => opts.trace = it.next().and_then(|v| v.parse().ok()).unwrap_or(opts.trace),
            "--span" => opts.watch_span = it.next().and_then(|v| v.parse().ok()).unwrap_or(opts.watch_span),
            "--no-watch" => opts.watch = false,
            "--watch" => {
                if let Some(v) = it.next() {
                    let mut parts = v.split(':');
                    let lo = parts.next().and_then(|v| parse_u64(v)).unwrap_or(0);
                    let hi = parts.next().and_then(|v| parse_u64(v)).unwrap_or(lo + 0x100);
                    opts.extra_watch.push((lo, hi));
                }
            }
            "--peek" => {
                if let Some(v) = it.next().and_then(|v| parse_u64(&v)) {
                    opts.peeks.push(v);
                }
            }
            other => opts.path = other.to_string(),
        }
    }
    opts
}

fn main() {
    let opts = parse_args();
    let bytes = match std::fs::read(&opts.path) {
        Ok(b) => b,
        Err(e) => {
            println!("cannot read {}: {e}", opts.path);
            std::process::exit(2);
        }
    };

    println!("===PORTHOLE-TRACE-BEGIN===");
    println!("image={} bytes={}", opts.path, bytes.len());

    let mut emu = BrowserX64Emulator::new(2048);
    emu.enable_trace(opts.trace);
    match emu.load_pe(&bytes) {
        Ok(info) => println!("load={info}"),
        Err(_) => {
            println!("load=FAILED");
            println!("===PORTHOLE-TRACE-END===");
            std::process::exit(3);
        }
    }

    for (lo, hi) in &opts.extra_watch {
        emu.add_write_watch(*lo, *hi);
        println!("watch+=[0x{lo:x},0x{hi:x})");
    }
    let rsp0 = emu.stack_pointer();
    if opts.watch {
        let lo = MAIN_STACK_TOP.saturating_sub(opts.watch_span);
        emu.set_write_watch(lo, MAIN_STACK_TOP, 4096);
        println!("watch=[0x{lo:x},0x{MAIN_STACK_TOP:x}) entry_rsp=0x{rsp0:x}");
    }
    println!("entry_rsp=0x{rsp0:x} aligned16_plus8={}", rsp0 % 16 == 8);

    let mut page_faults = 0u64;
    let mut slices = 0u32;
    let mut outcome = "budget".to_string();

    while emu.instructions_executed() < opts.budget {
        let status = emu.run_slice(opts.slice);
        slices += 1;
        if status == "next" {
            continue;
        }
        if let Some(addr) = status.strip_prefix("page-fault:") {
            page_faults += 1;
            if page_faults > 512 {
                outcome = format!("page-fault-storm {addr}");
                break;
            }
            // Mirror the JS harness: a swapped-out page with no persisted shard reads as zeroes.
            let base: u64 = addr.parse().unwrap_or(0);
            emu.supply_page(base, &[0u8; 4096]);
            continue;
        }
        outcome = status;
        break;
    }

    let trace = emu.take_trace();
    println!("--- trace ({} lines) ---", trace.lines().count());
    println!("{trace}");
    println!("--- fault snapshot ---");
    print!("{}", emu.fault_snapshot());
    println!("--- result ---");
    println!(
        "outcome={} instructions={} slices={} page_faults={} last_error={}",
        outcome,
        emu.instructions_executed(),
        slices,
        page_faults,
        emu.last_error()
    );
    if !opts.peeks.is_empty() {
        println!("--- memory peeks ---");
        for addr in &opts.peeks {
            println!("0x{addr:x}:");
            print!("{}", emu.peek_qwords(*addr, 4));
        }
    }
    let console = emu.take_console();
    if !console.is_empty() {
        println!("--- guest console ---");
        for line in console.lines().take(60) {
            println!("{line}");
        }
    }
    println!("===PORTHOLE-TRACE-END===");
}
