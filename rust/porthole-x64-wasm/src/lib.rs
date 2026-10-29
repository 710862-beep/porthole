use std::collections::BTreeMap;

use wasm_bindgen::prelude::*;

pub mod cpu;
pub mod cpu_simd;
pub mod d3d12_hle;
pub mod jit;
pub mod pe64;
pub mod vmm;
pub mod win32_fmt;
pub mod win32_hle;

use cpu::{CpuState, ExecOutcome};
use jit::HybridWasmJit;
use pe64::{load_pe64_image, init_teb, LoadedPe64Info, MAIN_STACK_BOTTOM, MAIN_STACK_TOP,
           MAIN_TEB_ADDR, THUNK_BASE, THUNK_REGION_SIZE, THUNK_STRIDE};
use vmm::{MemoryTrap, VirtualMemoryManager, MEM_COMMIT, PAGE_READWRITE};
use win32_hle::{HleAction, UpcallStep, Win32Kernel};

/// Extra pseudo-thunk used as the return address of HLE upcalls.
pub const UPCALL_RETURN_THUNK: u64 = THUNK_BASE + THUNK_REGION_SIZE - THUNK_STRIDE;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Ready,
    Running,
    ExitProcess(u32),
    Fault,
    Halted,
}

const MAX_CONSOLE_BYTES: usize = 8 * 1024 * 1024;

/// Phase 5 driver: owns the Wasm x86-64 core, VMM, HLE kernel and JIT cache, and exposes a
/// slice-based execution API that a browser (or a Node conformance harness) pumps from JS.
#[wasm_bindgen]
pub struct BrowserX64Emulator {
    vmm: VirtualMemoryManager,
    cpu: CpuState,
    jit: HybridWasmJit,
    kernel: Win32Kernel,
    loaded: Option<LoadedPe64Info>,
    status: RunStatus,
    fault_message: String,
    pending_upcall: bool,
    frames_presented_seen: u64,
    console: Vec<u8>,
    /// Instruction-level execution trace (see [`BrowserX64Emulator::enable_trace`]).
    trace: Vec<String>,
    trace_max: usize,
    trace_enabled: bool,
}

#[wasm_bindgen]
impl BrowserX64Emulator {
    #[wasm_bindgen(constructor)]
    pub fn new(max_resident_pages: u32) -> BrowserX64Emulator {
        BrowserX64Emulator {
            vmm: VirtualMemoryManager::new(max_resident_pages as usize),
            cpu: CpuState::new(),
            jit: HybridWasmJit::new(),
            kernel: Win32Kernel::new(),
            loaded: None,
            status: RunStatus::Ready,
            fault_message: String::new(),
            pending_upcall: false,
            frames_presented_seen: 0,
            console: Vec::new(),
            trace: Vec::new(),
            trace_max: 0,
            trace_enabled: false,
        }
    }

    // ----------------------------------------------------------- provisioning

    pub fn vfs_insert(&mut self, path: &str, bytes: &[u8]) {
        self.kernel.vfs_insert_file(path, bytes);
    }

    pub fn vfs_mkdir(&mut self, path: &str) {
        self.kernel.vfs_insert_directory(path);
    }

    pub fn vfs_read(&self, path: &str) -> Option<Vec<u8>> {
        self.kernel.vfs_snapshot(path)
    }

    /// Sets the guest command line (`GetCommandLineA/W`, `argc`/`argv`), e.g.
    /// `"kernel32_test.exe atom"` so a winetest binary runs a single subtest.
    pub fn set_command_line(&mut self, line: &str) {
        self.kernel.set_command_line(line);
    }

