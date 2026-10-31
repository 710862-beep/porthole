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

pub const JIT_ABI_V2: u32 = 2;
pub const JIT_COMPILER_VERSION: u64 = 3;
pub const JIT_CONTEXT_SLOTS: usize = 32;
pub const JIT_STATUS_OK: u64 = 0;
pub const JIT_STATUS_BUDGET: u64 = 1;

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
enum JitOp {
    Nop,
    MovImm { dst: u8, width: u8, imm: u64 },
    MovReg { dst: u8, src: u8, width: u8 },
    Alu { kind: AluKind, dst: u8, src: Option<u8>, imm: i64, width: u8 },
    Shift { kind: u8, dst: u8, count: u8, width: u8 },
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
    pub fn decode_block(entry_rip: u64, bytes: &[u8]) -> Option<DecodedBlock> {
        let mut ops = Vec::new();
        let mut pc = 0usize;
        let mut insns = 0u32;
        let mut exit = BlockExit::Fallthrough;
        let mut target = entry_rip;
        while pc < bytes.len() && insns < 256 {
            let start = pc;
            let mut rex = 0u8;
            if bytes[pc] >= 0x40 && bytes[pc] <= 0x4F { rex = bytes[pc]; pc += 1; if pc >= bytes.len() { pc = start; break; } }
            let w = (rex & 8) != 0;
            let r = (rex & 4) != 0;
            let b = (rex & 1) != 0;
            let width = if w { 8 } else { 4 };
            let op = bytes[pc]; pc += 1;
            macro_rules! need { ($n:expr) => { if pc + $n > bytes.len() { pc = start; break; } } }
            macro_rules! modrm_reg { () => {{ need!(1); let m = bytes[pc]; pc += 1; if m >> 6 != 3 { pc = start; break; } (((m >> 3) & 7) | if r { 8 } else { 0 }, (m & 7) | if b { 8 } else { 0 }, (m >> 3) & 7) }} }
            match op {
                0x90 if (rex & !8) == 0 => { ops.push(JitOp::Nop); insns += 1; }
                0xB8..=0xBF => {
                    let dst = (op - 0xB8) | if b { 8 } else { 0 };
                    let imm = if w { need!(8); let v = u64::from_le_bytes(bytes[pc..pc+8].try_into().ok()?); pc += 8; v }
                              else { need!(4); let v = u32::from_le_bytes(bytes[pc..pc+4].try_into().ok()?) as u64; pc += 4; v };
                    ops.push(JitOp::MovImm { dst, width, imm }); insns += 1;
                }
                0x88..=0x8B => {
                    let (reg, rm, _) = modrm_reg!();
                    // 88/8A are byte ops; leave them to the interpreter for now.
                    if op == 0x88 || op == 0x8A { pc = start; break; }
                    let (dst, src) = if op == 0x89 { (rm, reg) } else { (reg, rm) };
                    ops.push(JitOp::MovReg { dst, src, width }); insns += 1;
                }
                0x00..=0x3D if (op & 7) <= 5 && (op & 0xF8) <= 0x38 => {
                    let group = op >> 3;
                    let kind = match group { 0 => AluKind::Add, 1 => AluKind::Or, 4 => AluKind::And, 5 => AluKind::Sub, 6 => AluKind::Xor, 7 => AluKind::Cmp, _ => { pc = start; break; } };
                    let form = op & 7;
                    if form >= 4 { pc = start; break; } // byte ops / push-pop seg
                    let (dst, src) = if form <= 1 {
                        let (reg, rm, _) = modrm_reg!();
                        if form <= 1 { (rm, reg) } else { (reg, rm) }
                    } else {
                        need!(4); let imm = i32::from_le_bytes(bytes[pc..pc+4].try_into().ok()?) as i64; pc += 4;
                        ops.push(JitOp::Alu { kind, dst: 0, src: None, imm, width }); insns += 1; continue;
                    };
                    ops.push(JitOp::Alu { kind, dst, src: Some(src), imm: 0, width }); insns += 1;
                }
                0x84 | 0x85 => {
                    let (reg, rm, _) = modrm_reg!();
                    if op == 0x84 { pc = start; break; }
                    ops.push(JitOp::Alu { kind: AluKind::Test, dst: rm, src: Some(reg), imm: 0, width }); insns += 1;
                }
                0x81 | 0x83 => {
                    let (_, rm, sub) = modrm_reg!();
                    let imm = if op == 0x83 { need!(1); let v = bytes[pc] as i8 as i64; pc += 1; v }
                              else { need!(4); let v = i32::from_le_bytes(bytes[pc..pc+4].try_into().ok()?) as i64; pc += 4; v };
                    let kind = match sub { 0 => AluKind::Add, 1 => AluKind::Or, 4 => AluKind::And, 5 => AluKind::Sub, 6 => AluKind::Xor, 7 => AluKind::Cmp, _ => { pc = start; break; } };
                    ops.push(JitOp::Alu { kind, dst: rm, src: None, imm, width }); insns += 1;
                }
                0xF7 => {
                    let (_, rm, sub) = modrm_reg!();
                    if sub == 0 { need!(4); let imm = i32::from_le_bytes(bytes[pc..pc+4].try_into().ok()?) as i64; pc += 4; ops.push(JitOp::Alu { kind: AluKind::Test, dst: rm, src: None, imm, width }); insns += 1; }
                    else { pc = start; break; }
                }
                0xC7 => {
                    let (_, rm, sub) = modrm_reg!();
                    if sub != 0 { pc = start; break; }
                    need!(4); let imm = i32::from_le_bytes(bytes[pc..pc+4].try_into().ok()?) as i64 as u64; pc += 4;
                    ops.push(JitOp::MovImm { dst: rm, width, imm }); insns += 1;
                }
                0xC1 => {
                    let (_, rm, sub) = modrm_reg!(); need!(1); let count = bytes[pc] & if w { 63 } else { 31 }; pc += 1;
                    if !matches!(sub, 4 | 5 | 7) || count == 0 || count >= if w { 64 } else { 32 } { pc = start; break; }
                    ops.push(JitOp::Shift { kind: sub, dst: rm, count, width }); insns += 1;
                }
                0xC3 if rex == 0 => { insns += 1; exit = BlockExit::Ret; target = 0; break; }
                0xE9 | 0xEB => {
                    let disp = if op == 0xE9 { need!(4); let v = i32::from_le_bytes(bytes[pc..pc+4].try_into().ok()?) as i64; pc += 4; v }
                               else { need!(1); let v = bytes[pc] as i8 as i64; pc += 1; v };
                    insns += 1; exit = BlockExit::Jump; target = entry_rip.wrapping_add(pc as u64).wrapping_add(disp as u64); break;
                }
                0x70..=0x7F => { need!(1); let disp = bytes[pc] as i8 as i64; pc += 1; insns += 1; exit = BlockExit::Branch { cc: op - 0x70 }; target = entry_rip.wrapping_add(pc as u64).wrapping_add(disp as u64); break; }
                0x0F if pc < bytes.len() && (0x80..=0x8F).contains(&bytes[pc]) => {
                    let cc = bytes[pc] - 0x80; pc += 1; need!(4); let disp = i32::from_le_bytes(bytes[pc..pc+4].try_into().ok()?) as i64; pc += 4;
                    insns += 1; exit = BlockExit::Branch { cc }; target = entry_rip.wrapping_add(pc as u64).wrapping_add(disp as u64); break;
                }
                // CALL/RET-imm/memory-writing/unknown: stop before the instruction. The
                // interpreter executes exactly that RIP, preserving faults and SMC epochs.
                _ => { pc = start; exit = BlockExit::Interpret; target = entry_rip.wrapping_add(pc as u64); break; }
            }
        }
        if insns == 0 { return None; }
        if exit == BlockExit::Fallthrough { target = entry_rip.wrapping_add(pc as u64); }
        if exit == BlockExit::Interpret { target = entry_rip.wrapping_add(pc as u64); }
        Some(DecodedBlock { ops, byte_len: pc, insn_count: insns, exit, target })
    }

