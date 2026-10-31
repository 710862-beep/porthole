//! Basic-block x86-64 -> WebAssembly compiler.
//!
//! ABI v2 exports `run_block(ctx:i32)->i64`. The context is 32 i64 slots in the core's
//! exported memory: 0..15 GPRs, 16 status, 17 exit RIP, 18 executed instructions,
//! 19 RFLAGS, 20 instruction budget, 21 entry RIP. Registers and RFLAGS are Wasm locals
//! for the whole block; the context is read once and written on exit. A backward branch
//! to the block entry is lowered to a native Wasm loop so hot loops do not cross JS.
//! Static forward JMP edges can be linked with `return_call` when the host enables the
//! tail-call feature and the target artifact already exists. Unsupported instructions,
//! CALL, and page boundaries terminate the artifact and resume the interpreter at the
//! exact next RIP. Memory-writing instructions are deliberately not translated yet:
//! they terminate the block before their side effect, so SMC/page faults stay precise.

use std::collections::{HashMap, HashSet};
use iced_x86::{Decoder, DecoderOptions, FlowControl, Instruction, Mnemonic, OpKind, Register};

pub const JIT_ABI_V3: u32 = 3;
pub const JIT_COMPILER_VERSION: u64 = 4;
pub const JIT_CONTEXT_SLOTS: usize = 64;
pub const JIT_TLB_ENTRIES: usize = 16384;
pub const JIT_UNDO_CAP: usize = 65536;
pub const JIT_TOUCHED_CAP: usize = 65536;
pub const JIT_INVALID_HOST_PTR: u32 = 0xFFFF_F000;
pub const JIT_STATUS_OK: u64 = 0;
pub const JIT_STATUS_BUDGET: u64 = 1;
pub const JIT_STATUS_INTERPRET: u64 = 2;

#[derive(Debug, Clone)]
pub struct JitLink {
    pub target_rip: u64,
    pub page_epoch: u32,
    pub import_name: String,
}