    /// Maps a PE32+ (`0x8664`) image, resolves imports against the HLE thunk space, initializes
    /// PEB/TEB/stack, and runs the AOT block compiler over `.text`.
    pub fn load_pe(&mut self, bytes: &[u8]) -> Result<String, JsValue> {
        self.kernel.init_runtime_tables();
        self.kernel.init_heaps(&mut self.vmm);
        self.kernel.d3d12 = d3d12_hle::D3d12Subsystem::new();

        // Reserve the whole HLE thunk region as executable before COM/D3D12 setup allocates
        // vtable slots inside it.
        self.vmm.map_region(
            THUNK_BASE,
            THUNK_REGION_SIZE,
            vmm::PAGE_EXECUTE_READWRITE,
            MEM_COMMIT,
            vmm::MEM_PRIVATE,
            true,
        );
        let mut next_thunk = THUNK_BASE + 0x1000;
        let kernel_thunk_pool = next_thunk;
        self.kernel.d3d12.init_memory(&mut self.vmm, || {
            let slot = next_thunk;
            next_thunk += THUNK_STRIDE;
            slot
        });

        let vmm = &mut self.vmm;
        let jit = &mut self.jit;

        // One thunk slot per *distinct* import, assigned in import-table order. Hashing the
        // (dll,symbol) pair into a 4096-slot table used to alias colliding imports onto the same
        // stub (188 imports over 4096 slots is ~4 expected collisions), which silently dispatched
        // calls to the wrong Win32 API. The BTreeMap keeps the assignment deterministic.
        let mut thunk_slots: BTreeMap<(String, String, u16), u64> = BTreeMap::new();
        let mut next_import_thunk = THUNK_BASE + 0x1000;
        let (info, bindings) = load_pe64_image(bytes, vmm, jit, |dll: &str, symbol: &str, ordinal: u16| {
            let key = (dll.to_string(), symbol.to_string(), ordinal);
            if let Some(&slot) = thunk_slots.get(&key) {
                return slot;
            }
            let slot = next_import_thunk;
            next_import_thunk += THUNK_STRIDE;
            thunk_slots.insert(key, slot);
            slot
        })
        .map_err(|e| JsValue::from_str(&e))?;
        let thunk_slot_count = thunk_slots.len();

        // Fill each bound thunk with RET and record the thunk -> (dll,symbol) mapping used by the
        // dispatcher when RIP enters the HLE region.
        for ((dll, symbol, ordinal), thunk) in &thunk_slots {
            let _ = self.vmm.host_write_bytes(*thunk, &[0xC3]);
            self.kernel
                .remember_import_thunk(*thunk, dll, symbol, *ordinal);
        }
        let _ = (kernel_thunk_pool, &bindings);

        // Entry state: Win64 startup stack with the return address pointing at the exit thunk.
        self.cpu = CpuState::new();
        self.cpu.gs_base = MAIN_TEB_ADDR;
        self.cpu.rip = info.entry_point;
        // Win64 ABI: at the first instruction of a function RSP % 16 == 8 (the call pushed the
        // return address). MAIN_STACK_TOP is 16-byte aligned, so bias by 0x108 rather than 0x100.
        self.cpu.gpr[4] = MAIN_STACK_TOP - 0x108; // RSP
        self.cpu.gpr[5] = 0; // RBP
        let rsp = self.cpu.gpr[4];
        let _ = self.vmm.write_u64(rsp, UPCALL_RETURN_THUNK);
        // Home space + arg registers are zeroed for the CRT entry point.
        for i in 0..4u64 {
            let _ = self.vmm.write_u64(rsp + 8 + i * 8, 0);
        }
        let _ = MAIN_STACK_BOTTOM;
        init_teb(
            &mut self.vmm,
            MAIN_TEB_ADDR,
            MAIN_STACK_TOP,
            MAIN_STACK_BOTTOM,
            0x1000,
            0x1004,
            0,
        );

        let summary = format!(
            "{{\"imageBase\":{},\"entryPoint\":{},\"sizeOfImage\":{},\"textSize\":{},\"imports\":{},\"aotBlocks\":{},\"bindings\":{}}}",
            info.image_base,
            info.entry_point,
            info.size_of_image,
            info.text_size,
            info.import_count,
            info.aot_blocks_compiled,
            thunk_slot_count
        );
        self.loaded = Some(info);
        self.status = RunStatus::Running;
        Ok(summary)
    }

