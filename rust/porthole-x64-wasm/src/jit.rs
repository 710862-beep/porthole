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

pub const JIT_ABI_V2: u32 = 2;
pub const JIT_COMPILER_VERSION: u64 = 3;
pub const JIT_CONTEXT_SLOTS: usize = 32;
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
    pub self_loop: bool,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockExit {
    Fallthrough,
    Jump,
    Branch { cc: u8 },
    Ret,
    Interpret,
}

#[derive(Debug, Clone)]
pub struct DecodedBlock {
    pub ops: Vec<JitOp>,
    pub byte_len: usize,
    pub insn_count: u32,
    pub exit: BlockExit,
    pub target: u64,
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
        if self.tail_calls && block.exit == BlockExit::Jump && !self_loop {
            if let Some(target) = self.artifacts.get(&block.target) {
                // Do not create cross-module cycles; self-loops are already native loops.
                let cyclic = target.links.iter().any(|l| l.target_rip == entry_rip) || target.entry_rip == entry_rip;
                if !cyclic {
                    links.push(JitLink { target_rip: block.target, page_epoch: target.page_epoch, import_name: format!("b{:016x}", block.target) });
                }
            }
        }
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
            interpret_rip, ends_with_ret: block.exit == BlockExit::Ret, self_loop, code_hash, wasm_bytes, links,
        };
        self.artifacts.insert(entry_rip, artifact.clone());
        self.pending_export_rips.push(entry_rip);
        self.modules_emitted += 1;
        Some(artifact)
    }

    /// OPFS is untrusted: accept only the exact portable module the current compiler emits.
    pub fn validate_cached_artifact(entry_rip: u64, _page_epoch: u32, byte_len: u32, insn_count: u32, ends_with_ret: bool, code_hash: u64, live: &[u8], wasm: &[u8]) -> bool {
        let mut hash_input = entry_rip.to_le_bytes().to_vec();
        hash_input.extend_from_slice(&JIT_COMPILER_VERSION.to_le_bytes());
        hash_input.extend_from_slice(live);
        if live.len() != byte_len as usize || Self::fnv1a_64(&hash_input) != code_hash { return false; }
        let Some(block) = Self::decode_block(entry_rip, live) else { return false; };
        if block.byte_len != byte_len as usize || block.insn_count != insn_count || (block.exit == BlockExit::Ret) != ends_with_ret { return false; }
        if block.byte_len > 4096 - (entry_rip & 0xFFF) as usize { return false; }
        Self::emit_wasm_module(entry_rip, &block, &[]).as_slice() == wasm
    }

    pub fn import_cached_artifact(&mut self, entry_rip: u64, page_epoch: u32, byte_len: u32, insn_count: u32, ends_with_ret: bool, self_loop: bool, code_hash: u64, wasm_bytes: Vec<u8>) -> bool {
        if wasm_bytes.len() < 8 || &wasm_bytes[0..8] != b"\0asm\x01\0\0\0" { return false; }
        self.artifacts.insert(entry_rip, CompiledJitArtifact { entry_rip, page_base: entry_rip & !0xFFF, page_epoch, byte_len, insn_count, ends_with_ret, self_loop, code_hash, interpret_rip: 0, wasm_bytes, links: Vec::new() });
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
        format!("{{\"abi\":{},\"entryRip\":\"{}\",\"pageEpoch\":{},\"byteLen\":{},\"insnCount\":{},\"endsWithRet\":{},\"selfLoop\":{},\"interpretRip\":\"{}\",\"codeHash\":\"{:016x}\",\"ctx\":{},\"links\":[{}]}}",
            JIT_ABI_V2, a.entry_rip, a.page_epoch, a.byte_len, a.insn_count, a.ends_with_ret, a.self_loop, a.interpret_rip, a.code_hash, ctx, links.join(","))
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
        if matches!(reg, Register::AH | Register::CH | Register::DH | Register::BH) { return None; }
        if !reg.is_gpr() { return None; }
        Some(reg.number() as u8)
    }

    fn reg_width(reg: Register) -> u8 { reg.size() as u8 }

    fn mem_addr(ins: &Instruction) -> Option<MemAddr> {
        let base = if ins.is_ip_rel_memory_operand() { None } else { Self::gpr_index(ins.memory_base()) };
        let index = Self::gpr_index(ins.memory_index());
        let seg = match ins.memory_segment() { Register::FS => 0x64, Register::GS => 0x65, _ => 0 };
        let disp = ins.memory_displacement64() as i64;
        let rip = if ins.is_ip_rel_memory_operand() { Some(ins.next_ip().wrapping_add(disp as u64)) } else { None };
        if !ins.is_ip_rel_memory_operand() && ins.memory_base() != Register::None && base.is_none() { return None; }
        if ins.memory_index() != Register::None && index.is_none() { return None; }
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
                Mnemonic::Pop => {
                    if let Some(d) = Self::gpr_index(ins.op0_register()) { ops.push(JitOp::Pop { dst: d, width: Self::reg_width(ins.op0_register()) }); } else { supported = false; }
                }
                Mnemonic::Add | Mnemonic::Or | Mnemonic::And | Mnemonic::Sub | Mnemonic::Xor | Mnemonic::Cmp | Mnemonic::Test => {
                    let kind = Self::alu_kind(m).unwrap();
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
                Mnemonic::Ret => { insns += 1; byte_len = offset + ins.len(); exit = BlockExit::Ret; target = 0; break; }
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
                if !matches!(exit, BlockExit::Ret | BlockExit::Jump | BlockExit::Branch { .. }) {
                    exit = BlockExit::Interpret; target = ins.ip(); byte_len = offset; insns -= 1; ops.pop();
                }
                break;
            }
        }
        if insns == 0 { return None; }
        if exit == BlockExit::Fallthrough { target = entry_rip.wrapping_add(byte_len as u64); }
        Some(DecodedBlock { ops, byte_len, insn_count: insns, exit, target })
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
        }}
        (rd | wr, wr)
    }

    fn uses_memory(ops: &[JitOp]) -> bool {
        ops.iter().any(|op| matches!(op, JitOp::Load { .. } | JitOp::AluLoad { .. } | JitOp::Lea { .. } | JitOp::Pop { .. }))
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

    /// Emit a memory read into local22. On fault, branch to the abort label (depth passed in).
    fn emit_read(b: &mut Vec<u8>, addr: &MemAddr, size: u8, read_func: u32, abort_depth: u32) {
        Self::emit_ea(b, addr);
        Self::local_get(b, 21); Self::i32_const(b, size as i32);
        b.push(0x10); Self::push_u32_leb(b, read_func);
        Self::local_set(b, 22);
        // if (ctx.mem_fault != 0) br abort
        Self::ctx_load(b, 24); b.push(0x50); b.push(0x45); // i64.eqz -> i32, then eqz => !=0
        b.push(0x04); b.push(0x40);
        b.push(0x0C); Self::push_u32_leb(b, abort_depth);
        b.push(0x0B);
    }

    fn emit_extend(b: &mut Vec<u8>, value: u8, src_width: u8, dst_width: u8, signed: bool) {
        Self::local_get(b, value); Self::mask_width(b, src_width);
        if signed && src_width < 8 {
            let shift = 64 - src_width * 8;
            Self::i64_const(b, shift as i64); b.push(0x86); // shl
            Self::i64_const(b, shift as i64); b.push(0x87); // shr_s
        }
        Self::mask_width(b, dst_width);
        Self::local_set(b, value);
    }

    fn emit_op(b: &mut Vec<u8>, op: &JitOp, read_func: u32, abort_depth: u32) {
        match *op {
            JitOp::Nop => {}
            JitOp::MovImm { dst, width, imm } => { Self::i64_const(b, imm as i64); Self::local_set(b, 22); Self::write_reg(b, dst, width, 22); }
            JitOp::MovReg { dst, src, width } => { Self::local_get(b, src + 1); Self::local_set(b, 22); Self::write_reg(b, dst, width, 22); }
            JitOp::Alu { kind, dst, src, imm, width } => Self::emit_alu(b, kind, dst, src, imm, width),
            JitOp::Shift { kind, dst, count, width } => Self::emit_shift(b, kind, dst, count, width),
            JitOp::Load { dst, addr, width, src_width, extend } => {
                Self::emit_read(b, &addr, src_width, read_func, abort_depth);
                if extend == 2 { Self::emit_extend(b, 22, src_width, width, true); }
                else if extend == 1 { Self::local_get(b, 22); Self::mask_width(b, src_width); Self::local_set(b, 22); }
                Self::write_reg(b, dst, width, 22);
            }
            JitOp::AluLoad { kind, dst, addr, width } => {
                Self::emit_read(b, &addr, width, read_func, abort_depth);
                Self::local_get(b, 22); Self::mask_width(b, width); Self::local_set(b, 19);
                Self::local_get(b, dst + 1); Self::mask_width(b, width); Self::local_set(b, 18);
                Self::emit_alu_core(b, kind, dst, width);
            }
            JitOp::Lea { dst, addr, width } => { Self::emit_ea(b, &addr); Self::local_get(b, 21); Self::local_set(b, 22); Self::write_reg(b, dst, width, 22); }
            JitOp::Pop { dst, width } => {
                let addr = MemAddr { base: Some(4), index: None, scale: 1, disp: 0, rip: None, seg: 0 };
                Self::emit_read(b, &addr, width, read_func, abort_depth);
                Self::write_reg(b, dst, width, 22);
                Self::local_get(b, 5); Self::i64_const(b, width as i64); b.push(0x7C); Self::local_set(b, 5);
            }
            JitOp::Setcc { dst, cc } => { Self::emit_cc(b, cc); b.push(0xAD); Self::local_set(b, 22); Self::write_reg(b, dst, 1, 22); }
            JitOp::MovExtend { dst, src, src_width, dst_width, signed } => {
                Self::local_get(b, src + 1); Self::local_set(b, 22);
                Self::emit_extend(b, 22, src_width, dst_width, signed);
                Self::write_reg(b, dst, dst_width, 22);
            }
        }
    }

    pub fn emit_wasm_module(entry_rip: u64, block: &DecodedBlock, links: &[JitLink]) -> Vec<u8> {
        let mut wasm = Vec::with_capacity(512);
        wasm.extend_from_slice(b"\0asm\x01\0\0\0");
        let mem_ops = Self::uses_memory(&block.ops);
        // Types: 0 = run_block(i32)->i64, 1 = read(i64,i32)->i64 (only if memory ops).
        let mut types = Vec::new();
        types.push(2); // count
        types.extend_from_slice(&[0x60, 1, 0x7F, 1, 0x7E]);
        if mem_ops { types.extend_from_slice(&[0x60, 2, 0x7E, 0x7F, 1, 0x7E]); }
        else { types[0] = 1; }
        Self::push_section(&mut wasm, 1, &types);
        let read_func: u32 = 0;
        let func_imports = if mem_ops { 1 } else { 0 } + links.len() as u32;
        let mut imp = Vec::new();
        Self::push_u32_leb(&mut imp, 1 + func_imports);
        imp.push(3); imp.extend_from_slice(b"env"); imp.push(3); imp.extend_from_slice(b"mem"); imp.extend_from_slice(&[2, 0, 1]);
        if mem_ops {
            imp.push(3); imp.extend_from_slice(b"env"); imp.push(4); imp.extend_from_slice(b"read"); imp.push(0); imp.push(1);
        }
        for l in links { imp.push(3); imp.extend_from_slice(b"env"); Self::push_u32_leb(&mut imp, l.import_name.len() as u32); imp.extend_from_slice(l.import_name.as_bytes()); imp.push(0); imp.push(0); }
        Self::push_section(&mut wasm, 2, &imp);
        Self::push_section(&mut wasm, 3, &[1, 0]);
        let mut exp = Vec::new(); exp.push(1); exp.push(9); exp.extend_from_slice(b"run_block"); exp.push(0); Self::push_u32_leb(&mut exp, func_imports); Self::push_section(&mut wasm, 7, &exp);

        let (load_mask, write_mask) = Self::reg_masks(&block.ops);
        let mut b = Vec::with_capacity(512);
        // locals: 16 GPR + 9 i64 temps (17..25) + 1 i32 fault flag (26)
        b.push(3); b.push(16); b.push(0x7E); b.push(9); b.push(0x7E); b.push(1); b.push(0x7F);
        for reg in 0..16u8 { if load_mask & (1 << reg) != 0 { Self::ctx_load(&mut b, reg as u32); Self::local_set(&mut b, reg + 1); } }
        Self::ctx_load(&mut b, 19); Self::local_set(&mut b, 17);
        Self::ctx_load(&mut b, 20); Self::local_set(&mut b, 23);
        Self::ctx_load(&mut b, 18); Self::local_set(&mut b, 24);
        let self_loop = matches!(block.exit, BlockExit::Jump | BlockExit::Branch { .. }) && block.target == entry_rip;
        let block_insns = block.insn_count as i64;
        // block $abort { block $commit { loop? { ... br $commit } } store regs; return } store abort; return
        b.push(0x02); b.push(0x40); // $abort depth outer
        b.push(0x02); b.push(0x40); // $commit
        if self_loop { b.push(0x03); b.push(0x40); }
        let commit_depth = if self_loop { 1 } else { 0 };
        let abort_depth = if self_loop { 2 } else { 1 };
        // budget check
        Self::local_get(&mut b, 23); Self::i64_const(&mut b, block_insns); b.push(0x54);
        b.push(0x04); b.push(0x40);
        Self::ctx_store_const(&mut b, 16, JIT_STATUS_BUDGET as i64); Self::ctx_store_const(&mut b, 17, entry_rip as i64);
        b.push(0x0C); Self::push_u32_leb(&mut b, commit_depth);
        b.push(0x0B);
        for op in &block.ops {
            Self::emit_op(&mut b, op, read_func, abort_depth);
            // per-instruction count/budget so a mid-block fault resumes precisely
            Self::local_get(&mut b, 24); Self::i64_const(&mut b, 1); b.push(0x7C); Self::local_set(&mut b, 24);
            Self::local_get(&mut b, 23); Self::i64_const(&mut b, 1); b.push(0x7D); Self::local_set(&mut b, 23);
        }
        match block.exit {
            BlockExit::Branch { cc } if self_loop => { Self::emit_cc(&mut b, cc); b.push(0x0D); Self::push_u32_leb(&mut b, 0); }
            BlockExit::Jump if self_loop => { b.push(0x0C); Self::push_u32_leb(&mut b, 0); }
            _ => {}
        }
        if self_loop { b.push(0x0B); }
        let exit_rip = match block.exit {
            BlockExit::Ret => 0,
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
        } else { Self::ctx_store_const(&mut b, 17, exit_rip as i64); }
        b.push(0x0C); Self::push_u32_leb(&mut b, commit_depth);
        b.push(0x0B); // end $commit
        for reg in 0..16u8 { if write_mask & (1 << reg) != 0 { Self::ctx_store_local(&mut b, reg as u32, reg + 1); } }
        Self::ctx_store_local(&mut b, 19, 17); Self::ctx_store_local(&mut b, 18, 24); Self::ctx_store_local(&mut b, 20, 23);
        if !links.is_empty() && block.exit == BlockExit::Jump {
            Self::local_get(&mut b, 0); b.push(0x12); Self::push_u32_leb(&mut b, func_imports - links.len() as u32);
        } else {
            Self::local_get(&mut b, 24); b.push(0x0F);
        }
        b.push(0x0B); // end $abort
        // abort path: memory fault before any side effect; discard locals, interpret from entry.
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
    fn stops_before_call_and_unsupported_store() {
        let code = [0x90,0xe8,0,0,0,0];
        let b = HybridWasmJit::decode_block(0x1000, &code).unwrap();
        assert_eq!(b.insn_count, 1); assert_eq!(b.exit, BlockExit::Interpret); assert_eq!(b.target, 0x1001);
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
