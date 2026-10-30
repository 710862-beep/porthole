use std::collections::BTreeMap;

use wasm_bindgen::prelude::*;

pub mod cpu;
pub mod cpu_simd;
pub mod d3d12_hle;
pub mod jit;
pub mod sdl_hle;
pub mod pe64;
pub mod vmm;
pub mod win32_fmt;
pub mod win32_hle;

use cpu::{CpuState, ExecOutcome};
use jit::HybridWasmJit;
use pe64::{load_pe64_image, init_teb, LoadedPe64Info, MAIN_STACK_BOTTOM, MAIN_STACK_TOP,
           IMPORT_THUNK_BASE, MAIN_TEB_ADDR, THUNK_BASE, THUNK_REGION_SIZE, THUNK_STRIDE};
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
    /// Suppress the per-instruction `I`/`W` lines so the ring buffer holds only HLE traffic.
    hle_trace_only: bool,
    /// Optional substring filters: a trace line is kept only if it contains one of them.
    trace_filter: Vec<String>,
    /// Phase-1 conformance audit: bounded, drainable JSONL events. Disabled by default so
    /// production/benchmark execution does not pay for argument/memory snapshots.
    audit: Vec<String>,
    audit_max: usize,
    audit_seq: u64,
    audit_dropped: u64,
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
            hle_trace_only: false,
            trace_filter: Vec::new(),
            audit: Vec::new(),
            audit_max: 0,
            audit_seq: 0,
            audit_dropped: 0,
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

    /// Records the guest-visible path of the loaded image for `GetModuleFileNameW(NULL, ...)`.
    pub fn set_exe_path(&mut self, path: &str) {
        self.kernel.set_exe_path(path);
    }

    pub fn set_environment_variable(&mut self, name: &str, value: &str) -> bool {
        self.kernel.provision_env(name, value)
    }

    /// Maps a PE32+ (`0x8664`) image, resolves imports against the HLE thunk space, initializes
    /// PEB/TEB/stack, and runs the AOT block compiler over `.text`.
    pub fn load_pe(&mut self, bytes: &[u8]) -> Result<String, JsValue> {
        self.kernel.init_runtime_tables();
        self.kernel.init_heaps(&mut self.vmm);
        self.kernel.d3d12 = d3d12_hle::D3d12Subsystem::new();
        self.kernel.sdl = sdl_hle::SdlState::new();

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
        self.kernel.d3d12.init_memory(&mut self.vmm);

        // Data imports (`_fmode`, `_iob`, ...) must be bound to writable variable cells, not
        // code thunks: the guest dereferences the IAT slot. Binding them to thunks made real
        // MSVC CRT startup (7za.exe) write through a thunk address and fault at insn 29.
        let data_cells: std::collections::HashMap<String, u64> = self
            .kernel
            .init_data_imports(&mut self.vmm)
            .into_iter()
            .collect();

        let vmm = &mut self.vmm;
        let jit = &mut self.jit;

        // One thunk slot per *distinct* import, assigned in import-table order. Hashing the
        // (dll,symbol) pair into a 4096-slot table used to alias colliding imports onto the same
        // stub (188 imports over 4096 slots is ~4 expected collisions), which silently dispatched
        // calls to the wrong Win32 API. The BTreeMap keeps the assignment deterministic.
        let mut thunk_slots: BTreeMap<(String, String, u16), u64> = BTreeMap::new();
        let mut next_import_thunk = IMPORT_THUNK_BASE;
        let (info, bindings) = load_pe64_image(bytes, vmm, jit, |dll: &str, symbol: &str, ordinal: u16| {
            if dll == "msvcrt.dll" || dll == "ucrtbase.dll" {
                if let Some(&cell) = data_cells.get(symbol) {
                    return cell;
                }
            }
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
        let _ = &bindings;

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
                match self.kernel.finish_upcall(&mut self.vmm, &mut self.cpu) {
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
                        if let Some(ptr) = self.kernel.pending_exception_pointers() { self.cpu.gpr[1] = ptr; }
                        self.cpu.rip = target;
                        self.pending_upcall = true;
                        continue;
                    }
                    Some(UpcallStep::Resume(resume_rip)) => {
                        // Re-enter the API stub at its original frame: the last constructor's
                        // `ret` left rsp at (stub_rsp - 0x28) because upcalls are staged with a
                        // full 0x30-byte frame (sentinel + 0x20 home space + alignment), so add
                        // the frame bias back before the handler's plain Return pops the guest's
                        // real return address from [rsp].
                        self.trace_event(format!(
                            "R sentinel->resume 0x{:x} rsp=0x{:x}",
                            resume_rip, self.cpu.gpr[4]
                        ));
                        self.cpu.gpr[4] = self.cpu.gpr[4].wrapping_add(0x28);
                        self.cpu.rip = resume_rip;
                        self.pending_upcall = false;
                        continue;
                    }
                    Some(UpcallStep::ResumeGuest) => {
                        self.pending_upcall = false;
                        continue;
                    }
                    Some(UpcallStep::Fault(msg)) => {
                        self.pending_upcall = false;
                        self.status = RunStatus::Fault;
                        self.fault_message = msg;
                        self.console.extend_from_slice(&self.kernel.drain_stdout());
                        return format!("fault:{}", self.fault_message);
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

            // --- COM vtable stubs --------------------------------------------------------------
            // Checked first, and in a range of their own: a COM slot must never be able to
            // resolve as a Win32 import thunk (or vice versa).
            if insn_rip >= d3d12_hle::COM_THUNK_BASE
                && insn_rip < d3d12_hle::COM_THUNK_BASE + d3d12_hle::COM_THUNK_REGION_SIZE
            {
                if let Some((kind, slot)) = self.kernel.d3d12.lookup_method(insn_rip) {
                    let args = self.capture_args();
                    let audit_before = if self.audit_max == 0 { Vec::new() } else { self.audit_snapshots(&args) };
                    let rsp = self.cpu.gpr[4];
                    let result = {
                        let client_sizes = self.kernel.window_sizes();
                        let kernel = &mut self.kernel;
                        kernel.d3d12.dispatch_vtable_call(
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
                    self.drain_d3d12_notes();
                    let api = format!("{}::{}", d3d12_hle::interface_name(kind), d3d12_hle::method_name(kind, slot));
                    self.record_api_audit(&api, &args, result, insn_rip, &audit_before, result != d3d12_hle::E_NOTIMPL as u64);
                    self.cpu.gpr[0] = result;
                    let ret = self.vmm.read_u64(rsp).unwrap_or(0);
                    self.cpu.gpr[4] = rsp.wrapping_add(8);
                    self.cpu.rip = ret;
                    self.cpu.instructions_executed += 1;
                    self.trace_event(format!(
                        "H d3d12 {}::{} this=0x{:x} -> rax=0x{:x} (0x{:08x})",
                        d3d12_hle::interface_name(kind),
                        d3d12_hle::method_name(kind, slot),
                        args[0],
                        result,
                        result as u32
                    ));
                    executed += 1;
                    continue;
                }
                self.status = RunStatus::Fault;
                self.fault_message = format!("unregistered COM thunk 0x{insn_rip:x}");
                self.trace_event(format!("F unregistered COM thunk 0x{insn_rip:x}"));
                self.console.extend_from_slice(&self.kernel.drain_stdout());
                    return format!("fault:{}", self.fault_message);
            }

            // --- HLE thunk range ---------------------------------------------------------------
            if insn_rip >= THUNK_BASE && insn_rip < THUNK_BASE + THUNK_REGION_SIZE {
                match self.kernel.lookup_import_thunk(insn_rip) {
                    Some((dll, symbol, ordinal)) => {
                        let args = self.capture_args();
                        // Floating-point CRT imports take/return values in XMM0, which the
                        // kernel's integer-only argument capture cannot see. Resolve them here
                        // where CPU state is available; everything else goes through the kernel.
                        let float_result: Option<f64> = match symbol.as_str() {
                            "sqrtf" => {
                                let x = self.cpu.get_xmm(0);
                                let v = f32::from_le_bytes([x[0], x[1], x[2], x[3]]);
                                Some((v.sqrt()) as f64)
                            }
                            "sqrt" => {
                                let x = self.cpu.get_xmm(0);
                                let v = f64::from_le_bytes(x[0..8].try_into().unwrap());
                                Some(v.sqrt())
                            }
                            "atof" | "_atof_l" => {
                                let s = self
                                    .vmm
                                    .read_c_string(args[0], 4096)
                                    .unwrap_or_default();
                                let text = String::from_utf8_lossy(&s);
                                Some(text.trim().parse::<f64>().unwrap_or(0.0))
                            }
                            _ => None,
                        };
                        if let Some(val) = float_result {
                            self.kernel.note_hle_call(&symbol);
                            let rsp = self.cpu.gpr[4];
                            let ret = self.vmm.read_u64(rsp).unwrap_or(0);
                            let mut out = [0u8; 16];
                            if symbol == "sqrtf" {
                                out[0..4].copy_from_slice(&(val as f32).to_le_bytes());
                            } else {
                                out[0..8].copy_from_slice(&val.to_le_bytes());
                            }
                            self.cpu.set_xmm_vex_zero_upper(0, &out);
                            self.cpu.gpr[4] = rsp.wrapping_add(8);
                            self.cpu.rip = ret;
                            self.cpu.instructions_executed =
                                self.cpu.instructions_executed.wrapping_add(1);
                            self.trace_event(format!(
                                "H 0x{:x} {}!{} (xmm) -> {} ret=0x{:x}",
                                insn_rip, dll, symbol, val, ret
                            ));
                            executed += 1;
                            continue;
                        }
                        let rsp = self.cpu.gpr[4];
                        // Snapshot the return address *before* the call, so a corrupted slot shows
                        // up as an explicit ret_slot=0x... value rather than an unexplained jump.
                        let ret_slot_addr = rsp;
                        let ret_slot_val = self.vmm.read_u64(ret_slot_addr).unwrap_or(0);
                        let audit_before = if self.audit_max == 0 { Vec::new() } else { self.audit_snapshots(&args) };
                        let action = self.kernel.dispatch(
                            &mut self.vmm,
                            &dll,
                            &symbol,
                            ordinal,
                            &args,
                            rsp,
                            insn_rip,
                            &mut self.cpu,
                        );
                        if !self.kernel.hle_notes.is_empty() {
                            let notes: Vec<String> = self.kernel.hle_notes.drain(..).collect();
                            for note in notes {
                                self.trace_event(note);
                            }
                        }
                        self.drain_d3d12_notes();
                        match action {
                            HleAction::Return(rax) => {
                                let api = format!("{dll}!{symbol}");
                                let implemented = !self.kernel.is_unimplemented(&symbol);
                                self.record_api_audit(&api, &args, rax, insn_rip, &audit_before, implemented);
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
                            HleAction::Upcall { target, resume_rip, rax } => {
                                if matches!(self.kernel.pending_upcall(), Some(UpcallState::Exception { .. })) {
                                    self.cpu.gpr[1] = rax; // EXCEPTION_POINTERS*
                                }
                                // Stage a *real* Win64 call frame 0x30 below the HLE stub's rsp:
                                // [ret_slot]=sentinel, [ret_slot+8, ret_slot+0x28) = the callee's
                                // 32-byte register home/shadow space, which the upcalled guest
                                // function is entitled to write. Staging the sentinel at rsp-8
                                // (previous behaviour) put that home space on top of the HLE
                                // caller's own return-address slot at [rsp] — 7-Zip's CRT
                                // constructors legitimately store into it and destroyed
                                // _initterm's return address (Tier A fault at insn 96173,
                                // ret=0x0). rsp-0x30 also preserves the ABI entry alignment
                                // (rsp % 16 == 8). The matching +0x28 is added back on Resume.
                                let ret_slot = rsp.wrapping_sub(0x30);
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
                        // COM slots are handled in their own range above; reaching here means the
                        // guest jumped to an address inside the import-thunk window that no import
                        // was ever bound to.
                        self.status = RunStatus::Fault;
                        self.fault_message = format!("unmapped thunk 0x{insn_rip:x}");
                        self.trace_event(format!("F unmapped thunk 0x{insn_rip:x} rsp=0x{rsp_before:x}"));
                        self.console.extend_from_slice(&self.kernel.drain_stdout());
                    return format!("fault:{}", self.fault_message);
                    }
                }
            }

            // --- ordinary guest instruction ----------------------------------------------------
            let exception_snapshot = if self.kernel.has_exception_handlers() { Some(self.cpu.clone()) } else { None };
            let outcome = self.cpu.step_one(&mut self.vmm);
            match outcome {
                Ok(ExecOutcome::Next) | Ok(ExecOutcome::Branch(_)) => {
                    executed += 1;
                    if !self.hle_trace_only {
                        self.trace_instruction(insn_rip, rsp_before);
                    }
                    self.maybe_jit_compile(insn_rip);
                }
                Ok(ExecOutcome::Fault(msg)) => {
                    if let Some(snapshot) = exception_snapshot.clone() {
                        let (code, resume_rip, params) = if msg.starts_with("INT3") {
                            (0x8000_0003u32, insn_rip + 1, vec![])
                        } else if msg.starts_with("INT 0x2d") {
                            (0x8000_0003u32, insn_rip + 2, vec![])
                        } else if msg.starts_with("UD2") {
                            (0xC000_001Du32, insn_rip, vec![])
                        } else { (0, insn_rip, vec![]) };
                        if code != 0 {
                            if let Some(action) = self.kernel.begin_exception(&mut self.vmm, &snapshot, code, 0, resume_rip, snapshot.gpr[4], &params) {
                                self.cpu = snapshot;
                                self.stage_exception(action);
                                executed += 1;
                                continue;
                            }
                        }
                    }
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
                    self.console.extend_from_slice(&self.kernel.drain_stdout());
                    return format!("fault:{}", self.fault_message);
                }
                Err(MemoryTrap::PageFault(addr)) => {
                    self.trace_event(format!("P page-fault 0x{addr:x} at 0x{insn_rip:x}"));
                    if !self.hle_trace_only {
                        self.trace_instruction(insn_rip, rsp_before);
                    }
                    return format!("page-fault:{}", addr);
                }
                Err(MemoryTrap::AccessViolation(addr)) => {
                    if let Some(snapshot) = exception_snapshot {
                        if let Some(action) = self.kernel.begin_exception(&mut self.vmm, &snapshot, 0xC000_0005, 0, insn_rip, snapshot.gpr[4], &[1, addr]) {
                            self.cpu = snapshot;
                            self.stage_exception(action);
                            executed += 1;
                            continue;
                        }
                    }
                    self.status = RunStatus::Fault;
                    self.fault_message = format!(
                        "access violation at 0x{addr:x} (rax=0x{:x} rcx=0x{:x} rdx=0x{:x} rsp=0x{:x} gs=0x{:x}); history: {}",
                        self.cpu.gpr[0], self.cpu.gpr[1], self.cpu.gpr[2], self.cpu.gpr[4],
                        self.cpu.gs_base, self.cpu.render_rip_history()
                    );
                    if !self.hle_trace_only {
                        self.trace_instruction(insn_rip, rsp_before);
                    }
                    self.trace_event(format!(
                        "F access violation 0x{addr:x} at 0x{insn_rip:x} rsp=0x{:x}",
                        self.cpu.gpr[4]
                    ));
                    self.console.extend_from_slice(&self.kernel.drain_stdout());
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
    /// Enables the torture runner's structured API audit. This is diagnostics, not an
    /// execution mode: it never changes an HLE result or substitutes a test assertion.
    pub fn enable_api_audit(&mut self, max_entries: u32) {
        self.audit_max = (max_entries as usize).min(200_000);
        self.audit.clear();
        self.audit_dropped = 0;
    }

    /// Drains JSONL. `dropped` makes ring overflow visible instead of silently losing calls.
    pub fn take_api_audit(&mut self) -> String {
        let mut out = std::mem::take(&mut self.audit).join("\n");
        if self.audit_dropped != 0 {
            if !out.is_empty() { out.push('\n'); }
            out.push_str(&format!("{{\"kind\":\"audit-overflow\",\"dropped\":{}}}", self.audit_dropped));
            self.audit_dropped = 0;
        }
        out
    }

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
        if !self.trace_filter.is_empty()
            && !self.trace_filter.iter().any(|pat| line.contains(pat.as_str()))
        {
            return;
        }
        self.trace_push(line);
    }

    /// Keeps only trace lines containing one of `patterns`.
    ///
    /// The ring buffer is 260-1000 lines, but a winetest subtest issues tens of thousands of API
    /// calls; filtering by symbol name (e.g. `MultiByteToWideChar`) keeps the *whole* run.
    pub fn set_trace_filter(&mut self, patterns: Vec<String>) {
        self.trace_filter = patterns;
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

    fn audit_json_escape(text: &str) -> String {
        let mut out = String::new();
        for ch in text.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out
    }

    /// Reads only committed, resident-or-swapped guest pages; never allocates a page merely
    /// because an integer argument happens to look like a pointer.
    fn audit_snapshots(&mut self, args: &[u64; 10]) -> Vec<String> {
        args.iter().take(6).map(|&addr| {
            if addr < 0x10000 { return "null".to_string(); }
            let mut bytes = [0u8; 64];
            let len = (4096 - (addr & 0xfff)).min(64) as usize;
            match self.vmm.read_bytes(addr, &mut bytes[..len]) {
                Ok(()) => format!("\"{}\"", bytes[..len].iter().map(|b| format!("{b:02x}")).collect::<String>()),
                Err(_) => "null".to_string(),
            }
        }).collect()
    }

    fn record_api_audit(&mut self, api: &str, args: &[u64; 10], result: u64, rip: u64, before: &[String], implemented: bool) {
        if self.audit_max == 0 { return; }
        if self.audit.len() >= self.audit_max {
            self.audit_dropped += 1;
            return;
        }
        self.audit_seq += 1;
        let after = self.audit_snapshots(args);
        let caller = self.vmm.read_u64(self.cpu.gpr[4]).unwrap_or(0);
        let debug = if api.ends_with("!OutputDebugStringA") {
            self.vmm.read_c_string(args[0], 16384).ok()
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .map(|s| format!(",\"debugString\":\"{}\"", Self::audit_json_escape(&s)))
                .unwrap_or_default()
        } else { String::new() };
        self.audit.push(format!(
            "{{\"kind\":\"api\",\"seq\":{},\"instruction\":{},\"api\":\"{}\",\"rip\":\"0x{:x}\",\"caller\":\"0x{:x}\",\"args\":[{}],\"return\":\"0x{:x}\",\"lastError\":{},\"implemented\":{},\"before\":[{}],\"after\":[{}]{} }}",
            self.audit_seq, self.cpu.instructions_executed, Self::audit_json_escape(api), rip, caller,
            args.iter().map(|a| format!("\"0x{a:x}\"")).collect::<Vec<_>>().join(","),
            result, self.kernel.last_error, implemented, before.join(","), after.join(","), debug
        ));
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

    fn stage_exception(&mut self, action: HleAction) {
        if let HleAction::Upcall { target, rax, .. } = action {
            let rsp = self.cpu.gpr[4];
            let frame = rsp.wrapping_sub(0x30);
            let _ = self.vmm.write_u64(frame, UPCALL_RETURN_THUNK);
            self.cpu.gpr[4] = frame;
            self.cpu.gpr[1] = rax;
            self.cpu.rip = target;
            self.pending_upcall = true;
            self.trace_event(format!("X exception handler=0x{target:x} pointers=0x{rax:x}"));
        }
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
    /// Moves the D3D12 HLE's COM-call notes into the trace ring buffer.
    fn drain_d3d12_notes(&mut self) {
        if self.kernel.d3d12.notes.is_empty() {
            return;
        }
        let notes: Vec<String> = self.kernel.d3d12.notes.drain(..).collect();
        for note in notes {
            self.trace_event(note);
        }
    }

    /// `Interface::Method=count` histogram of the COM calls the guest made.
    pub fn com_histogram(&self, top: usize) -> String {
        self.kernel.d3d12.com_histogram(top)
    }

    /// COM methods that reached the default arm and answered `E_NOTIMPL`.
    pub fn unimplemented_methods(&self) -> String {
        self.kernel.d3d12.unimplemented_methods()
    }

    /// `symbol=count` histogram of the APIs the guest actually called.
    pub fn hle_histogram(&self, top: usize) -> String {
        self.kernel.hle_histogram(top)
    }

    /// Symbols the guest called that fell through to the "not implemented" default arm.
    pub fn unimplemented_symbols(&self) -> String {
        self.kernel.unimplemented_symbols()
    }

    /// Keep only HLE (`H`/`U`/`R`/`E`) events in the trace ring buffer.
    ///
    /// A 22 000-instruction run overflows a 260-line buffer long before the interesting API call,
    /// so the diagnostics lane can filter down to Win32 traffic and still see the whole run.
    pub fn set_hle_trace_only(&mut self, on: bool) {
        self.hle_trace_only = on;
    }

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

    /// Total frames the GUEST presented through the SDL path (Gate 2 accounting). This counter
    /// advances only inside `SDL_RenderPresent`/`SDL_UpdateWindowSurface` on guest-issued draws;
    /// there is no host-side increment and no host-authored pixels behind it.
    pub fn presented_frames(&self) -> u64 {
        self.kernel.sdl.presented_frames
    }

    /// Checksum of the last guest-presented SDL frame: FNV-1a/64 over `w|h|RGBA8` bytes,
    /// formatted `fnv1a64:<16 hex>`. Empty until the guest presents a frame. The algorithm is
    /// deliberately trivial so a reference renderer (same binary on real Wine/Windows) can
    /// reproduce it byte-for-byte for the Gate 2 comparison.
    pub fn frame_checksum(&self) -> String {
        if self.kernel.sdl.presented_frames == 0 || self.kernel.sdl.last_frame_rgba.is_empty() {
            return String::new();
        }
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |b: u8| {
            h ^= b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        };
        for b in self.kernel.sdl.last_frame_w.to_le_bytes() {
            mix(b);
        }
        for b in self.kernel.sdl.last_frame_h.to_le_bytes() {
            mix(b);
        }
        for &b in &self.kernel.sdl.last_frame_rgba {
            mix(b);
        }
        format!("fnv1a64:{h:016x}")
    }

    /// Last guest-presented SDL frame (tight RGBA8) without consuming it.
    pub fn guest_frame_rgba(&self) -> Vec<u8> {
        self.kernel.sdl.last_frame_rgba.clone()
    }

    pub fn guest_frame_width(&self) -> u32 {
        self.kernel.sdl.last_frame_w
    }

    pub fn guest_frame_height(&self) -> u32 {
        self.kernel.sdl.last_frame_h
    }

    /// Measurement tap: the guest's native-resolution SDL frame (tight RGBA8) as written into
    /// its streaming texture, before any host scaling. Exists so the Gate 2 Wine reference can
    /// compare byte-for-byte against the same binary's own screenshots (320x200 for Doom).
    /// Not a presented frame; see presented_frames()/guest_frame_rgba() for that claim.
    pub fn guest_native_frame_rgba(&self) -> Vec<u8> {
        self.kernel.sdl.native_frame_rgba.clone()
    }

    pub fn guest_native_frame_width(&self) -> u32 {
        self.kernel.sdl.native_frame_w
    }

    pub fn guest_native_frame_height(&self) -> u32 {
        self.kernel.sdl.native_frame_h
    }

    pub fn guest_native_frames(&self) -> u64 {
        self.kernel.sdl.native_frames
    }

    /// FNV-1a/64 over `w|h|RGBA8` of the native-frame tap (same algorithm as frame_checksum).
    pub fn native_frame_checksum(&self) -> String {
        if self.kernel.sdl.native_frames == 0 || self.kernel.sdl.native_frame_rgba.is_empty() {
            return String::new();
        }
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |b: u8| {
            h ^= b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        };
        for b in self.kernel.sdl.native_frame_w.to_le_bytes() {
            mix(b);
        }
        for b in self.kernel.sdl.native_frame_h.to_le_bytes() {
            mix(b);
        }
        for &b in &self.kernel.sdl.native_frame_rgba {
            mix(b);
        }
        format!("fnv1a64:{h:016x}")
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