    // -------------------------------------------------------------- execution

    /// Executes up to `max_instructions` guest instructions. Returns a compact status string:
    /// `next` (budget exhausted), `exit:<code>`, `fault:<message>`, `page-fault:<addr>` or `halt`.
    pub fn run_slice(&mut self, max_instructions: u32) -> String {
        if self.loaded.is_none() {
            return "halt".to_string();
        }
        if let RunStatus::ExitProcess(code) = self.status {
            return format!("exit:{}", code);
        }

        let mut executed = 0u32;
        while executed < max_instructions {
            // --- upcall sentinel: a guest function that the HLE invoked has returned -------------
            if self.cpu.rip == UPCALL_RETURN_THUNK {
                match self.kernel.finish_upcall(&mut self.vmm) {
                    Some(UpcallStep::Call(target)) => {
                        // The upcalled function's own `ret` already popped the sentinel, so RSP is
                        // back at the interrupted HLE stub's frame. Stage a *new* sentinel one slot
                        // below it and enter the next guest constructor.
                        let rsp = self.cpu.gpr[4];
                        let ret_slot = rsp.wrapping_sub(8);
                        let _ = self.vmm.write_u64(ret_slot, UPCALL_RETURN_THUNK);
                        self.trace_event(format!(
                            "U sentinel->call 0x{:x} rsp=0x{:x}->0x{:x}",
                            target, rsp, ret_slot
                        ));
                        self.cpu.gpr[4] = ret_slot;
                        self.cpu.rip = target;
                        self.pending_upcall = true;
                        continue;
                    }
                    Some(UpcallStep::Resume(resume_rip)) => {
                        // Re-enter the API stub with the stack untouched: this time its handler
                        // returns a plain value and the driver pops the guest's real return
                        // address from [rsp] as usual.
                        self.trace_event(format!(
                            "R sentinel->resume 0x{:x} rsp=0x{:x}",
                            resume_rip, self.cpu.gpr[4]
                        ));
                        self.cpu.rip = resume_rip;
                        self.pending_upcall = false;
                        continue;
                    }
                    None => {
                        // No upcall in flight: the process entry point returned.
                        let code = self.kernel.exit_code.unwrap_or(0);
                        self.status = RunStatus::ExitProcess(code);
                        self.trace_event(format!("E entry returned, exit {code}"));
                        return format!("exit:{}", code);
                    }
                }
            }

            let insn_rip = self.cpu.rip;
            let rsp_before = self.cpu.gpr[4];
            self.vmm.current_rip = insn_rip;

            // --- HLE thunk range ---------------------------------------------------------------
            if insn_rip >= THUNK_BASE && insn_rip < THUNK_BASE + THUNK_REGION_SIZE {
                match self.kernel.lookup_import_thunk(insn_rip) {
                    Some((dll, symbol, ordinal)) => {
                        let args = self.capture_args();
                        let rsp = self.cpu.gpr[4];
                        // Snapshot the return address *before* the call, so a corrupted slot shows
                        // up as an explicit ret_slot=0x... value rather than an unexplained jump.
                        let ret_slot_addr = rsp;
                        let ret_slot_val = self.vmm.read_u64(ret_slot_addr).unwrap_or(0);
                        let action = self.kernel.dispatch(
                            &mut self.vmm,
                            &dll,
                            &symbol,
                            ordinal,
                            &args,
                            rsp,
                            insn_rip,
                        );
                        match action {
                            HleAction::Return(rax) => {
                                self.cpu.gpr[0] = rax;
                                let ret = self.vmm.read_u64(rsp).unwrap_or(0);
                                self.cpu.gpr[4] = rsp.wrapping_add(8);
                                self.cpu.rip = ret;
                                self.cpu.instructions_executed =
                                    self.cpu.instructions_executed.wrapping_add(1);
                                self.trace_event(format!(
                                    "H 0x{:x} {}!{} rsp=0x{:x} [rsp]=0x{:x} -> rax=0x{:x} ret=0x{:x}",
                                    insn_rip, dll, symbol, rsp, ret_slot_val, rax, ret
                                ));
                                self.drain_watch();
                                executed += 1;
                                continue;
                            }
                            HleAction::Upcall { target, resume_rip, .. } => {
                                let ret_slot = rsp.wrapping_sub(8);
                                let _ = self.vmm.write_u64(ret_slot, UPCALL_RETURN_THUNK);
                                self.cpu.gpr[4] = ret_slot;
                                self.cpu.rip = target;
                                self.pending_upcall = true;
                                self.trace_event(format!(
                                    "U 0x{:x} {}!{} upcall -> 0x{:x} resume=0x{:x} rsp=0x{:x}->0x{:x}",
                                    insn_rip, dll, symbol, target, resume_rip, rsp, ret_slot
                                ));
                                self.drain_watch();
                                continue;
                            }
                            HleAction::ExitProcess(code) => {
                                self.status = RunStatus::ExitProcess(code);
                                self.console.extend_from_slice(&self.kernel.drain_stdout());
                                self.trace_event(format!("E ExitProcess({code}) from {symbol}"));
                                return format!("exit:{}", code);
                            }
                        }
                    }
                    None => {
                        if let Some((kind, slot)) = self.kernel.d3d12.lookup_method(insn_rip) {
                            let args = self.capture_args();
                            let rsp = self.cpu.gpr[4];
                            let result = {
                                let client_sizes = self.kernel.window_sizes();
                                let d3d = &mut self.kernel.d3d12;
                                d3d.dispatch_vtable_call(
                                    kind,
                                    slot,
                                    &args,
                                    &mut self.vmm,
                                    |_h| {},
                                    move |hwnd| {
                                        client_sizes
                                            .iter()
                                            .find(|(h, _, _)| *h == hwnd)
                                            .map(|(_, w, h)| (*w, *h))
                                    },
                                )
                            };
                            self.cpu.gpr[0] = result;
                            let ret = self.vmm.read_u64(rsp).unwrap_or(0);
                            self.cpu.gpr[4] = rsp.wrapping_add(8);
                            self.cpu.rip = ret;
                            self.trace_event(format!(
                                "H d3d12 0x{:x} slot={} rsp=0x{:x} -> rax=0x{:x} ret=0x{:x}",
                                insn_rip, slot, rsp, result, ret
                            ));
                            executed += 1;
                            continue;
                        }
                        self.status = RunStatus::Fault;
                        self.fault_message = format!("unmapped thunk 0x{insn_rip:x}");
                        self.trace_event(format!("F unmapped thunk 0x{insn_rip:x} rsp=0x{rsp_before:x}"));
                        return format!("fault:{}", self.fault_message);
                    }
                }
            }

            // --- ordinary guest instruction ----------------------------------------------------
            let outcome = self.cpu.step_one(&mut self.vmm);
            match outcome {
                Ok(ExecOutcome::Next) | Ok(ExecOutcome::Branch(_)) => {
                    executed += 1;
                    self.trace_instruction(insn_rip, rsp_before);
                    self.maybe_jit_compile(insn_rip);
                }
                Ok(ExecOutcome::Fault(msg)) => {
                    if msg.starts_with("INT3") {
                        let ret = self.vmm.read_u64(self.cpu.gpr[4]).unwrap_or(0);
                        if ret == UPCALL_RETURN_THUNK {
                            self.cpu.gpr[4] = self.cpu.gpr[4].wrapping_add(8);
                            self.cpu.rip = ret;
                            continue;
                        }
                    }
                    self.status = RunStatus::Fault;
                    self.fault_message = msg;
                    self.trace_event(format!(
                        "F decode/exec fault at 0x{insn_rip:x}: {}",
                        self.fault_message
                    ));
                    return format!("fault:{}", self.fault_message);
                }
                Err(MemoryTrap::PageFault(addr)) => {
                    self.trace_event(format!("P page-fault 0x{addr:x} at 0x{insn_rip:x}"));
                    self.trace_instruction(insn_rip, rsp_before);
                    return format!("page-fault:{}", addr);
                }
                Err(MemoryTrap::AccessViolation(addr)) => {
                    self.status = RunStatus::Fault;
                    self.fault_message = format!(
                        "access violation at 0x{addr:x} (rax=0x{:x} rcx=0x{:x} rdx=0x{:x} rsp=0x{:x} gs=0x{:x}); history: {}",
                        self.cpu.gpr[0], self.cpu.gpr[1], self.cpu.gpr[2], self.cpu.gpr[4],
                        self.cpu.gs_base, self.cpu.render_rip_history()
                    );
                    self.trace_instruction(insn_rip, rsp_before);
                    self.trace_event(format!(
                        "F access violation 0x{addr:x} at 0x{insn_rip:x} rsp=0x{:x}",
                        self.cpu.gpr[4]
                    ));
                    return format!("fault:{}", self.fault_message);
                }
            }

            if let Some(code) = self.kernel.exit_code {
                self.status = RunStatus::ExitProcess(code);
                self.console.extend_from_slice(&self.kernel.drain_stdout());
                return format!("exit:{}", code);
            }
        }

        self.console.extend_from_slice(&self.kernel.drain_stdout());
        "next".to_string()
    }