#[derive(Debug, Clone)]
pub struct CompiledJitArtifact {
    pub entry_rip: u64,
    pub page_base: u64,
    pub page_epoch: u32,
    pub byte_len: u32,
    /// Static instructions in one pass. Self-loop artifacts execute a dynamic multiple.
    pub insn_count: u32,
    pub ends_with_ret: bool,
    pub has_stores: bool,
    pub has_simd: bool,
    pub self_loop: bool,
    /// True when a linked JMP/CALL makes the returned instruction count dynamic.
    pub dynamic_count: bool,
    pub code_hash: u64,
    /// RIP of the first unsupported instruction (BlockExit::Interpret), or 0.
    pub interpret_rip: u64,
    pub wasm_bytes: Vec<u8>,
    pub links: Vec<JitLink>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AluKind { Add, Or, And, Sub, Xor, Cmp, Test, Imul }

#[derive(Debug, Clone, Copy)]
pub struct MemAddr {
    pub base: Option<u8>,
    pub index: Option<u8>,
    pub scale: u8,
    pub disp: i64,
    /// Absolute RIP-relative target (already resolved at decode time).
    pub rip: Option<u64>,
    /// 0 = none, 0x64 = FS, 0x65 = GS.
    pub seg: u8,
}

#[derive(Debug, Clone, Copy)]
enum JitOp {
    Nop,
    MovImm { dst: u8, width: u8, imm: u64 },
    MovReg { dst: u8, src: u8, width: u8 },
    Alu { kind: AluKind, dst: u8, src: Option<u8>, imm: i64, width: u8 },
    Shift { kind: u8, dst: u8, count: u8, width: u8 },
    /// reg <- [mem] (MOV / MOVZX / MOVSX). extend: 0=none, 1=zero, 2=sign.
    Load { dst: u8, addr: MemAddr, width: u8, src_width: u8, extend: u8 },
    /// reg <- reg OP [mem] (read-only ALU; memory destination stores stay interpreted).
    AluLoad { kind: AluKind, dst: u8, addr: MemAddr, width: u8 },
    Lea { dst: u8, addr: MemAddr, width: u8 },
    Pop { dst: u8, width: u8 },
    Setcc { dst: u8, cc: u8 },
    MovExtend { dst: u8, src: u8, src_width: u8, dst_width: u8, signed: bool },
    Push { src: u8, width: u8 },
    PushImm { imm: u64, width: u8 },
    Store { src: u8, addr: MemAddr, width: u8 },
    StoreImm { imm: u64, addr: MemAddr, width: u8 },
    XmmLoad { dst: u8, addr: MemAddr },
    XmmStore { src: u8, addr: MemAddr },
    XmmReg { dst: u8, src: u8, zero_upper: bool },
    XmmAlu { kind: u8, dst: u8, src: u8 },
    XmmAluMem { kind: u8, dst: u8, addr: MemAddr },
    MovdToXmm { dst: u8, src: u8, width: u8 },
    MovdFromXmm { dst: u8, src: u8, width: u8 },
    IndirectTarget { src: Option<u8>, addr: Option<MemAddr> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockExit {
    Fallthrough,
    Jump,
    Branch { cc: u8 },
    Ret,
    Call { indirect: bool },
    Interpret,
}

#[derive(Debug, Clone)]
pub struct DecodedBlock {
    pub ops: Vec<JitOp>,
    pub byte_len: usize,
    pub insn_count: u32,
    pub exit: BlockExit,
    pub target: u64,
    pub ret_imm: u16,
}

pub struct HybridWasmJit {
    artifacts: HashMap<u64, CompiledJitArtifact>,
    pending_export_rips: Vec<u64>,
    pub modules_emitted: u64,
    pub cache_hits: u64,
    pub invalidations: u64,
    tail_calls: bool,
    proven: HashSet<u64>,
}

impl HybridWasmJit {
    pub fn new() -> Self {
        Self { artifacts: HashMap::new(), pending_export_rips: Vec::new(), modules_emitted: 0, cache_hits: 0, invalidations: 0, tail_calls: false, proven: HashSet::new() }
    }

    /// Host feature probe. Rust target-feature flags do not enable tail calls in the
    /// browser's validator; only emit return_call when the actual host accepts it.
    pub fn set_tail_calls(&mut self, on: bool) { self.tail_calls = on; }
    pub fn tail_calls(&self) -> bool { self.tail_calls }
    pub fn is_proven(&self, rip: u64) -> bool { self.proven.contains(&rip) }
    pub fn mark_proven(&mut self, rip: u64) { self.proven.insert(rip); }

    pub fn fnv1a_64(bytes: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for &b in bytes { h ^= b as u64; h = h.wrapping_mul(0x0100_0000_01b3); }
        h
    }

    pub fn get_valid_artifact(&mut self, rip: u64, current_page_epoch: u32) -> Option<&CompiledJitArtifact> {
        let stale = self.artifacts.get(&rip).map(|a| a.page_epoch != current_page_epoch).unwrap_or(false);
        if stale { self.invalidate_entry(rip); return None; }
        if self.artifacts.contains_key(&rip) { self.cache_hits += 1; }
        self.artifacts.get(&rip)
    }

    pub fn try_compile_block(&mut self, entry_rip: u64, page_epoch: u32, bytes: &[u8]) -> Option<CompiledJitArtifact> {
        let page_remain = 4096 - (entry_rip & 0xFFF) as usize;
        let window = &bytes[..bytes.len().min(page_remain)];
        let block = Self::decode_block(entry_rip, window)?;
        if block.insn_count == 0 { return None; }
        let self_loop = matches!(block.exit, BlockExit::Jump | BlockExit::Branch { .. }) && block.target == entry_rip;
        let mut links = Vec::new();
        if self.tail_calls && matches!(block.exit, BlockExit::Jump | BlockExit::Call { indirect: false }) && !self_loop {
            if let Some(target) = self.artifacts.get(&block.target) {
                // Do not create cross-module cycles; self-loops are already native loops.
                let cyclic = target.links.iter().any(|l| l.target_rip == entry_rip) || target.entry_rip == entry_rip;
                if !cyclic {
                    links.push(JitLink { target_rip: block.target, page_epoch: target.page_epoch, import_name: format!("b{:016x}", block.target) });
                }
            }
        }
        let has_stores = Self::has_stores(&block);
        let has_simd = block.ops.iter().any(|op| matches!(op, JitOp::XmmLoad { .. } | JitOp::XmmStore { .. } | JitOp::XmmReg { .. } | JitOp::XmmAlu { .. } | JitOp::XmmAluMem { .. } | JitOp::MovdToXmm { .. } | JitOp::MovdFromXmm { .. }));
        let wasm_bytes = Self::emit_wasm_module(entry_rip, &block, &links);
        // The module embeds absolute entry/target RIPs. Hashing only the x86 bytes made
        // identical byte sequences at different RIPs collide in the host module/instance
        // maps, so a block could execute another block's constants (Doom: 34k validation
        // fallbacks with wrong exit RIPs). Include entry RIP + compiler version.
        let mut hash_input = entry_rip.to_le_bytes().to_vec();
        hash_input.extend_from_slice(&JIT_COMPILER_VERSION.to_le_bytes());
        hash_input.extend_from_slice(&window[..block.byte_len]);
        let code_hash = Self::fnv1a_64(&hash_input);
        let interpret_rip = if block.exit == BlockExit::Interpret { block.target } else { 0 };
        let artifact = CompiledJitArtifact {
            entry_rip, page_base: entry_rip & !0xFFF, page_epoch,
            byte_len: block.byte_len as u32, insn_count: block.insn_count,
            interpret_rip, ends_with_ret: block.exit == BlockExit::Ret, has_stores, has_simd, self_loop, dynamic_count: !links.is_empty(), code_hash, wasm_bytes, links,
        };
        self.artifacts.insert(entry_rip, artifact.clone());
        self.pending_export_rips.push(entry_rip);
        self.modules_emitted += 1;
        Some(artifact)
    }

    /// OPFS is untrusted: accept only the exact portable module the current compiler emits.
    pub fn validate_cached_artifact(entry_rip: u64, _page_epoch: u32, byte_len: u32, insn_count: u32, ends_with_ret: bool, has_stores: bool, has_simd: bool, self_loop: bool, code_hash: u64, live: &[u8], wasm: &[u8]) -> bool {
        let mut hash_input = entry_rip.to_le_bytes().to_vec();
        hash_input.extend_from_slice(&JIT_COMPILER_VERSION.to_le_bytes());
        hash_input.extend_from_slice(live);
        if live.len() != byte_len as usize || Self::fnv1a_64(&hash_input) != code_hash { return false; }
        let Some(block) = Self::decode_block(entry_rip, live) else { return false; };
        if block.byte_len != byte_len as usize || block.insn_count != insn_count || (block.exit == BlockExit::Ret) != ends_with_ret { return false; }
        if block.byte_len > 4096 - (entry_rip & 0xFFF) as usize { return false; }
        let dec_stores = Self::has_stores(&block);
        let dec_simd = block.ops.iter().any(|op| matches!(op, JitOp::XmmLoad { .. } | JitOp::XmmStore { .. } | JitOp::XmmReg { .. } | JitOp::XmmAlu { .. } | JitOp::XmmAluMem { .. } | JitOp::MovdToXmm { .. } | JitOp::MovdFromXmm { .. }));
        let dec_self_loop = matches!(block.exit, BlockExit::Jump | BlockExit::Branch { .. }) && block.target == entry_rip;
        if dec_stores != has_stores || dec_simd != has_simd || dec_self_loop != self_loop { return false; }
        Self::emit_wasm_module(entry_rip, &block, &[]).as_slice() == wasm
    }

    pub fn import_cached_artifact(&mut self, entry_rip: u64, page_epoch: u32, byte_len: u32, insn_count: u32, ends_with_ret: bool, has_stores: bool, has_simd: bool, self_loop: bool, code_hash: u64, wasm_bytes: Vec<u8>) -> bool {
        if wasm_bytes.len() < 8 || &wasm_bytes[0..8] != b"\0asm\x01\0\0\0" { return false; }
        self.artifacts.insert(entry_rip, CompiledJitArtifact { entry_rip, page_base: entry_rip & !0xFFF, page_epoch, byte_len, insn_count, ends_with_ret, self_loop, dynamic_count: false, code_hash, interpret_rip: 0, has_stores, has_simd, wasm_bytes, links: Vec::new() });
        true
    }

    pub fn drain_pending_exports(&mut self) -> Vec<CompiledJitArtifact> {
        let rips = std::mem::take(&mut self.pending_export_rips);
        rips.iter().filter_map(|rip| self.artifacts.get(rip).cloned()).collect()
    }
    pub fn pending_count(&self) -> usize { self.pending_export_rips.len() }
    pub fn pending_meta(&self, index: usize) -> Option<String> {
        let rip = *self.pending_export_rips.get(index)?;
        let a = self.artifacts.get(&rip)?;
        Some(Self::meta_json(a, 0))
    }
    pub fn meta_json(a: &CompiledJitArtifact, ctx: u32) -> String {
        let links: Vec<String> = a.links.iter().map(|l| format!("{{\"targetRip\":\"{}\",\"pageEpoch\":{},\"importName\":\"{}\"}}", l.target_rip, l.page_epoch, l.import_name)).collect();
        format!("{{\"abi\":{},\"entryRip\":\"{}\",\"pageEpoch\":{},\"byteLen\":{},\"insnCount\":{},\"endsWithRet\":{},\"hasStores\":{},\"hasSimd\":{},\"selfLoop\":{},\"interpretRip\":\"{}\",\"codeHash\":\"{:016x}\",\"ctx\":{},\"links\":[{}]}}",
            JIT_ABI_V3, a.entry_rip, a.page_epoch, a.byte_len, a.insn_count, a.ends_with_ret, a.has_stores, a.has_simd, a.self_loop, a.interpret_rip, a.code_hash, ctx, links.join(","))
    }
    pub fn pending_wasm(&self, index: usize) -> Option<Vec<u8>> {
        let rip = *self.pending_export_rips.get(index)?;
        self.artifacts.get(&rip).map(|a| a.wasm_bytes.clone())
    }
    pub fn clear_pending(&mut self) { self.pending_export_rips.clear(); }
    pub fn invalidate_entry(&mut self, rip: u64) {
        if self.artifacts.remove(&rip).is_some() { self.invalidations += 1; }
        self.proven.remove(&rip);
        // A linked predecessor is only as valid as its successor epoch.
        let dependents: Vec<u64> = self.artifacts.iter().filter(|(_, a)| a.links.iter().any(|l| l.target_rip == rip)).map(|(k, _)| *k).collect();
        for dep in dependents { self.invalidate_entry(dep); }
    }
    pub fn artifact_count(&self) -> usize { self.artifacts.len() }
    pub fn artifact(&self, rip: u64) -> Option<&CompiledJitArtifact> { self.artifacts.get(&rip) }

    // ---------------------------------------------------------------- decoder

    fn gpr_index(reg: Register) -> Option<u8> {
        if !reg.is_gpr() { return None; }
        let n = reg.number();
        if reg.size() == 1 {
            // iced numbers the legacy high bytes AH/CH/DH/BH as 4..7; the REX low
            // bytes SPL/BPL/SIL/DIL/R8L..R15L therefore start at 8. Map them back
            // to architectural ModRM register indexes 4..15.
            if n < 4 { Some(n as u8) }
            else if (8..20).contains(&n) { Some((n - 4) as u8) }
            else { None }
        } else {
            Some(n as u8)
        }
    }

    fn reg_width(reg: Register) -> u8 { reg.size() as u8 }

    fn xmm_index(reg: Register) -> Option<u8> {
        use Register::*;
        Some(match reg {
            XMM0 => 0, XMM1 => 1, XMM2 => 2, XMM3 => 3, XMM4 => 4, XMM5 => 5, XMM6 => 6, XMM7 => 7,
            XMM8 => 8, XMM9 => 9, XMM10 => 10, XMM11 => 11, XMM12 => 12, XMM13 => 13, XMM14 => 14, XMM15 => 15,
            _ => return Option::None,
        })
    }

    fn xmm_alu_kind(m: Mnemonic) -> Option<u8> {
        Some(match m {
            Mnemonic::Pxor => 0, Mnemonic::Pand => 1, Mnemonic::Por => 2,
            Mnemonic::Paddd => 3, Mnemonic::Psubd => 4, Mnemonic::Pmulld => 5,
            Mnemonic::Paddq => 6, Mnemonic::Psubq => 7,
            Mnemonic::Paddb => 9, Mnemonic::Psubb => 10,
            Mnemonic::Paddw => 11, Mnemonic::Psubw => 12, Mnemonic::Pmullw => 13,
            _ => return None,
        })
    }

    fn has_stores(block: &DecodedBlock) -> bool {
        block.ops.iter().any(|op| matches!(op, JitOp::Store { .. } | JitOp::StoreImm { .. } | JitOp::Push { .. } | JitOp::PushImm { .. } | JitOp::XmmStore { .. }))
            || matches!(block.exit, BlockExit::Call { .. })
    }

    fn mem_addr(ins: &Instruction) -> Option<MemAddr> {
        let base = if ins.is_ip_rel_memory_operand() { None } else { Self::gpr_index(ins.memory_base()) };
        let index = Self::gpr_index(ins.memory_index());
        let seg = match ins.memory_segment() { Register::FS => 0x64, Register::GS => 0x65, _ => 0 };
        let disp = ins.memory_displacement64() as i64;
        // iced-x86 already folds RIP into memory_displacement64 for IP-relative operands.
        let rip = if ins.is_ip_rel_memory_operand() { Some(disp as u64) } else { None };
        if !ins.is_ip_rel_memory_operand() && ins.memory_base() != Register::None && base.is_none() { return None; }
        if ins.memory_index() != Register::None && index.is_none() { return None; }
        // The native EA builder works on full 64-bit base/index registers. 32-bit
        // address-size overrides (0x67) need zero-extension semantics; fall back.
        if ins.memory_base() != Register::None && ins.memory_base().size() != 8 { return None; }
        if ins.memory_index() != Register::None && ins.memory_index().size() != 8 { return None; }
        Some(MemAddr { base, index, scale: ins.memory_index_scale() as u8, disp, rip, seg })
    }

    fn imm_value(ins: &Instruction, op: u32) -> i64 {
        match ins.op_kind(op) {
            OpKind::Immediate8 => ins.immediate8() as i8 as i64,
            OpKind::Immediate16 => ins.immediate16() as i16 as i64,
            OpKind::Immediate32 => ins.immediate32() as i32 as i64,
            OpKind::Immediate64 => ins.immediate64() as i64,
            OpKind::Immediate8to16 => ins.immediate8to16() as i64,
            OpKind::Immediate8to32 => ins.immediate8to32() as i64,
            OpKind::Immediate8to64 => ins.immediate8to64(),
            OpKind::Immediate32to64 => ins.immediate32to64(),
            _ => 0,
        }
    }

    fn alu_kind(m: Mnemonic) -> Option<AluKind> {
        match m {
            Mnemonic::Add => Some(AluKind::Add), Mnemonic::Or => Some(AluKind::Or),
            Mnemonic::And => Some(AluKind::And), Mnemonic::Sub => Some(AluKind::Sub),
            Mnemonic::Xor => Some(AluKind::Xor), Mnemonic::Cmp => Some(AluKind::Cmp),
            Mnemonic::Test => Some(AluKind::Test), _ => None,
        }
    }

    fn cc(m: Mnemonic) -> Option<u8> {
        use Mnemonic::*;
        Some(match m {
            Jo => 0, Jno => 1, Jb => 2, Jae => 3, Je => 4, Jne => 5, Jbe => 6, Ja => 7,
            Js => 8, Jns => 9, Jp => 10, Jnp => 11, Jl => 12, Jge => 13, Jle => 14, Jg => 15,
            Seto => 0, Setno => 1, Setb => 2, Setae => 3, Sete => 4, Setne => 5, Setbe => 6, Seta => 7,
            Sets => 8, Setns => 9, Setp => 10, Setnp => 11, Setl => 12, Setge => 13, Setle => 14, Setg => 15,
            _ => return None,
        })
    }

    /// Decode a basic block with iced-x86 (correct ModRM/SIB/RIP-relative/segment parsing)
    /// and lower the supported integer + memory-load subset. Stores, CALL, indirect jumps
    /// and SIMD terminate the block *before* their side effect; the interpreter executes
    /// exactly that RIP. This is the same decoder used by the AOT `.text` scanner.
    pub fn decode_block(entry_rip: u64, bytes: &[u8]) -> Option<DecodedBlock> {
        let mut decoder = Decoder::try_new(64, bytes, DecoderOptions::NONE).ok()?;
        decoder.set_ip(entry_rip);
        let mut ops = Vec::new();
        let mut insns = 0u32;
        let mut exit = BlockExit::Fallthrough;
        let mut target = entry_rip;
        let mut byte_len = 0usize;
        let mut ret_imm = 0u16;
        while (decoder.position() as usize) < bytes.len() && insns < 256 {
            let ins = decoder.decode();
            let offset = (ins.ip().wrapping_sub(entry_rip)) as usize;
            if ins.is_invalid() {
                exit = BlockExit::Interpret; target = ins.ip(); byte_len = offset; break;
            }
            let m = ins.mnemonic();
            let mut supported = true;
            match m {
                Mnemonic::Nop => { ops.push(JitOp::Nop); }
                Mnemonic::Mov => {
                    let dst = ins.op0_register();
                    let width = Self::reg_width(dst);
                    if ins.op_kind(0) == OpKind::Memory {
                        let addr = Self::mem_addr(&ins);
                        let w = ins.memory_size().size() as u8;
                        match (addr, ins.op_kind(1)) {
                            (Some(addr), OpKind::Register) => if let Some(s) = Self::gpr_index(ins.op1_register()) { ops.push(JitOp::Store { src: s, addr, width: w }); } else { supported = false; },
                            (Some(addr), OpKind::Immediate8 | OpKind::Immediate16 | OpKind::Immediate32 | OpKind::Immediate64) => ops.push(JitOp::StoreImm { imm: Self::imm_value(&ins, 1) as u64, addr, width: w }),
                            _ => supported = false,
                        }
                        if supported { insns += 1; byte_len = offset + ins.len(); target = ins.next_ip(); continue; }
                        supported = true;
                    }
                    match ins.op_kind(1) {
                        OpKind::Register => {
                            let src = Self::gpr_index(ins.op1_register());
                            let d = Self::gpr_index(dst);
                            match (d, src) { (Some(d), Some(s)) => ops.push(JitOp::MovReg { dst: d, src: s, width }), _ => supported = false }
                        }
                        OpKind::Immediate8 | OpKind::Immediate16 | OpKind::Immediate32 | OpKind::Immediate64 => {
                            if let Some(d) = Self::gpr_index(dst) { ops.push(JitOp::MovImm { dst: d, width, imm: Self::imm_value(&ins, 1) as u64 }); } else { supported = false; }
                        }
                        OpKind::Memory => {
                            if let (Some(d), Some(addr)) = (Self::gpr_index(dst), Self::mem_addr(&ins)) {
                                ops.push(JitOp::Load { dst: d, addr, width, src_width: width, extend: 0 });
                            } else { supported = false; }
                        }
                        _ => supported = false,
                    }
                }
                Mnemonic::Movzx | Mnemonic::Movsx | Mnemonic::Movsxd => {
                    let dst = ins.op0_register();
                    let d = Self::gpr_index(dst);
                    let dst_width = Self::reg_width(dst);
                    let src_width = match ins.op_kind(1) {
                        OpKind::Register => Self::reg_width(ins.op1_register()),
                        OpKind::Memory => ins.memory_size().size() as u8,
                        _ => 0,
                    };
                    let extend = if m == Mnemonic::Movzx { 1 } else { 2 };
                    let addr = if ins.op_kind(1) == OpKind::Memory { Self::mem_addr(&ins) } else { None };
                    match (d, ins.op_kind(1)) {
                        (Some(d), OpKind::Memory) => if let Some(addr) = addr { ops.push(JitOp::Load { dst: d, addr, width: dst_width, src_width, extend }); } else { supported = false; },
                        (Some(d), OpKind::Register) => if let Some(s) = Self::gpr_index(ins.op1_register()) {
                            ops.push(JitOp::MovExtend { dst: d, src: s, src_width, dst_width, signed: extend == 2 });
                        } else { supported = false; },
                        _ => supported = false,
                    }
                }
                Mnemonic::Lea => {
                    let d = Self::gpr_index(ins.op0_register());
                    let width = Self::reg_width(ins.op0_register());
                    match (d, Self::mem_addr(&ins)) { (Some(d), Some(addr)) => ops.push(JitOp::Lea { dst: d, addr, width }), _ => supported = false }
                }
                Mnemonic::Push => {
                    match ins.op_kind(0) {
                        OpKind::Register => if let Some(s) = Self::gpr_index(ins.op0_register()) { ops.push(JitOp::Push { src: s, width: Self::reg_width(ins.op0_register()) }); } else { supported = false; },
                        OpKind::Immediate8 | OpKind::Immediate16 | OpKind::Immediate32 | OpKind::Immediate64 | OpKind::Immediate8to16 | OpKind::Immediate8to32 | OpKind::Immediate8to64 | OpKind::Immediate32to64 => ops.push(JitOp::PushImm { imm: Self::imm_value(&ins, 0) as u64, width: if ins.op_kind(0) == OpKind::Immediate16 { 2 } else { 8 } }),
                        _ => supported = false,
                    }
                }
                Mnemonic::Pop => {
                    if let Some(d) = Self::gpr_index(ins.op0_register()) { ops.push(JitOp::Pop { dst: d, width: Self::reg_width(ins.op0_register()) }); } else { supported = false; }
                }
                Mnemonic::Add | Mnemonic::Or | Mnemonic::And | Mnemonic::Sub | Mnemonic::Xor | Mnemonic::Cmp | Mnemonic::Test => {
                    let kind = Self::alu_kind(m).unwrap();
                    if ins.op_kind(0) == OpKind::Memory && !matches!(kind, AluKind::Cmp | AluKind::Test) {
                        // Memory-destination ALU is a read-modify-write store; leave to interpreter for now.
                        supported = false;
                    } else {
                    let dst = ins.op0_register();
                    let d = Self::gpr_index(dst);
                    let width = Self::reg_width(dst);
                    match ins.op_kind(1) {
                        OpKind::Register => match (d, Self::gpr_index(ins.op1_register())) {
                            (Some(d), Some(s)) => ops.push(JitOp::Alu { kind, dst: d, src: Some(s), imm: 0, width }), _ => supported = false,
                        },
                        OpKind::Immediate8 | OpKind::Immediate16 | OpKind::Immediate32 | OpKind::Immediate8to16 | OpKind::Immediate8to32 | OpKind::Immediate8to64 | OpKind::Immediate32to64 => {
                            if let Some(d) = d { ops.push(JitOp::Alu { kind, dst: d, src: None, imm: Self::imm_value(&ins, 1), width }); } else { supported = false; }
                        }
                        OpKind::Memory => match (d, Self::mem_addr(&ins)) {
                            (Some(d), Some(addr)) => ops.push(JitOp::AluLoad { kind, dst: d, addr, width }), _ => supported = false,
                        },
                        _ => supported = false,
                    }
                    }
                }
                Mnemonic::Shl | Mnemonic::Shr | Mnemonic::Sar => {
                    let d = Self::gpr_index(ins.op0_register());
                    let width = Self::reg_width(ins.op0_register());
                    let kind = match m { Mnemonic::Shl => 4, Mnemonic::Shr => 5, _ => 7 };
                    let count = match ins.op_kind(1) {
                        OpKind::Immediate8 => ins.immediate8() & if width == 8 { 63 } else { 31 },
                        _ => 255,
                    };
                    if ins.op_kind(0) == OpKind::Memory { supported = false; }
                    else if let Some(d) = d {
                        if count == 0 || count == 255 { supported = false; }
                        else { ops.push(JitOp::Shift { kind, dst: d, count, width }); }
                    } else { supported = false; }
                }
                Mnemonic::Seto | Mnemonic::Setno | Mnemonic::Setb | Mnemonic::Setae | Mnemonic::Sete | Mnemonic::Setne | Mnemonic::Setbe | Mnemonic::Seta |
                Mnemonic::Sets | Mnemonic::Setns | Mnemonic::Setp | Mnemonic::Setnp | Mnemonic::Setl | Mnemonic::Setge | Mnemonic::Setle | Mnemonic::Setg => {
                    if ins.op_kind(0) == OpKind::Register {
                        if let (Some(d), Some(cc)) = (Self::gpr_index(ins.op0_register()), Self::cc(m)) { ops.push(JitOp::Setcc { dst: d, cc }); } else { supported = false; }
                    } else { supported = false; }
                }
                Mnemonic::Ret => { insns += 1; byte_len = offset + ins.len(); exit = BlockExit::Ret; target = 0; ret_imm = if ins.op_kind(0) == OpKind::Immediate16 { ins.immediate16() } else { 0 }; break; }
                Mnemonic::Call => {
                    insns += 1; byte_len = offset + ins.len(); target = ins.next_ip();
                    match ins.op_kind(0) {
                        OpKind::NearBranch16 | OpKind::NearBranch32 | OpKind::NearBranch64 => { exit = BlockExit::Call { indirect: false }; target = ins.near_branch_target(); }
                        OpKind::Register => if let Some(sr) = Self::gpr_index(ins.op0_register()) { ops.push(JitOp::IndirectTarget { src: Some(sr), addr: None }); exit = BlockExit::Call { indirect: true }; } else { supported = false; },
                        OpKind::Memory => if let Some(addr) = Self::mem_addr(&ins) { ops.push(JitOp::IndirectTarget { src: None, addr: Some(addr) }); exit = BlockExit::Call { indirect: true }; } else { supported = false; },
                        _ => supported = false,
                    }
                    if supported { break; }
                    insns -= 1; byte_len = offset; supported = true;
                }
                Mnemonic::Movdqa | Mnemonic::Movdqu | Mnemonic::Movaps | Mnemonic::Movups => {
                    match (ins.op_kind(0), ins.op_kind(1)) {
                        (OpKind::Register, OpKind::Register) => match (Self::xmm_index(ins.op0_register()), Self::xmm_index(ins.op1_register())) { (Some(d), Some(sr)) => ops.push(JitOp::XmmReg { dst: d, src: sr, zero_upper: false }), _ => supported = false },
                        (OpKind::Register, OpKind::Memory) => match (Self::xmm_index(ins.op0_register()), Self::mem_addr(&ins)) { (Some(d), Some(addr)) => ops.push(JitOp::XmmLoad { dst: d, addr }), _ => supported = false },
                        (OpKind::Memory, OpKind::Register) => match (Self::mem_addr(&ins), Self::xmm_index(ins.op1_register())) { (Some(addr), Some(sr)) => ops.push(JitOp::XmmStore { src: sr, addr }), _ => supported = false },
                        _ => supported = false,
                    }
                }
                Mnemonic::Movd | Mnemonic::Movq => {
                    let d0 = Self::xmm_index(ins.op0_register());
                    let s0 = Self::xmm_index(ins.op1_register());
                    let g0 = Self::gpr_index(ins.op0_register());
                    let g1 = Self::gpr_index(ins.op1_register());
                    let w = if m == Mnemonic::Movd { 4 } else { 8 };
                    match (d0, g1, g0, s0) {
                        (Some(d), Some(sr), _, _) => ops.push(JitOp::MovdToXmm { dst: d, src: sr, width: w }),
                        (_, _, Some(d), Some(sr)) => ops.push(JitOp::MovdFromXmm { dst: d, src: sr, width: w }),
                        _ => supported = false,
                    }
                }
                m if Self::xmm_alu_kind(m).is_some() => {
                    let kind = Self::xmm_alu_kind(m).unwrap();
                    let d = Self::xmm_index(ins.op0_register());
                    match (d, ins.op_kind(1)) {
                        (Some(d), OpKind::Register) => if let Some(sr) = Self::xmm_index(ins.op1_register()) { ops.push(JitOp::XmmAlu { kind, dst: d, src: sr }); } else { supported = false; },
                        (Some(d), OpKind::Memory) => if let Some(addr) = Self::mem_addr(&ins) { ops.push(JitOp::XmmAluMem { kind, dst: d, addr }); } else { supported = false; },
                        _ => supported = false,
                    }
                }
                Mnemonic::Jmp => {
                    if matches!(ins.op_kind(0), OpKind::NearBranch16 | OpKind::NearBranch32 | OpKind::NearBranch64) {
                        insns += 1; byte_len = offset + ins.len(); exit = BlockExit::Jump; target = ins.near_branch_target(); break;
                    } else { supported = false; }
                }
                Mnemonic::Jo | Mnemonic::Jno | Mnemonic::Jb | Mnemonic::Jae | Mnemonic::Je | Mnemonic::Jne | Mnemonic::Jbe | Mnemonic::Ja |
                Mnemonic::Js | Mnemonic::Jns | Mnemonic::Jp | Mnemonic::Jnp | Mnemonic::Jl | Mnemonic::Jge | Mnemonic::Jle | Mnemonic::Jg => {
                    insns += 1; byte_len = offset + ins.len(); exit = BlockExit::Branch { cc: Self::cc(m).unwrap() }; target = ins.near_branch_target(); break;
                }
                _ => supported = false,
            }
            if !supported {
                exit = BlockExit::Interpret; target = ins.ip(); byte_len = offset; break;
            }
            insns += 1;
            byte_len = offset + ins.len();
            target = ins.next_ip();
            if ins.flow_control() != FlowControl::Next {
                // CALL/indirect/INT/etc: stop before the instruction so HLE/faults stay precise.
                if !matches!(exit, BlockExit::Ret | BlockExit::Jump | BlockExit::Branch { .. } | BlockExit::Call { .. }) {
                    exit = BlockExit::Interpret; target = ins.ip(); byte_len = offset; insns -= 1; ops.pop();
                }
                break;
            }
        }
        if insns == 0 { return None; }
        if exit == BlockExit::Fallthrough { target = entry_rip.wrapping_add(byte_len as u64); }
        Some(DecodedBlock { ops, byte_len, insn_count: insns, exit, target, ret_imm })
    }

    // ---------------------------------------------------------------- emitter
    fn push_u32_leb(out: &mut Vec<u8>, mut val: u32) { loop { let mut b = (val & 0x7F) as u8; val >>= 7; if val != 0 { b |= 0x80; } out.push(b); if val == 0 { break; } } }
    fn push_i64_sleb(out: &mut Vec<u8>, mut val: i64) { loop { let b = (val & 0x7F) as u8; val >>= 7; let done = (val == 0 && (b & 0x40) == 0) || (val == -1 && (b & 0x40) != 0); if done { out.push(b); break; } out.push(b | 0x80); } }
    fn push_section(wasm: &mut Vec<u8>, id: u8, payload: &[u8]) { wasm.push(id); Self::push_u32_leb(wasm, payload.len() as u32); wasm.extend_from_slice(payload); }
    fn local_get(b: &mut Vec<u8>, i: u8) { b.extend_from_slice(&[0x20, i]); }
    fn local_set(b: &mut Vec<u8>, i: u8) { b.extend_from_slice(&[0x21, i]); }
    fn local_tee(b: &mut Vec<u8>, i: u8) { b.extend_from_slice(&[0x22, i]); }
    fn i64_const(b: &mut Vec<u8>, v: i64) { b.push(0x42); Self::push_i64_sleb(b, v); }
    fn i32_const(b: &mut Vec<u8>, v: i32) { b.push(0x41); Self::push_i64_sleb(b, v as i64); }
    fn ctx_load(b: &mut Vec<u8>, slot: u32) { b.extend_from_slice(&[0x20, 0x00, 0x29, 0x03]); Self::push_u32_leb(b, slot * 8); }
    fn ctx_store_local(b: &mut Vec<u8>, slot: u32, local: u8) { b.extend_from_slice(&[0x20, 0x00]); Self::local_get(b, local); b.extend_from_slice(&[0x37, 0x03]); Self::push_u32_leb(b, slot * 8); }
    fn ctx_store_const(b: &mut Vec<u8>, slot: u32, v: i64) { b.extend_from_slice(&[0x20, 0x00]); Self::i64_const(b, v); b.extend_from_slice(&[0x37, 0x03]); Self::push_u32_leb(b, slot * 8); }

    fn width_mask(width: u8) -> i64 {
        match width { 1 => 0xFF, 2 => 0xFFFF, 4 => 0xFFFF_FFFF, _ => -1 }
    }
    fn mask_width(b: &mut Vec<u8>, width: u8) {
        if width != 8 { Self::i64_const(b, Self::width_mask(width)); b.push(0x83); }
    }
    /// Write a value local into a GPR local with x86 partial-register semantics:
    /// 8/16-bit writes preserve upper bits; 32-bit writes zero-extend; 64-bit is full.
    fn write_reg(b: &mut Vec<u8>, dst: u8, width: u8, value: u8) {
        match width {
            8 => { Self::local_get(b, value); Self::local_set(b, dst + 1); }
            4 => { Self::local_get(b, value); Self::mask_width(b, 4); Self::local_set(b, dst + 1); }
            _ => {
                Self::local_get(b, dst + 1); Self::i64_const(b, !Self::width_mask(width)); b.push(0x83);
                Self::local_get(b, value); Self::mask_width(b, width); b.push(0x84);
                Self::local_set(b, dst + 1);
            }
        }
    }

    fn reg_masks(ops: &[JitOp]) -> (u16, u16) {
        let mut rd = 0u16; let mut wr = 0u16;
        let addr_regs = |a: &MemAddr, rd: &mut u16| { if let Some(b) = a.base { *rd |= 1 << b; } if let Some(i) = a.index { *rd |= 1 << i; } };
        for op in ops { match *op {
            JitOp::Nop => {}
            JitOp::MovImm { dst, .. } => wr |= 1 << dst,
            JitOp::MovReg { dst, src, .. } => { rd |= 1 << src; wr |= 1 << dst; }
            JitOp::Alu { kind, dst, src, .. } => { rd |= 1 << dst; if let Some(s) = src { rd |= 1 << s; } if !matches!(kind, AluKind::Cmp | AluKind::Test) { wr |= 1 << dst; } }
            JitOp::Shift { dst, .. } => { rd |= 1 << dst; wr |= 1 << dst; }
            JitOp::Load { dst, addr, .. } => { addr_regs(&addr, &mut rd); wr |= 1 << dst; }
            JitOp::AluLoad { kind, dst, addr, .. } => { addr_regs(&addr, &mut rd); rd |= 1 << dst; if !matches!(kind, AluKind::Cmp | AluKind::Test) { wr |= 1 << dst; } }
            JitOp::Lea { dst, addr, .. } => { addr_regs(&addr, &mut rd); wr |= 1 << dst; }
            JitOp::Pop { dst, .. } => { rd |= 1 << 4; wr |= (1 << dst) | (1 << 4); }
            JitOp::Setcc { dst, .. } => wr |= 1 << dst,
            JitOp::MovExtend { dst, src, .. } => { rd |= 1 << src; wr |= 1 << dst; }
            JitOp::Push { src, .. } => { rd |= (1 << src) | (1 << 4); wr |= 1 << 4; }
            JitOp::PushImm { .. } => { rd |= 1 << 4; wr |= 1 << 4; }
            JitOp::Store { src, addr, .. } => { rd |= 1 << src; addr_regs(&addr, &mut rd); }
            JitOp::StoreImm { addr, .. } => { addr_regs(&addr, &mut rd); }
            JitOp::XmmLoad { addr, .. } => { addr_regs(&addr, &mut rd); }
            JitOp::XmmStore { addr, .. } => { addr_regs(&addr, &mut rd); }
            JitOp::XmmReg { .. } => {}
            JitOp::XmmAlu { .. } => {}
            JitOp::XmmAluMem { addr, .. } => { addr_regs(&addr, &mut rd); }
            JitOp::MovdToXmm { src, .. } => { rd |= 1 << src; }
            JitOp::MovdFromXmm { dst, .. } => { wr |= 1 << dst; }
            JitOp::IndirectTarget { src, addr } => { if let Some(sr) = src { rd |= 1 << sr; } if let Some(a) = addr { addr_regs(&a, &mut rd); } }
        }}
        (rd | wr, wr)
    }

    fn xmm_masks(ops: &[JitOp]) -> (u16, u16) {
        let mut rd = 0u16; let mut wr = 0u16;
        for op in ops { match *op {
            JitOp::XmmLoad { dst, .. } => wr |= 1 << dst,
            JitOp::XmmStore { src, .. } => rd |= 1 << src,
            JitOp::XmmReg { dst, src, .. } => { rd |= 1 << src; wr |= 1 << dst; }
            JitOp::XmmAlu { dst, src, .. } => { rd |= (1 << dst) | (1 << src); wr |= 1 << dst; }
            JitOp::XmmAluMem { dst, .. } => { rd |= 1 << dst; wr |= 1 << dst; }
            JitOp::MovdToXmm { dst, .. } => wr |= 1 << dst,
            JitOp::MovdFromXmm { src, .. } => rd |= 1 << src,
            _ => {}
        }}
        (rd | wr, wr)
    }

    fn uses_memory(ops: &[JitOp], exit: BlockExit) -> bool {
        ops.iter().any(|op| matches!(op, JitOp::Load { .. } | JitOp::AluLoad { .. } | JitOp::Pop { .. } | JitOp::Store { .. } | JitOp::StoreImm { .. } | JitOp::Push { .. } | JitOp::PushImm { .. } | JitOp::XmmLoad { .. } | JitOp::XmmStore { .. } | JitOp::XmmAluMem { .. } | JitOp::IndirectTarget { addr: Some(_), .. }))
            || matches!(exit, BlockExit::Ret | BlockExit::Call { .. })
    }

    fn or_flag(b: &mut Vec<u8>, mask: i64) {
        b.push(0xAD); Self::i64_const(b, mask); b.push(0x7E);
        Self::local_get(b, 17); b.push(0x84); Self::local_set(b, 17);
    }

    fn emit_szp(b: &mut Vec<u8>, width: u8) {
        Self::local_get(b, 17); Self::i64_const(b, !0xC4i64); b.push(0x83); Self::local_set(b, 17);
        Self::local_get(b, 20); b.push(0x50); Self::or_flag(b, 0x40);
        Self::local_get(b, 20); Self::i64_const(b, 1i64 << (width * 8 - 1)); b.push(0x83); Self::i64_const(b, 0); b.push(0x52); Self::or_flag(b, 0x80);
        Self::local_get(b, 20); Self::local_get(b, 20); Self::i64_const(b, 4); b.push(0x88); b.push(0x85); Self::local_set(b, 21);
        Self::local_get(b, 21); Self::local_get(b, 21); Self::i64_const(b, 2); b.push(0x88); b.push(0x85); Self::local_set(b, 21);
        Self::local_get(b, 21); Self::local_get(b, 21); Self::i64_const(b, 1); b.push(0x88); b.push(0x85); Self::i64_const(b, 1); b.push(0x83); b.push(0x50); Self::or_flag(b, 4);
    }

    /// ALU with lhs in local18, rhs in local19, result -> local20, flags updated.
    fn emit_alu_core(b: &mut Vec<u8>, kind: AluKind, dst: u8, width: u8) {
        match kind {
            AluKind::Add => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x7C); }
            AluKind::Sub | AluKind::Cmp => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x7D); }
            AluKind::And | AluKind::Test => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x83); }
            AluKind::Or => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x84); }
            AluKind::Xor => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x85); }
            AluKind::Imul => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x7E); }
        }
        Self::mask_width(b, width); Self::local_set(b, 20);
        if !matches!(kind, AluKind::Cmp | AluKind::Test) { Self::write_reg(b, dst, width, 20); }
        Self::local_get(b, 17); Self::i64_const(b, !0x811i64); b.push(0x83); Self::local_set(b, 17);
        match kind {
            AluKind::Add => {
                Self::local_get(b, 20); Self::local_get(b, 18); b.push(0x54); Self::or_flag(b, 1);
                Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x85); Self::i64_const(b, -1); b.push(0x85);
                Self::local_get(b, 18); Self::local_get(b, 20); b.push(0x85); b.push(0x83); Self::i64_const(b, 1i64 << (width*8-1)); b.push(0x83); Self::i64_const(b, 0); b.push(0x52); Self::or_flag(b, 0x800);
            }
            AluKind::Sub | AluKind::Cmp => {
                Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x54); Self::or_flag(b, 1);
                Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x85); Self::local_get(b, 18); Self::local_get(b, 20); b.push(0x85); b.push(0x83); Self::i64_const(b, 1i64 << (width*8-1)); b.push(0x83); Self::i64_const(b, 0); b.push(0x52); Self::or_flag(b, 0x800);
            }
            _ => {}
        }
        if matches!(kind, AluKind::Add | AluKind::Sub | AluKind::Cmp) {
            Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x85); Self::local_get(b, 20); b.push(0x85); Self::i64_const(b, 0x10); b.push(0x83); Self::i64_const(b, 0); b.push(0x52); Self::or_flag(b, 0x10);
        }
        Self::emit_szp(b, width);
    }

    fn emit_alu(b: &mut Vec<u8>, kind: AluKind, dst: u8, src: Option<u8>, imm: i64, width: u8) {
        Self::local_get(b, dst + 1); Self::mask_width(b, width); Self::local_set(b, 18);
        if let Some(s) = src { Self::local_get(b, s + 1); } else { Self::i64_const(b, imm); }
        Self::mask_width(b, width); Self::local_set(b, 19);
        Self::emit_alu_core(b, kind, dst, width);
    }

    fn emit_shift(b: &mut Vec<u8>, kind: u8, dst: u8, count: u8, width: u8) {
        let bits = width * 8;
        Self::local_get(b, dst + 1); Self::mask_width(b, width); Self::local_set(b, 18);
        Self::i64_const(b, count as i64); Self::local_set(b, 19);
        match kind {
            4 => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x86); }
            5 => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x88); }
            _ => { Self::local_get(b, 18); if width == 4 { b.push(0xA7); b.push(0xAC); } Self::local_get(b, 19); b.push(0x87); }
        }
        Self::mask_width(b, width); Self::local_set(b, 20); Self::write_reg(b, dst, width, 20);
        if count == 0 { return; }
        Self::local_get(b, 17); Self::i64_const(b, !0x811i64); b.push(0x83); Self::local_set(b, 17);
        if kind == 4 { Self::local_get(b, 18); Self::i64_const(b, (bits - count) as i64); b.push(0x88); }
        else if kind == 7 { Self::local_get(b, 18); if width == 4 { b.push(0xA7); b.push(0xAC); } Self::i64_const(b, (count - 1) as i64); b.push(0x87); }
        else { Self::local_get(b, 18); Self::i64_const(b, (count - 1) as i64); b.push(0x88); }
        Self::i64_const(b, 1); b.push(0x83); Self::i64_const(b, 0); b.push(0x52); Self::or_flag(b, 1);
        if count == 1 {
            if kind == 5 { Self::local_get(b, 18); Self::i64_const(b, 1i64 << (bits-1)); b.push(0x83); Self::i64_const(b, 0); b.push(0x52); Self::or_flag(b, 0x800); }
            else if kind == 4 {
                Self::local_get(b, 20); Self::i64_const(b, 1i64 << (bits-1)); b.push(0x83); Self::i64_const(b, 0); b.push(0x52);
                Self::local_get(b, 17); Self::i64_const(b, 1); b.push(0x83); Self::i64_const(b, 0); b.push(0x52); b.push(0x73); Self::or_flag(b, 0x800);
            } else { Self::local_get(b, 17); Self::i64_const(b, !0x800i64); b.push(0x83); Self::local_set(b, 17); }
        }
        Self::emit_szp(b, width);
    }

    fn emit_cc(b: &mut Vec<u8>, cc: u8) {
        let bit = |b: &mut Vec<u8>, mask: i64| { Self::local_get(b, 17); Self::i64_const(b, mask); b.push(0x83); Self::i64_const(b, 0); b.push(0x52); };
        match cc & 15 {
            0 => bit(b, 0x800), 1 => { bit(b, 0x800); b.push(0x45); }
            2 => bit(b, 1), 3 => { bit(b, 1); b.push(0x45); }
            4 => bit(b, 0x40), 5 => { bit(b, 0x40); b.push(0x45); }
            6 => { bit(b, 1); bit(b, 0x40); b.push(0x72); }
            7 => { bit(b, 1); b.push(0x45); bit(b, 0x40); b.push(0x45); b.push(0x71); }
            8 => bit(b, 0x80), 9 => { bit(b, 0x80); b.push(0x45); }
            0xA => bit(b, 4), 0xB => { bit(b, 4); b.push(0x45); }
            0xC => { bit(b, 0x80); bit(b, 0x800); b.push(0x47); }
            0xD => { bit(b, 0x80); bit(b, 0x800); b.push(0x46); }
            0xE => { bit(b, 0x40); bit(b, 0x80); bit(b, 0x800); b.push(0x47); b.push(0x72); }
            _ => { bit(b, 0x40); b.push(0x45); bit(b, 0x80); bit(b, 0x800); b.push(0x46); b.push(0x71); }
        }
    }

    fn emit_ea(b: &mut Vec<u8>, addr: &MemAddr) {
        if let Some(rip) = addr.rip {
            Self::i64_const(b, rip as i64); Self::local_set(b, 21);
            return;
        }
        if let Some(base) = addr.base { Self::local_get(b, base + 1); } else { Self::i64_const(b, 0); }
        if let Some(index) = addr.index {
            Self::local_get(b, index + 1);
            if addr.scale != 1 { Self::i64_const(b, addr.scale as i64); b.push(0x7E); }
            b.push(0x7C);
        }
        if addr.disp != 0 { Self::i64_const(b, addr.disp); b.push(0x7C); }
        match addr.seg {
            0x64 => { Self::ctx_load(b, 22); b.push(0x7C); }
            0x65 => { Self::ctx_load(b, 23); b.push(0x7C); }
            _ => {}
        }
        Self::local_set(b, 21);
    }

    // Local map: 27 page(i64), 28 tmp64, 29 tmp64b, 30 tmp64c,
    // 31 tlb_entry(i32), 32 host_addr(i32), 33 undo_rec(i32), 34 touched_rec(i32),
    // 35..50 xmm0..15(v128), 51 vtmp(v128).
    const L_PAGE: u8 = 27;
    const L_TMP64: u8 = 28;
    const L_TMP64B: u8 = 29;
    const L_TMP64C: u8 = 30;
    const L_TLB: u8 = 31;
    const L_HOST: u8 = 32;
    const L_UNDO: u8 = 33;
    const L_TOUCH: u8 = 34;
    const L_XMM0: u8 = 35;
    const L_VTMP: u8 = 51;

    /// Translate guest EA in local21 to a host Wasm address in L_HOST. On TLB miss calls
    /// env.resolve. Cross-page accesses branch to abort (interpreter handles precisely).
    fn emit_translate(b: &mut Vec<u8>, size: u8, write: bool, resolve_func: u32, abort_depth: u32) {
        // page = ea & ~0xfff
        Self::local_get(b, 21); Self::i64_const(b, !0xFFF); b.push(0x83); Self::local_set(b, Self::L_PAGE);
        // entry = tlb_base + (((page>>7)^page) & mask)*32
        Self::ctx_load(b, 25); b.push(0xA7); // wrap tlb base
        Self::local_get(b, Self::L_PAGE); Self::i64_const(b, 7); b.push(0x88);
        Self::local_get(b, Self::L_PAGE); b.push(0x85); b.push(0xA7);
        Self::i32_const(b, (JIT_TLB_ENTRIES - 1) as i32); b.push(0x71);
        Self::i32_const(b, 5); b.push(0x74); b.push(0x6A);
        Self::local_set(b, Self::L_TLB);
        // hit = tag==page && gen==ctx26
        Self::local_get(b, Self::L_TLB); b.extend_from_slice(&[0x29, 0x03, 0x00]); // i64.load offset0
        Self::local_get(b, Self::L_PAGE); b.push(0x51);
        Self::local_get(b, Self::L_TLB); b.extend_from_slice(&[0x28, 0x02, 0x10]); // i32.load offset16
        Self::ctx_load(b, 26); b.push(0xA7); b.push(0x46);
        b.push(0x71); // and
        b.push(0x04); b.push(0x7F); // if (result i32)
        Self::local_get(b, Self::L_TLB); b.extend_from_slice(&[0x28, 0x02, if write { 0x0C } else { 0x08 }]);
        b.push(0x05); // else
        Self::local_get(b, 21); Self::i32_const(b, if write { 1 } else { 0 });
        b.push(0x10); Self::push_u32_leb(b, resolve_func);
        b.push(0x0B); // end if
        Self::local_set(b, Self::L_HOST);
        // host += ea & 0xfff
        Self::local_get(b, Self::L_HOST); Self::local_get(b, 21); b.push(0xA7); Self::i32_const(b, 0xFFF); b.push(0x71); b.push(0x6A); Self::local_set(b, Self::L_HOST);
        // cross-page guard
        Self::local_get(b, 21); b.push(0xA7); Self::i32_const(b, 0xFFF); b.push(0x71);
        Self::i32_const(b, size as i32); b.push(0x6A); Self::i32_const(b, 4096); b.push(0x4B);
        b.push(0x04); b.push(0x40); b.push(0x0C); Self::push_u32_leb(b, abort_depth); b.push(0x0B);
    }

    fn emit_load_native(b: &mut Vec<u8>, size: u8) {
        Self::local_get(b, Self::L_HOST);
        match size {
            1 => b.extend_from_slice(&[0x2D, 0x00, 0x00]),
            2 => b.extend_from_slice(&[0x2F, 0x01, 0x00]),
            4 => b.extend_from_slice(&[0x28, 0x02, 0x00]),
            _ => b.extend_from_slice(&[0x29, 0x03, 0x00]),
        }
        if size < 8 { b.push(0xAD); } // i64.extend_i32_u
        Self::local_set(b, 22);
    }

    fn emit_read(b: &mut Vec<u8>, addr: &MemAddr, size: u8, resolve_func: u32, abort_depth: u32) {
        Self::emit_ea(b, addr);
        Self::emit_translate(b, size, false, resolve_func, abort_depth);
        Self::emit_load_native(b, size);
    }

    /// Append undo record (host_addr, old bytes, size) and touched page. Value for integer
    /// stores is in local22; for v128 stores in L_VTMP.
    fn emit_store_log(b: &mut Vec<u8>, size: u8, vector: bool) {
        // rec = undo_ptr + undo_len*32
        Self::ctx_load(b, 27); b.push(0xA7);
        Self::ctx_load(b, 28); b.push(0xA7); Self::i32_const(b, 5); b.push(0x74); b.push(0x6A);
        Self::local_set(b, Self::L_UNDO);
        // rec.host = host_addr
        Self::local_get(b, Self::L_UNDO); Self::local_get(b, Self::L_HOST); b.push(0xAD); b.extend_from_slice(&[0x37, 0x03, 0x00]);
        // rec.old = [host]
        Self::local_get(b, Self::L_UNDO); Self::local_get(b, Self::L_HOST);
        if vector {
            b.extend_from_slice(&[0xFD, 0x00, 0x00, 0x00]); // v128.load
            b.extend_from_slice(&[0xFD, 0x1D, 0x00]); // extract lane0
            b.extend_from_slice(&[0x37, 0x03, 0x08]);
            Self::local_get(b, Self::L_UNDO); Self::local_get(b, Self::L_HOST);
            b.extend_from_slice(&[0xFD, 0x00, 0x00, 0x00]);
            b.extend_from_slice(&[0xFD, 0x1D, 0x01]);
            b.extend_from_slice(&[0x37, 0x03, 0x10]);
        } else {
            match size {
                1 => b.extend_from_slice(&[0x2D, 0x00, 0x00]),
                2 => b.extend_from_slice(&[0x2F, 0x01, 0x00]),
                4 => b.extend_from_slice(&[0x28, 0x02, 0x00]),
                _ => b.extend_from_slice(&[0x29, 0x03, 0x00]),
            }
            if size < 8 { b.push(0xAD); }
            b.extend_from_slice(&[0x37, 0x03, 0x08]);
            Self::local_get(b, Self::L_UNDO); Self::i64_const(b, 0); b.extend_from_slice(&[0x37, 0x03, 0x10]);
        }
        // rec.size
        Self::local_get(b, Self::L_UNDO); Self::i64_const(b, size as i64); b.extend_from_slice(&[0x37, 0x03, 0x18]);
        // undo_len++
        Self::local_get(b, 0); Self::ctx_load(b, 28); Self::i64_const(b, 1); b.push(0x7C); b.extend_from_slice(&[0x37, 0x03]); Self::push_u32_leb(b, 28 * 8);
        // touched[touched_len++] = page
        Self::ctx_load(b, 30); b.push(0xA7);
        Self::ctx_load(b, 31); b.push(0xA7); Self::i32_const(b, 3); b.push(0x74); b.push(0x6A);
        Self::local_set(b, Self::L_TOUCH);
        Self::local_get(b, Self::L_TOUCH); Self::local_get(b, Self::L_PAGE); b.extend_from_slice(&[0x37, 0x03, 0x00]);
        Self::local_get(b, 0); Self::ctx_load(b, 31); Self::i64_const(b, 1); b.push(0x7C); b.extend_from_slice(&[0x37, 0x03]); Self::push_u32_leb(b, 31 * 8);
    }

    fn emit_store_native(b: &mut Vec<u8>, size: u8, vector: bool) {
        Self::emit_store_log(b, size, vector);
        Self::local_get(b, Self::L_HOST);
        if vector {
            Self::local_get(b, Self::L_VTMP);
            b.extend_from_slice(&[0xFD, 0x0B, 0x00, 0x00]);
        } else {
            Self::local_get(b, 22);
            match size {
                1 => { b.push(0xA7); b.extend_from_slice(&[0x3A, 0x00, 0x00]); }
                2 => { b.push(0xA7); b.extend_from_slice(&[0x3B, 0x01, 0x00]); }
                4 => { b.push(0xA7); b.extend_from_slice(&[0x36, 0x02, 0x00]); }
                _ => b.extend_from_slice(&[0x37, 0x03, 0x00]),
            }
        }
    }

    fn emit_push(b: &mut Vec<u8>, width: u8, resolve_func: u32, abort_depth: u32) {
        // new_rsp = rsp - width; store value at new_rsp; rsp = new_rsp
        Self::local_get(b, 5); Self::i64_const(b, width as i64); b.push(0x7D); Self::local_set(b, 21);
        Self::emit_translate(b, width, true, resolve_func, abort_depth);
        Self::emit_store_native(b, width, false);
        Self::local_get(b, 21); Self::local_set(b, 5);
    }

    fn v128_const_zero(b: &mut Vec<u8>) { b.extend_from_slice(&[0xFD, 0x0C]); b.extend_from_slice(&[0u8; 16]); }
    fn simd_op(b: &mut Vec<u8>, kind: u8) {
        b.push(0xFD);
        match kind {
            0 => b.push(0x51), // xor
            1 => b.push(0x4E), // and
            2 => b.push(0x50), // or
            3 => b.extend_from_slice(&[0xAE, 0x01]), // i32x4.add
            4 => b.extend_from_slice(&[0xB1, 0x01]),
            5 => b.extend_from_slice(&[0xB5, 0x01]),
            6 => b.extend_from_slice(&[0xCE, 0x01]), // i64x2.add
            7 => b.extend_from_slice(&[0xD1, 0x01]),
            9 => b.push(0x6E), // i8x16.add
            10 => b.push(0x71),
            11 => b.extend_from_slice(&[0x8E, 0x01]),
            12 => b.extend_from_slice(&[0x91, 0x01]),
            13 => b.extend_from_slice(&[0x95, 0x01]),
            _ => b.push(0x00), // unreachable for unsupported
        }
    }
    fn xmm_load_ctx(b: &mut Vec<u8>, xmm: u8) {
        Self::v128_const_zero(b);
        Self::ctx_load(b, 32 + xmm as u32 * 2); b.extend_from_slice(&[0xFD, 0x1E, 0x00]);
        Self::ctx_load(b, 33 + xmm as u32 * 2); b.extend_from_slice(&[0xFD, 0x1E, 0x01]);
        Self::local_set(b, Self::L_XMM0 + xmm);
    }
    fn xmm_store_ctx(b: &mut Vec<u8>, xmm: u8) {
        Self::local_get(b, 0); Self::local_get(b, Self::L_XMM0 + xmm); b.extend_from_slice(&[0xFD, 0x1D, 0x00]); b.extend_from_slice(&[0x37, 0x03]); Self::push_u32_leb(b, (32 + xmm as u32 * 2) * 8);
        Self::local_get(b, 0); Self::local_get(b, Self::L_XMM0 + xmm); b.extend_from_slice(&[0xFD, 0x1D, 0x01]); b.extend_from_slice(&[0x37, 0x03]); Self::push_u32_leb(b, (33 + xmm as u32 * 2) * 8);
    }

    fn emit_extend(b: &mut Vec<u8>, value: u8, src_width: u8, dst_width: u8, signed: bool) {
        Self::local_get(b, value); Self::mask_width(b, src_width);
        if signed && src_width < 8 {
            let shift = 64 - src_width * 8;
            Self::i64_const(b, shift as i64); b.push(0x86);
            Self::i64_const(b, shift as i64); b.push(0x87);
        }
        Self::mask_width(b, dst_width);
        Self::local_set(b, value);
    }

    fn emit_op(b: &mut Vec<u8>, op: &JitOp, resolve_func: u32, abort_depth: u32) {
        match *op {
            JitOp::Nop => {}
            JitOp::MovImm { dst, width, imm } => { Self::i64_const(b, imm as i64); Self::local_set(b, 22); Self::write_reg(b, dst, width, 22); }
            JitOp::MovReg { dst, src, width } => { Self::local_get(b, src + 1); Self::local_set(b, 22); Self::write_reg(b, dst, width, 22); }
            JitOp::Alu { kind, dst, src, imm, width } => Self::emit_alu(b, kind, dst, src, imm, width),
            JitOp::Shift { kind, dst, count, width } => Self::emit_shift(b, kind, dst, count, width),
            JitOp::Load { dst, addr, width, src_width, extend } => {
                Self::emit_read(b, &addr, src_width, resolve_func, abort_depth);
                if extend == 2 { Self::emit_extend(b, 22, src_width, width, true); }
                else if extend == 1 { Self::local_get(b, 22); Self::mask_width(b, src_width); Self::local_set(b, 22); }
                Self::write_reg(b, dst, width, 22);
            }
            JitOp::AluLoad { kind, dst, addr, width } => {
                Self::emit_read(b, &addr, width, resolve_func, abort_depth);
                Self::local_get(b, 22); Self::mask_width(b, width); Self::local_set(b, 19);
                Self::local_get(b, dst + 1); Self::mask_width(b, width); Self::local_set(b, 18);
                Self::emit_alu_core(b, kind, dst, width);
            }
            JitOp::Lea { dst, addr, width } => { Self::emit_ea(b, &addr); Self::local_get(b, 21); Self::local_set(b, 22); Self::write_reg(b, dst, width, 22); }
            JitOp::Pop { dst, width } => {
                let addr = MemAddr { base: Some(4), index: None, scale: 1, disp: 0, rip: None, seg: 0 };
                Self::emit_read(b, &addr, width, resolve_func, abort_depth);
                Self::write_reg(b, dst, width, 22);
                Self::local_get(b, 5); Self::i64_const(b, width as i64); b.push(0x7C); Self::local_set(b, 5);
            }
            JitOp::Push { src, width } => { Self::local_get(b, src + 1); Self::local_set(b, 22); Self::emit_push(b, width, resolve_func, abort_depth); }
            JitOp::PushImm { imm, width } => { Self::i64_const(b, imm as i64); Self::local_set(b, 22); Self::emit_push(b, width, resolve_func, abort_depth); }
            JitOp::Store { src, addr, width } => {
                Self::local_get(b, src + 1); Self::local_set(b, 22);
                Self::emit_ea(b, &addr); Self::emit_translate(b, width, true, resolve_func, abort_depth);
                Self::emit_store_native(b, width, false);
            }
            JitOp::StoreImm { imm, addr, width } => {
                Self::i64_const(b, imm as i64); Self::local_set(b, 22);
                Self::emit_ea(b, &addr); Self::emit_translate(b, width, true, resolve_func, abort_depth);
                Self::emit_store_native(b, width, false);
            }
            JitOp::Setcc { dst, cc } => { Self::emit_cc(b, cc); b.push(0xAD); Self::local_set(b, 22); Self::write_reg(b, dst, 1, 22); }
            JitOp::MovExtend { dst, src, src_width, dst_width, signed } => {
                Self::local_get(b, src + 1); Self::local_set(b, 22);
                Self::emit_extend(b, 22, src_width, dst_width, signed);
                Self::write_reg(b, dst, dst_width, 22);
            }
            JitOp::XmmLoad { dst, addr } => {
                Self::emit_ea(b, &addr); Self::emit_translate(b, 16, false, resolve_func, abort_depth);
                Self::local_get(b, Self::L_HOST); b.extend_from_slice(&[0xFD, 0x00, 0x00, 0x00]);
                Self::local_set(b, Self::L_XMM0 + dst);
            }
            JitOp::XmmStore { src, addr } => {
                Self::emit_ea(b, &addr); Self::emit_translate(b, 16, true, resolve_func, abort_depth);
                Self::local_get(b, Self::L_XMM0 + src); Self::local_set(b, Self::L_VTMP);
                Self::emit_store_native(b, 16, true);
            }
            JitOp::XmmReg { dst, src, .. } => { Self::local_get(b, Self::L_XMM0 + src); Self::local_set(b, Self::L_XMM0 + dst); }
            JitOp::XmmAlu { kind, dst, src } => {
                Self::local_get(b, Self::L_XMM0 + dst); Self::local_get(b, Self::L_XMM0 + src); Self::simd_op(b, kind);
                Self::local_set(b, Self::L_XMM0 + dst);
            }
            JitOp::XmmAluMem { kind, dst, addr } => {
                Self::emit_ea(b, &addr); Self::emit_translate(b, 16, false, resolve_func, abort_depth);
                Self::local_get(b, Self::L_HOST); b.extend_from_slice(&[0xFD, 0x00, 0x00, 0x00]); Self::local_set(b, Self::L_VTMP);
                Self::local_get(b, Self::L_XMM0 + dst); Self::local_get(b, Self::L_VTMP); Self::simd_op(b, kind);
                Self::local_set(b, Self::L_XMM0 + dst);
            }
            JitOp::MovdToXmm { dst, src, width } => {
                Self::v128_const_zero(b); Self::local_get(b, src + 1); Self::mask_width(b, width);
                b.extend_from_slice(&[0xFD, 0x1E, 0x00]); Self::local_set(b, Self::L_XMM0 + dst);
            }
            JitOp::MovdFromXmm { dst, src, width } => {
                Self::local_get(b, Self::L_XMM0 + src); b.extend_from_slice(&[0xFD, 0x1D, 0x00]); Self::local_set(b, 22);
                Self::write_reg(b, dst, width, 22);
            }
            JitOp::IndirectTarget { src, addr } => {
                if let Some(sr) = src { Self::local_get(b, sr + 1); Self::local_set(b, 25); }
                else if let Some(a) = addr { Self::emit_read(b, &a, 8, resolve_func, abort_depth); Self::local_get(b, 22); Self::local_set(b, 25); }
            }
        }
    }

    pub fn emit_wasm_module(entry_rip: u64, block: &DecodedBlock, links: &[JitLink]) -> Vec<u8> {
        let mut wasm = Vec::with_capacity(1024);
        wasm.extend_from_slice(b"\0asm\x01\0\0\0");
        let mem_ops = Self::uses_memory(&block.ops, block.exit);
        // Types: 0 run_block(i32)->i64, 1 resolve(i64,i32)->i32
        let mut types = Vec::new();
        types.push(if mem_ops { 2 } else { 1 });
        types.extend_from_slice(&[0x60, 1, 0x7F, 1, 0x7E]);
        if mem_ops { types.extend_from_slice(&[0x60, 2, 0x7E, 0x7F, 1, 0x7F]); }
        Self::push_section(&mut wasm, 1, &types);
        let resolve_func: u32 = 0;
        let func_imports = if mem_ops { 1 } else { 0 } + links.len() as u32;
        let mut imp = Vec::new();
        Self::push_u32_leb(&mut imp, 1 + func_imports);
        imp.push(3); imp.extend_from_slice(b"env"); imp.push(3); imp.extend_from_slice(b"mem"); imp.extend_from_slice(&[2, 0, 1]);
        if mem_ops {
            imp.push(3); imp.extend_from_slice(b"env"); imp.push(7); imp.extend_from_slice(b"resolve"); imp.push(0); imp.push(1);
        }
        for l in links { imp.push(3); imp.extend_from_slice(b"env"); Self::push_u32_leb(&mut imp, l.import_name.len() as u32); imp.extend_from_slice(l.import_name.as_bytes()); imp.push(0); imp.push(0); }
        Self::push_section(&mut wasm, 2, &imp);
        Self::push_section(&mut wasm, 3, &[1, 0]);
        let mut exp = Vec::new(); exp.push(1); exp.push(9); exp.extend_from_slice(b"run_block"); exp.push(0); Self::push_u32_leb(&mut exp, func_imports); Self::push_section(&mut wasm, 7, &exp);

        let (load_mask, write_mask) = Self::reg_masks(&block.ops);
        let (xmm_rd, xmm_wr) = Self::xmm_masks(&block.ops);
        let has_call = matches!(block.exit, BlockExit::Call { .. });
        let has_ret = block.exit == BlockExit::Ret;
        let gpr_rd = load_mask | if has_call || has_ret { 1 << 4 } else { 0 };
        let gpr_wr = write_mask | if has_call || has_ret { 1 << 4 } else { 0 };
        let mut b = Vec::with_capacity(1024);
        // locals: 16 GPR + 9 temps(17..25) + 1 i32(26) + 4 i64(27..30) + 4 i32(31..34) + 16 v128(35..50) + 1 v128(51)
        b.push(7); b.push(16); b.push(0x7E); b.push(9); b.push(0x7E); b.push(1); b.push(0x7F);
        b.push(4); b.push(0x7E); b.push(4); b.push(0x7F); b.push(16); b.push(0x7B); b.push(1); b.push(0x7B);
        for reg in 0..16u8 { if gpr_rd & (1 << reg) != 0 { Self::ctx_load(&mut b, reg as u32); Self::local_set(&mut b, reg + 1); } }
        for x in 0..16u8 { if xmm_rd & (1 << x) != 0 { Self::xmm_load_ctx(&mut b, x); } }
        Self::ctx_load(&mut b, 19); Self::local_set(&mut b, 17);
        Self::ctx_load(&mut b, 20); Self::local_set(&mut b, 23);
        Self::ctx_load(&mut b, 18); Self::local_set(&mut b, 24);
        let self_loop = matches!(block.exit, BlockExit::Jump | BlockExit::Branch { .. }) && block.target == entry_rip;
        let block_insns = block.insn_count as i64;
        let has_stores = Self::has_stores(block);
        let stores_per_iter = block.ops.iter().filter(|op| matches!(op, JitOp::Store { .. } | JitOp::StoreImm { .. } | JitOp::Push { .. } | JitOp::PushImm { .. } | JitOp::XmmStore { .. })).count() as i64 + if has_call { 1 } else { 0 };
        b.push(0x02); b.push(0x40); // $abort
        b.push(0x02); b.push(0x40); // $commit
        if self_loop { b.push(0x03); b.push(0x40); }
        let budget_br_depth = if self_loop { 2 } else { 1 };
        let abort_depth = if self_loop { 2 } else { 1 };
        // budget check
        Self::local_get(&mut b, 23); Self::i64_const(&mut b, block_insns); b.push(0x54);
        b.push(0x04); b.push(0x40);
        Self::ctx_store_const(&mut b, 16, JIT_STATUS_BUDGET as i64); Self::ctx_store_const(&mut b, 17, entry_rip as i64);
        b.push(0x0C); Self::push_u32_leb(&mut b, budget_br_depth);
        b.push(0x0B);
        // undo capacity check for store loops
        if has_stores && stores_per_iter > 0 {
            Self::ctx_load(&mut b, 28); Self::i64_const(&mut b, stores_per_iter); b.push(0x7C);
            Self::i64_const(&mut b, JIT_UNDO_CAP as i64); b.push(0x56);
            b.push(0x04); b.push(0x40);
            Self::ctx_store_const(&mut b, 16, JIT_STATUS_BUDGET as i64); Self::ctx_store_const(&mut b, 17, entry_rip as i64);
            b.push(0x0C); Self::push_u32_leb(&mut b, budget_br_depth);
            b.push(0x0B);
        }
        for op in &block.ops { Self::emit_op(&mut b, op, resolve_func, abort_depth); }
        // CALL/RET native stack control flow
        let mut dynamic_exit = false;
        match block.exit {
            BlockExit::Call { indirect } => {
                // indirect target was materialized into local25 by JitOp::IndirectTarget
                // push return address
                Self::i64_const(&mut b, entry_rip.wrapping_add(block.byte_len as u64) as i64); Self::local_set(&mut b, 22);
                Self::emit_push(&mut b, 8, resolve_func, abort_depth);
                if !indirect { Self::i64_const(&mut b, block.target as i64); Self::local_set(&mut b, 25); }
                dynamic_exit = true;
            }
            BlockExit::Ret => {
                let addr = MemAddr { base: Some(4), index: None, scale: 1, disp: 0, rip: None, seg: 0 };
                Self::emit_read(&mut b, &addr, 8, resolve_func, abort_depth);
                Self::local_get(&mut b, 22); Self::local_set(&mut b, 25);
                Self::local_get(&mut b, 5); Self::i64_const(&mut b, 8 + block.ret_imm as i64); b.push(0x7C); Self::local_set(&mut b, 5);
                dynamic_exit = true;
            }
            _ => {}
        }
        Self::local_get(&mut b, 24); Self::i64_const(&mut b, block_insns); b.push(0x7C); Self::local_set(&mut b, 24);
        Self::local_get(&mut b, 23); Self::i64_const(&mut b, block_insns); b.push(0x7D); Self::local_set(&mut b, 23);
        match block.exit {
            BlockExit::Branch { cc } if self_loop => { Self::emit_cc(&mut b, cc); b.push(0x0D); Self::push_u32_leb(&mut b, 0); }
            BlockExit::Jump if self_loop => { b.push(0x0C); Self::push_u32_leb(&mut b, 0); }
            _ => {}
        }
        if self_loop { b.push(0x0B); }
        let exit_rip = match block.exit {
            BlockExit::Ret | BlockExit::Call { .. } => 0,
            BlockExit::Branch { .. } if self_loop => entry_rip.wrapping_add(block.byte_len as u64),
            _ => block.target,
        };
        Self::ctx_store_const(&mut b, 16, JIT_STATUS_OK as i64);
        if let BlockExit::Branch { cc } = block.exit {
            if !self_loop {
                Self::i64_const(&mut b, block.target as i64);
                Self::i64_const(&mut b, entry_rip.wrapping_add(block.byte_len as u64) as i64);
                Self::emit_cc(&mut b, cc); b.push(0x1B); Self::local_set(&mut b, 25);
                Self::ctx_store_local(&mut b, 17, 25);
            } else { Self::ctx_store_const(&mut b, 17, exit_rip as i64); }
        } else if dynamic_exit { Self::ctx_store_local(&mut b, 17, 25); }
        else { Self::ctx_store_const(&mut b, 17, exit_rip as i64); }
        b.push(0x0C); Self::push_u32_leb(&mut b, 0);
        b.push(0x0B); // end $commit
        for reg in 0..16u8 { if gpr_wr & (1 << reg) != 0 { Self::ctx_store_local(&mut b, reg as u32, reg + 1); } }
        for x in 0..16u8 { if xmm_wr & (1 << x) != 0 { Self::xmm_store_ctx(&mut b, x); } }
        Self::ctx_store_local(&mut b, 19, 17); Self::ctx_store_local(&mut b, 18, 24); Self::ctx_store_local(&mut b, 20, 23);
        if !links.is_empty() && matches!(block.exit, BlockExit::Jump | BlockExit::Call { indirect: false }) {
            Self::local_get(&mut b, 0);
            if matches!(block.exit, BlockExit::Call { indirect: false }) {
                b.push(0x10); Self::push_u32_leb(&mut b, func_imports - links.len() as u32);
                Self::local_get(&mut b, 24); b.push(0x7C); b.push(0x0F);
            } else {
                b.push(0x12); Self::push_u32_leb(&mut b, func_imports - links.len() as u32);
            }
        } else {
            Self::local_get(&mut b, 24); b.push(0x0F);
        }
        b.push(0x0B); // end $abort
        Self::ctx_store_const(&mut b, 16, JIT_STATUS_INTERPRET as i64);
        Self::ctx_store_const(&mut b, 17, entry_rip as i64);
        Self::ctx_store_const(&mut b, 18, 0);
        Self::i64_const(&mut b, 0); b.push(0x0F);
        b.push(0x0B); // end function
        let mut code = Vec::new(); code.push(1); Self::push_u32_leb(&mut code, b.len() as u32); code.extend_from_slice(&b); Self::push_section(&mut wasm, 10, &code);
        wasm
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_multi_instruction_block_and_self_loop() {
        let code = [0x48,0x83,0xe9,0x01,0x75,0xfa,0xc3];
        let b = HybridWasmJit::decode_block(0x1000, &code).unwrap();
        assert_eq!(b.insn_count, 2); assert_eq!(b.byte_len, 6); assert_eq!(b.target, 0x1000);
        assert!(matches!(b.exit, BlockExit::Branch { cc: 5 }));
    }
    #[test]
    fn stops_before_unsupported_instruction() {
        let code = [0x90,0x0f,0x0b]; // nop; ud2
        let b = HybridWasmJit::decode_block(0x1000, &code).unwrap();
        assert_eq!(b.insn_count, 1); assert_eq!(b.exit, BlockExit::Interpret); assert_eq!(b.target, 0x1001);
    }
    #[test]
    fn decodes_native_call_ret_store_and_sse2() {
        // call +0; ret
        let b = HybridWasmJit::decode_block(0x1000, &[0xe8,0,0,0,0,0xc3]).unwrap();
        assert!(matches!(b.exit, BlockExit::Call { indirect: false }));
        assert_eq!(b.target, 0x1005);
        // mov [rax], rcx ; ret
        let b = HybridWasmJit::decode_block(0x1000, &[0x48,0x89,0x08,0xc3]).unwrap();
        assert!(matches!(b.ops[0], JitOp::Store { src: 1, width: 8, .. }));
        // movdqa xmm0, xmm1 ; paddd xmm0, xmm1 ; ret
        let b = HybridWasmJit::decode_block(0x1000, &[0x66,0x0f,0x6f,0xc1,0x66,0x0f,0xfe,0xc1,0xc3]).unwrap();
        assert!(matches!(b.ops[0], JitOp::XmmReg { dst: 0, src: 1, .. }));
        assert!(matches!(b.ops[1], JitOp::XmmAlu { kind: 3, dst: 0, src: 1 }));
    }
    #[test]
    fn epoch_invalidation_and_tail_link_emission() {
        let mut jit = HybridWasmJit::new();
        let target = jit.try_compile_block(0x2000, 1, &[0x90,0xc3]).unwrap();
        assert_eq!(target.insn_count, 2);
        jit.set_tail_calls(true);
        let src = jit.try_compile_block(0x1000, 1, &[0xe9,0xfb,0x0f,0,0]).unwrap();
        assert_eq!(src.links.len(), 1);
        assert!(src.wasm_bytes.windows(2).any(|w| w[0] == 0x12));
        assert!(jit.get_valid_artifact(0x1000, 1).is_some());
        jit.invalidate_entry(0x2000);
        assert!(jit.artifact(0x1000).is_none());
    }
}