    // ---------------------------------------------------------------- emitter
    fn push_u32_leb(out: &mut Vec<u8>, mut val: u32) { loop { let mut b = (val & 0x7F) as u8; val >>= 7; if val != 0 { b |= 0x80; } out.push(b); if val == 0 { break; } } }
    fn push_i64_sleb(out: &mut Vec<u8>, mut val: i64) { loop { let b = (val & 0x7F) as u8; val >>= 7; let done = (val == 0 && (b & 0x40) == 0) || (val == -1 && (b & 0x40) != 0); if done { out.push(b); break; } out.push(b | 0x80); } }
    fn push_section(wasm: &mut Vec<u8>, id: u8, payload: &[u8]) { wasm.push(id); Self::push_u32_leb(wasm, payload.len() as u32); wasm.extend_from_slice(payload); }
    fn local_get(b: &mut Vec<u8>, i: u8) { b.extend_from_slice(&[0x20, i]); }
    fn local_set(b: &mut Vec<u8>, i: u8) { b.extend_from_slice(&[0x21, i]); }
    fn local_tee(b: &mut Vec<u8>, i: u8) { b.extend_from_slice(&[0x22, i]); }
    fn i64_const(b: &mut Vec<u8>, v: i64) { b.push(0x42); Self::push_i64_sleb(b, v); }
    fn ctx_load(b: &mut Vec<u8>, slot: u32) { b.extend_from_slice(&[0x20, 0x00, 0x29, 0x03]); Self::push_u32_leb(b, slot * 8); }
    fn ctx_store_local(b: &mut Vec<u8>, slot: u32, local: u8) { b.extend_from_slice(&[0x20, 0x00]); Self::local_get(b, local); b.extend_from_slice(&[0x37, 0x03]); Self::push_u32_leb(b, slot * 8); }
    fn ctx_store_const(b: &mut Vec<u8>, slot: u32, v: i64) { b.extend_from_slice(&[0x20, 0x00]); Self::i64_const(b, v); b.extend_from_slice(&[0x37, 0x03]); Self::push_u32_leb(b, slot * 8); }
    fn mask_width(b: &mut Vec<u8>, width: u8) { if width == 4 { Self::i64_const(b, 0xFFFF_FFFF); b.push(0x83); } }