    // ------------------------------------------------------------------ tracing

    /// Records up to `max_entries` execution events (instructions, HLE dispatches, upcall
    /// transitions, page faults and stores inside the optional write watch).
    pub fn enable_trace(&mut self, max_entries: u32) {
        self.trace.clear();
        self.trace_max = max_entries as usize;
        self.trace_enabled = self.trace_max > 0;
    }

    pub fn take_trace(&mut self) -> String {
        self.trace_enabled = false;
        std::mem::take(&mut self.trace).join("\n")
    }

    /// Appends a trace line, keeping a ring of the most recent `trace_max` events so the state
    /// immediately *before* a fault is always available.
    fn trace_push(&mut self, line: String) {
        if !self.trace_enabled || self.trace_max == 0 {
            return;
        }
        if self.trace.len() >= self.trace_max {
            self.trace.remove(0);
        }
        self.trace.push(line);
    }

    fn trace_event(&mut self, line: String) {
        self.trace_push(line);
    }

    fn trace_instruction(&mut self, insn_rip: u64, rsp_before: u64) {
        if !self.trace_enabled || self.trace_max == 0 {
            return;
        }
        let mut bytes = [0u8; 8];
        let mut hex = String::new();
        if self.vmm.host_read_bytes(insn_rip, &mut bytes).is_ok() {
            for b in bytes {
                hex.push_str(&format!("{b:02x}"));
            }
        }
        let line = format!(
            "I 0x{:x} rsp=0x{:x}->0x{:x} rax=0x{:x} rsi=0x{:x} rdi=0x{:x} rbp=0x{:x} bytes={}",
            insn_rip,
            rsp_before,
            self.cpu.gpr[4],
            self.cpu.gpr[0],
            self.cpu.gpr[6],
            self.cpu.gpr[7],
            self.cpu.gpr[5],
            hex
        );
        self.trace_push(line);
        self.drain_watch();
    }

