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
use win32_hle::{HleAction, Win32Kernel};

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

        let (info, bindings) =
            load_pe64_image(bytes, vmm, jit, |dll: &str, symbol: &str, ordinal: u16| {
                // Deterministic per-import thunk in the HLE region; every import resolves to a
                // RET stub that the dispatcher recognises by RIP.
                let key_hash = thunk_hash(dll, symbol, ordinal);
                THUNK_BASE + 0x1000 + (key_hash % 4096) as u64 * THUNK_STRIDE
            })
            .map_err(|e| JsValue::from_str(&e))?;

        // Fill each bound thunk with RET and record the (dll,symbol) -> thunk mapping used by
        // the dispatcher.
        for b in &bindings {
            let thunk = THUNK_BASE + 0x1000 + (thunk_hash(&b.dll, &b.symbol, b.ordinal) % 4096) as u64 * THUNK_STRIDE;
            let _ = self.vmm.host_write_bytes(thunk, &[0xC3]);
            self.kernel
                .remember_import_thunk(thunk, &b.dll, &b.symbol, b.ordinal);
        }
        let _ = kernel_thunk_pool;

        // Entry state: Win64 startup stack with the return address pointing at the exit thunk.
        self.cpu = CpuState::new();
        self.cpu.gs_base = MAIN_TEB_ADDR;
        self.cpu.rip = info.entry_point;
        self.cpu.gpr[4] = MAIN_STACK_TOP - 0x100; // RSP
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
            bindings.len()
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
            if self.cpu.rip == UPCALL_RETURN_THUNK {
                if let Some((target, _)) = self.kernel.finish_upcall(&mut self.vmm) {
                    let rsp = self.cpu.gpr[4];
                    let _ = self.vmm.write_u64(rsp, UPCALL_RETURN_THUNK);
                    self.cpu.rip = target;
                    self.pending_upcall = true;
                    continue;
                }
                // The entry point returned: treat as process exit 0 unless already set.
                let code = self.kernel.exit_code.unwrap_or(0);
                self.status = RunStatus::ExitProcess(code);
                return format!("exit:{}", code);
            }

            let insn_rip = self.cpu.rip;

            // HLE thunk range?
            if insn_rip >= THUNK_BASE && insn_rip < THUNK_BASE + THUNK_REGION_SIZE {
                match self.kernel.lookup_import_thunk(insn_rip) {
                    Some((dll, symbol, ordinal)) => {
                        let args = self.capture_args();
                        let rsp = self.cpu.gpr[4];
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
                                self.cpu.gpr[4] = rsp + 8;
                                self.cpu.rip = ret;
                                self.cpu.instructions_executed =
                                    self.cpu.instructions_executed.wrapping_add(1);
                                executed += 1;
                                continue;
                            }
                            HleAction::Upcall { target, .. } => {
                                let ret_slot = rsp - 8;
                                let _ = self.vmm.write_u64(ret_slot, UPCALL_RETURN_THUNK);
                                self.cpu.gpr[4] = ret_slot;
                                self.cpu.rip = target;
                                self.pending_upcall = true;
                                continue;
                            }
                            HleAction::ExitProcess(code) => {
                                self.status = RunStatus::ExitProcess(code);
                                self.console.extend_from_slice(&self.kernel.drain_stdout());
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
                            self.cpu.gpr[4] = rsp + 8;
                            self.cpu.rip = ret;
                            executed += 1;
                            continue;
                        }
                        self.status = RunStatus::Fault;
                        self.fault_message = format!("unmapped thunk 0x{insn_rip:x}");
                        return format!("fault:{}", self.fault_message);
                    }
                }
            }

            match self.cpu.step_one(&mut self.vmm) {
                Ok(ExecOutcome::Next) | Ok(ExecOutcome::Branch(_)) => {
                    executed += 1;
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
                    return format!("fault:{}", self.fault_message);
                }
                Err(MemoryTrap::PageFault(addr)) => {
                    return format!("page-fault:{}", addr);
                }
                Err(MemoryTrap::AccessViolation(addr)) => {
                    self.status = RunStatus::Fault;
                    self.fault_message = format!("access violation at 0x{addr:x}");
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

fn thunk_hash(dll: &str, symbol: &str, ordinal: u16) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in dll
        .bytes()
        .chain(std::iter::once(b'!'))
        .chain(symbol.bytes())
        .chain(ordinal.to_le_bytes())
    {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
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