    fn reg_masks(ops: &[JitOp]) -> (u16, u16) {
        let mut rd = 0u16; let mut wr = 0u16;
        for op in ops { match *op {
            JitOp::Nop => {}
            JitOp::MovImm { dst, .. } => wr |= 1 << dst,
            JitOp::MovReg { dst, src, .. } => { rd |= 1 << src; wr |= 1 << dst; }
            JitOp::Alu { kind, dst, src, .. } => { rd |= 1 << dst; if let Some(s) = src { rd |= 1 << s; } if !matches!(kind, AluKind::Cmp | AluKind::Test) { wr |= 1 << dst; } }
            JitOp::Shift { dst, .. } => { rd |= 1 << dst; wr |= 1 << dst; }
        }}
        (rd | wr, wr)
    }

    fn or_flag(b: &mut Vec<u8>, mask: i64) {
        b.push(0xAD); // i64.extend_i32_u
        Self::i64_const(b, mask); b.push(0x7E); // mul
        Self::local_get(b, 17); b.push(0x84); Self::local_set(b, 17);
    }

    fn emit_szp(b: &mut Vec<u8>, width: u8) {
        // Clear ZF/SF/PF, then OR each condition*mask.
        Self::local_get(b, 17); Self::i64_const(b, !0xC4i64); b.push(0x83); Self::local_set(b, 17);
        Self::local_get(b, 20); b.push(0x50); Self::or_flag(b, 0x40); // ZF
        Self::local_get(b, 20); Self::i64_const(b, 1i64 << (width * 8 - 1)); b.push(0x83); Self::i64_const(b, 0); b.push(0x52); Self::or_flag(b, 0x80); // SF
        // PF over low byte: x ^= x>>4; x ^= x>>2; x ^= x>>1; PF = !(x&1).
        Self::local_get(b, 20); Self::local_get(b, 20); Self::i64_const(b, 4); b.push(0x88); b.push(0x85); Self::local_set(b, 21);
        Self::local_get(b, 21); Self::local_get(b, 21); Self::i64_const(b, 2); b.push(0x88); b.push(0x85); Self::local_set(b, 21);
        Self::local_get(b, 21); Self::local_get(b, 21); Self::i64_const(b, 1); b.push(0x88); b.push(0x85); Self::i64_const(b, 1); b.push(0x83); b.push(0x50); Self::or_flag(b, 4);
    }