    /// Emits every store the VMM's data breakpoint caught since the last drain.
    fn drain_watch(&mut self) {
        if !self.trace_enabled || self.trace_max == 0 || self.vmm.watch_log.is_empty() {
            return;
        }
        let events = std::mem::take(&mut self.vmm.watch_log);
        for ev in events {
            let tag = if ev.host { "host" } else { "guest" };
            self.trace_push(format!(
                "W 0x{:x} <- 0x{:x} len={} at 0x{:x} ({})",
                ev.addr, ev.value, ev.len, ev.rip, tag
            ));
        }
    }

    /// Full register + stack + page report for the current (or last) fault. Deliberately verbose:
    /// it is the only state that survives a `run_slice` returning `fault:`.
    pub fn fault_snapshot(&mut self) -> String {
        let mut out = String::new();
        let rsp = self.cpu.gpr[4];
        out.push_str(&format!(
            "status={} rip=0x{:x} rflags=0x{:x} insns={}\n",
            self.status_text(),
            self.cpu.rip,
            self.cpu.rflags,
            self.cpu.instructions_executed
        ));
        out.push_str(&format!(
            "rsp=0x{rsp:x} rbp=0x{:x} rax=0x{:x} rbx=0x{:x} rcx=0x{:x} rdx=0x{:x} rsi=0x{:x} rdi=0x{:x}\n",
            self.cpu.gpr[5], self.cpu.gpr[0], self.cpu.gpr[3], self.cpu.gpr[1],
            self.cpu.gpr[2], self.cpu.gpr[6], self.cpu.gpr[7]
        ));
        out.push_str(&format!(
            "r8=0x{:x} r9=0x{:x} r10=0x{:x} r11=0x{:x} r12=0x{:x} r13=0x{:x} r14=0x{:x} r15=0x{:x} gs=0x{:x} fs=0x{:x}\n",
            self.cpu.gpr[8], self.cpu.gpr[9], self.cpu.gpr[10], self.cpu.gpr[11],
            self.cpu.gpr[12], self.cpu.gpr[13], self.cpu.gpr[14], self.cpu.gpr[15],
            self.cpu.gs_base, self.cpu.fs_base
        ));
        out.push_str(&format!(
            "stack page: {}\n",
            self.vmm.describe_page(rsp)
        ));
        if !self.fault_message.is_empty() {
            out.push_str(&format!("fault: {}\n", self.fault_message));
        }
        out.push_str("stack (32 qwords from rsp-0x40):\n");
        let base = rsp.wrapping_sub(0x40);
        for i in 0..32u64 {
            let addr = base.wrapping_add(i * 8);
            let mut buf = [0u8; 8];
            let val = match self.vmm.host_read_bytes(addr, &mut buf) {
                Ok(()) => u64::from_le_bytes(buf),
                Err(_) => 0xFFFF_FFFF_FFFF_FFFF,
            };
            let marker = if addr == rsp {
                "  <= rsp"
            } else if addr == self.cpu.gpr[5] {
                "  <= rbp"
            } else {
                ""
            };
            out.push_str(&format!("  [0x{addr:x}] 0x{val:016x}{marker}\n"));
        }
        out.push_str(&format!(
            "last RIPs: {}\n",
            self.cpu.render_rip_history()
        ));
        out
    }

    fn capture_args(&mut self) -> [u64; 10] {
        let mut args = [0u64; 10];
        args[0] = self.cpu.gpr[1]; // RCX
        args[1] = self.cpu.gpr[2]; // RDX
        args[2] = self.cpu.gpr[8]; // R8
        args[3] = self.cpu.gpr[9]; // R9
        let rsp = self.cpu.gpr[4];
        for i in 0..6u64 {
            args[4 + i as usize] = self.vmm.read_u64(rsp + 0x28 + i * 8).unwrap_or(0);
        }
        args
    }

    fn maybe_jit_compile(&mut self, insn_rip: u64) {
        let page_base = insn_rip & !0xFFF;
        let should = self
            .cpu
            .icache
            .get(&page_base)
            .map(|cb| cb.exec_count == 64)
            .unwrap_or(false);
        if !should {
            return;
        }
        let epoch = self.vmm.page_write_epoch(page_base);
        if self.jit.get_valid_artifact(insn_rip, epoch).is_some() {
            return;
        }
        let mut window = [0u8; 64];
        if self.vmm.host_read_bytes(insn_rip, &mut window).is_ok() {
            let _ = self.jit.try_compile_block(insn_rip, epoch, &window);
        }
    }

    // -------------------------------------------------------------- debugging

    /// Arms a data breakpoint over `[lo, hi)`; every guest/HLE store into that window is emitted
    /// into the execution trace as a `W` line with the value written and the writing RIP.
    pub fn set_write_watch(&mut self, lo: u64, hi: u64, capacity: u32) {
        self.vmm.set_write_watch(lo, hi, capacity as usize);
    }