    fn emit_alu(b: &mut Vec<u8>, kind: AluKind, dst: u8, src: Option<u8>, imm: i64, width: u8) {
        Self::local_get(b, dst + 1); Self::mask_width(b, width); Self::local_set(b, 18);
        if let Some(s) = src { Self::local_get(b, s + 1); } else { Self::i64_const(b, imm); }
        Self::mask_width(b, width); Self::local_set(b, 19);
        match kind {
            AluKind::Add => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x7C); }
            AluKind::Sub | AluKind::Cmp => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x7D); }
            AluKind::And | AluKind::Test => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x83); }
            AluKind::Or => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x84); }
            AluKind::Xor => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x85); }
            AluKind::Imul => { Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x7E); }
        }
        Self::mask_width(b, width); Self::local_set(b, 20);
        if !matches!(kind, AluKind::Cmp | AluKind::Test) { Self::local_get(b, 20); Self::local_set(b, dst + 1); }
        Self::local_get(b, 17); Self::i64_const(b, !0x811i64); b.push(0x83); Self::local_set(b, 17);
        match kind {
            AluKind::Add => {
                Self::local_get(b, 20); Self::local_get(b, 18); b.push(0x54); Self::or_flag(b, 1); // CF
                Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x85); Self::i64_const(b, -1); b.push(0x85);
                Self::local_get(b, 18); Self::local_get(b, 20); b.push(0x85); b.push(0x83); Self::i64_const(b, 1i64 << (width*8-1)); b.push(0x83); Self::i64_const(b, 0); b.push(0x52); Self::or_flag(b, 0x800);
            }
            AluKind::Sub | AluKind::Cmp => {
                Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x54); Self::or_flag(b, 1); // CF
                Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x85); Self::local_get(b, 18); Self::local_get(b, 20); b.push(0x85); b.push(0x83); Self::i64_const(b, 1i64 << (width*8-1)); b.push(0x83); Self::i64_const(b, 0); b.push(0x52); Self::or_flag(b, 0x800);
            }
            _ => {}
        }
        if matches!(kind, AluKind::Add | AluKind::Sub | AluKind::Cmp) {
            Self::local_get(b, 18); Self::local_get(b, 19); b.push(0x85); Self::local_get(b, 20); b.push(0x85); Self::i64_const(b, 0x10); b.push(0x83); Self::i64_const(b, 0); b.push(0x52); Self::or_flag(b, 0x10);
        }
        Self::emit_szp(b, width);
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
        Self::mask_width(b, width); Self::local_set(b, 20); Self::local_get(b, 20); Self::local_set(b, dst + 1);
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

    fn emit_op(b: &mut Vec<u8>, op: &JitOp) {
        match *op {
            JitOp::Nop => {}
            JitOp::MovImm { dst, width, imm } => { Self::i64_const(b, imm as i64); Self::mask_width(b, width); Self::local_set(b, dst + 1); }
            JitOp::MovReg { dst, src, width } => { Self::local_get(b, src + 1); Self::mask_width(b, width); Self::local_set(b, dst + 1); }
            JitOp::Alu { kind, dst, src, imm, width } => Self::emit_alu(b, kind, dst, src, imm, width),
            JitOp::Shift { kind, dst, count, width } => Self::emit_shift(b, kind, dst, count, width),
        }
    }

    pub fn emit_wasm_module(entry_rip: u64, block: &DecodedBlock, links: &[JitLink]) -> Vec<u8> {
        let mut wasm = Vec::with_capacity(512);
        wasm.extend_from_slice(b"\0asm\x01\0\0\0");
        Self::push_section(&mut wasm, 1, &[1, 0x60, 1, 0x7F, 1, 0x7E]);
        let mut imp = Vec::new();
        Self::push_u32_leb(&mut imp, 1 + links.len() as u32);
        imp.push(3); imp.extend_from_slice(b"env"); imp.push(3); imp.extend_from_slice(b"mem"); imp.extend_from_slice(&[2, 0, 1]);
        for l in links { imp.push(3); imp.extend_from_slice(b"env"); Self::push_u32_leb(&mut imp, l.import_name.len() as u32); imp.extend_from_slice(l.import_name.as_bytes()); imp.push(0); imp.push(0); }
        Self::push_section(&mut wasm, 2, &imp);
        Self::push_section(&mut wasm, 3, &[1, 0]);
        let mut exp = Vec::new(); exp.push(1); exp.push(9); exp.extend_from_slice(b"run_block"); exp.push(0); Self::push_u32_leb(&mut exp, links.len() as u32); Self::push_section(&mut wasm, 7, &exp);

        let (load_mask, write_mask) = Self::reg_masks(&block.ops);
        let mut b = Vec::with_capacity(512);
        b.push(2); b.push(16); b.push(0x7E); b.push(9); b.push(0x7E); // 16 GPR + rflags/lhs/rhs/res/tmp/tmp2/budget/count/exit = 25 locals
        for reg in 0..16u8 { if load_mask & (1 << reg) != 0 { Self::ctx_load(&mut b, reg as u32); Self::local_set(&mut b, reg + 1); } }
        Self::ctx_load(&mut b, 19); Self::local_set(&mut b, 17);
        Self::ctx_load(&mut b, 20); Self::local_set(&mut b, 23);
        Self::ctx_load(&mut b, 18); Self::local_set(&mut b, 24);
        let self_loop = matches!(block.exit, BlockExit::Jump | BlockExit::Branch { .. }) && block.target == entry_rip;
        let block_insns = block.insn_count as i64;
        // block $exit
        b.push(0x02); b.push(0x40);
        if self_loop { b.push(0x03); b.push(0x40); }
        // budget check: if budget < block_insns, status=budget, rip=entry, br exit
        Self::local_get(&mut b, 23); Self::i64_const(&mut b, block_insns); b.push(0x54);
        b.push(0x04); b.push(0x40);
        Self::ctx_store_const(&mut b, 16, JIT_STATUS_BUDGET as i64); Self::ctx_store_const(&mut b, 17, entry_rip as i64);
        b.push(0x0C); Self::push_u32_leb(&mut b, if self_loop { 2 } else { 1 });
        b.push(0x0B);
        for op in &block.ops { Self::emit_op(&mut b, op); }
        Self::local_get(&mut b, 23); Self::i64_const(&mut b, block_insns); b.push(0x7D); Self::local_set(&mut b, 23);
        Self::local_get(&mut b, 24); Self::i64_const(&mut b, block_insns); b.push(0x7C); Self::local_set(&mut b, 24);
        match block.exit {
            BlockExit::Branch { cc } if self_loop => { Self::emit_cc(&mut b, cc); b.push(0x0D); Self::push_u32_leb(&mut b, 0); }
            BlockExit::Jump if self_loop => { b.push(0x0C); Self::push_u32_leb(&mut b, 0); }
            _ => {}
        }
        if self_loop { b.push(0x0B); } // end loop
        // Normal exit: store status/rip. For self-loop Jcc the fallthrough is entry+byte_len.
        let exit_rip = match block.exit {
            BlockExit::Ret => 0,
            BlockExit::Branch { .. } if self_loop => entry_rip.wrapping_add(block.byte_len as u64),
            _ => block.target,
        };
        Self::ctx_store_const(&mut b, 16, JIT_STATUS_OK as i64);
        if let BlockExit::Branch { cc } = block.exit {
            if !self_loop {
                // select(fallthrough, target, condition)
                Self::i64_const(&mut b, block.target as i64);
                Self::i64_const(&mut b, entry_rip.wrapping_add(block.byte_len as u64) as i64);
                Self::emit_cc(&mut b, cc); b.push(0x1B); Self::local_set(&mut b, 25);
                Self::ctx_store_local(&mut b, 17, 25);
            } else { Self::ctx_store_const(&mut b, 17, exit_rip as i64); }
        } else { Self::ctx_store_const(&mut b, 17, exit_rip as i64); }
        b.push(0x0B); // end block
        for reg in 0..16u8 { if write_mask & (1 << reg) != 0 { Self::ctx_store_local(&mut b, reg as u32, reg + 1); } }
        Self::ctx_store_local(&mut b, 19, 17); Self::ctx_store_local(&mut b, 18, 24); Self::ctx_store_local(&mut b, 20, 23);
        if !links.is_empty() && block.exit == BlockExit::Jump {
            Self::local_get(&mut b, 0); b.push(0x12); Self::push_u32_leb(&mut b, 0); // return_call first linked import
        } else {
            Self::local_get(&mut b, 24); b.push(0x0F); // return count
        }
        b.push(0x0B);
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