    /// Adds an extra watched window (globals, heap head, ...) to the data breakpoint set.
    pub fn add_write_watch(&mut self, lo: u64, hi: u64) {
        self.vmm.add_write_watch(lo, hi, 4096);
    }

    pub fn clear_write_watch(&mut self) {
        self.vmm.clear_write_watch();
    }

    /// Dumps `count` little-endian qwords starting at `addr`, used by the native tracer.
    pub fn peek_qwords(&mut self, addr: u64, count: u32) -> String {
        let mut out = String::new();
        for i in 0..count as u64 {
            let a = addr.wrapping_add(i * 8);
            let mut buf = [0u8; 8];
            match self.vmm.host_read_bytes(a, &mut buf) {
                Ok(()) => out.push_str(&format!(
                    "  [0x{a:x}] 0x{:016x}\n",
                    u64::from_le_bytes(buf)
                )),
                Err(_) => out.push_str(&format!("  [0x{a:x}] <unmapped>\n")),
            }
        }
        out
    }

    /// Pretty-prints one guest VA: mapping region, protection, residency, swap state and epoch.
    pub fn describe_address(&self, addr: u64) -> String {
        self.vmm.describe_page(addr)
    }

    pub fn stack_pointer(&self) -> u64 {
        self.cpu.gpr[4]
    }

    pub fn register_json(&self) -> String {
        format!(
            "{{\"rip\":{},\"rsp\":{},\"rbp\":{},\"rax\":{},\"rbx\":{},\"rcx\":{},\"rdx\":{},\"rsi\":{},\"rdi\":{},\"r8\":{},\"r9\":{},\"r10\":{},\"r11\":{},\"r12\":{},\"r13\":{},\"r14\":{},\"r15\":{},\"rflags\":{}}}",
            self.cpu.rip,
            self.cpu.gpr[4],
            self.cpu.gpr[5],
            self.cpu.gpr[0],
            self.cpu.gpr[3],
            self.cpu.gpr[1],
            self.cpu.gpr[2],
            self.cpu.gpr[6],
            self.cpu.gpr[7],
            self.cpu.gpr[8],
            self.cpu.gpr[9],
            self.cpu.gpr[10],
            self.cpu.gpr[11],
            self.cpu.gpr[12],
            self.cpu.gpr[13],
            self.cpu.gpr[14],
            self.cpu.gpr[15],
            self.cpu.rflags
        )
    }

    // -------------------------------------------------------------- telemetry

    pub fn instructions_executed(&self) -> u64 {
        self.cpu.instructions_executed
    }

    pub fn rip(&self) -> u64 {
        self.cpu.rip
    }

    pub fn status_text(&self) -> String {
        match self.status {
            RunStatus::Ready => "ready".to_string(),
            RunStatus::Running => "running".to_string(),
            RunStatus::ExitProcess(c) => format!("exit:{}", c),
            RunStatus::Fault => format!("fault:{}", self.fault_message),
            RunStatus::Halted => "halt".to_string(),
        }
    }

    pub fn take_console(&mut self) -> String {
        let bytes = std::mem::take(&mut self.console);
        String::from_utf8_lossy(&bytes).into_owned()
    }

    pub fn frames_presented(&mut self) -> u64 {
        let total = self.kernel.d3d12.frames_presented;
        let delta = total.saturating_sub(self.frames_presented_seen);
        self.frames_presented_seen = total;
        delta
    }

    /// Returns the last presented swapchain frame as tightly packed RGBA8 (width/height are
    /// retrievable through the accessors below).
    pub fn take_frame(&mut self) -> Option<Vec<u8>> {
        if !self.kernel.d3d12.frame_dirty {
            return None;
        }
        self.kernel.d3d12.frame_dirty = false;
        Some(std::mem::take(&mut self.kernel.d3d12.last_frame_rgba))
    }

    pub fn frame_width(&self) -> u32 {
        self.kernel.d3d12.last_frame_width
    }

    pub fn frame_height(&self) -> u32 {
        self.kernel.d3d12.last_frame_height
    }

    pub fn resident_pages(&self) -> u32 {
        self.vmm.resident_page_count() as u32
    }

    pub fn swapped_pages(&self) -> u32 {
        self.vmm.swapped_page_count() as u32
    }

    pub fn pages_evicted(&self) -> u64 {
        self.vmm.pages_evicted
    }

    pub fn jit_artifacts(&self) -> u32 {
        self.jit.artifact_count() as u32
    }

    pub fn jit_modules_emitted(&self) -> u64 {
        self.jit.modules_emitted
    }

    pub fn last_error(&self) -> u32 {
        self.kernel.last_error
    }

    // -------------------------------------------------------- NVMe swap bridge

    /// Drains pages evicted from RAM that must be persisted to the NVMe swap shards.
    /// Layout: repeated `[u64 page_base][4096 bytes]` records.
    pub fn drain_evicted_pages(&mut self) -> Vec<u8> {
        let evicted = self.vmm.drain_evicted_dirty_pages();
        let mut out = Vec::with_capacity(evicted.len() * (8 + 4096));
        for page in evicted {
            out.extend_from_slice(&page.page_base.to_le_bytes());
            let mut data = page.data;
            data.resize(4096, 0);
            out.extend_from_slice(&data);
        }
        out
    }

    /// Supplies a page previously persisted on NVMe after a `page-fault:<addr>` status.
    pub fn supply_page(&mut self, page_base: u64, bytes: &[u8]) {
        self.vmm.supply_faulted_page(page_base, bytes);
    }

    /// Changes the resident page budget (RAM LRU window).
    pub fn set_max_resident_pages(&mut self, pages: u32) {
        self.vmm.set_max_resident_pages(pages as usize);
    }

    /// Instantaneous counters consumed by the browser telemetry panel.
    pub fn telemetry_json(&self) -> String {
        format!(
            "{{\"instructions\":{},\"rip\":{},\"residentPages\":{},\"swappedPages\":{},\"residentLimit\":{},\"pagesEvicted\":{},\"dirtyQueued\":{},\"icacheHits\":{},\"icacheMisses\":{},\"jitArtifacts\":{},\"jitEmitted\":{},\"frames\":{},\"status\":\"{}\"}}",
            self.cpu.instructions_executed,
            self.cpu.rip,
            self.vmm.resident_page_count(),
            self.vmm.swapped_page_count(),
            self.vmm.max_resident_pages(),
            self.vmm.pages_evicted,
            self.vmm.dirty_pages_queued,
            self.cpu.icache_hits,
            self.cpu.icache_misses,
            self.jit.artifact_count(),
            self.jit.modules_emitted,
            self.kernel.d3d12.frames_presented,
            self.status_text().replace('"', "'")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emulator_constructs_without_a_pe() {
        let mut emu = BrowserX64Emulator::new(256);
        assert_eq!(emu.run_slice(16), "halt");
        assert_eq!(emu.resident_pages(), 0);
        assert!(emu.telemetry_json().contains("\"instructions\":0"));
    }
}
