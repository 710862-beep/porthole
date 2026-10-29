use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct CompiledJitArtifact {
    pub entry_rip: u64,
    pub page_base: u64,
    pub page_epoch: u32,
    pub byte_len: u32,
    pub insn_count: u32,
    pub ends_with_ret: bool,
    pub code_hash: u64,
    pub wasm_bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy)]
enum JitOp {
    MovImm64 { dst: u8, imm: u64 },
    MovReg64 { dst: u8, src: u8 },
    MovReg32 { dst: u8, src: u8 },
    AddReg64 { dst: u8, src: u8 },
    SubReg64 { dst: u8, src: u8 },
    AndReg64 { dst: u8, src: u8 },
    OrReg64 { dst: u8, src: u8 },
    XorReg64 { dst: u8, src: u8 },
    AddImm64 { dst: u8, imm: i64 },
    SubImm64 { dst: u8, imm: i64 },
    AndImm64 { dst: u8, imm: i64 },
    OrImm64 { dst: u8, imm: i64 },
    XorImm64 { dst: u8, imm: i64 },
    ImulReg64 { dst: u8, src: u8 },
    ImulImm64 { dst: u8, src: u8, imm: i64 },
    ShlImm64 { dst: u8, count: u8 },
    ShrImm64 { dst: u8, count: u8 },
    SarImm64 { dst: u8, count: u8 },
}

pub struct HybridWasmJit {
    artifacts: HashMap<u64, CompiledJitArtifact>,
    pending_export_rips: Vec<u64>,
    pub modules_emitted: u64,
    pub cache_hits: u64,
    pub invalidations: u64,
}

impl HybridWasmJit {
    pub fn new() -> Self {
        Self {
            artifacts: HashMap::new(),
            pending_export_rips: Vec::new(),
            modules_emitted: 0,
            cache_hits: 0,
            invalidations: 0,
        }
    }

    pub fn fnv1a_64(bytes: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for &b in bytes {
            h ^= b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        h
    }

    pub fn get_valid_artifact(&mut self, rip: u64, current_page_epoch: u32) -> Option<&CompiledJitArtifact> {
        let stale = if let Some(art) = self.artifacts.get(&rip) {
            art.page_epoch != current_page_epoch
        } else {
            return None;
        };
        if stale {
            self.artifacts.remove(&rip);
            self.invalidations += 1;
            return None;
        }
        self.cache_hits += 1;
        self.artifacts.get(&rip)
    }

    pub fn try_compile_block(
        &mut self,
        entry_rip: u64,
        page_epoch: u32,
        bytes: &[u8],
    ) -> Option<CompiledJitArtifact> {
        let (ops, byte_len, insn_count, ends_with_ret) = Self::decode_pure_gpr_block(bytes)?;
        if ops.is_empty() {
            return None;
        }
        let wasm_bytes = Self::emit_wasm_module(&ops, insn_count);
        let code_hash = Self::fnv1a_64(&bytes[..byte_len]);
        let artifact = CompiledJitArtifact {
            entry_rip,
            page_base: entry_rip & !0xFFF,
            page_epoch,
            byte_len: byte_len as u32,
            insn_count,
            ends_with_ret,
            code_hash,
            wasm_bytes,
        };
        self.artifacts.insert(entry_rip, artifact.clone());
        self.pending_export_rips.push(entry_rip);
        self.modules_emitted += 1;
        Some(artifact)
    }

    pub fn import_cached_artifact(
        &mut self,
        entry_rip: u64,
        page_epoch: u32,
        byte_len: u32,
        insn_count: u32,
        ends_with_ret: bool,
        code_hash: u64,
        wasm_bytes: Vec<u8>,
    ) -> bool {
        if wasm_bytes.len() < 8 || &wasm_bytes[0..8] != b"\0asm\x01\0\0\0" {
            return false;
        }
        self.artifacts.insert(
            entry_rip,
            CompiledJitArtifact {
                entry_rip,
                page_base: entry_rip & !0xFFF,
                page_epoch,
                byte_len,
                insn_count,
                ends_with_ret,
                code_hash,
                wasm_bytes,
            },
        );
        true
    }

    pub fn drain_pending_exports(&mut self) -> Vec<CompiledJitArtifact> {
        let rips = std::mem::take(&mut self.pending_export_rips);
        let mut out = Vec::new();
        for rip in rips {
            if let Some(a) = self.artifacts.get(&rip) {
                out.push(a.clone());
            }
        }
        out
    }

    pub fn artifact_count(&self) -> usize {
        self.artifacts.len()
    }

    fn decode_pure_gpr_block(bytes: &[u8]) -> Option<(Vec<JitOp>, usize, u32, bool)> {
        let mut ops = Vec::new();
        let mut pc = 0usize;
        let mut insns = 0u32;
        let mut ends_with_ret = false;

        while pc < bytes.len() && insns < 64 {
            let start = pc;
            // Optional REX prefix (0x40..=0x4F)
            let mut rex: u8 = 0;
            if bytes[pc] >= 0x40 && bytes[pc] <= 0x4F {
                rex = bytes[pc];
                pc += 1;
                if pc >= bytes.len() {
                    pc = start;
                    break;
                }
            }
            let rex_w = (rex & 0x08) != 0;
            let rex_r = (rex & 0x04) != 0;
            let rex_b = (rex & 0x01) != 0;

            let op = bytes[pc];
            pc += 1;

            match op {
                0x90 => {
                    insns += 1;
                }
                0xC3 if rex == 0 => {
                    insns += 1;
                    ends_with_ret = true;
                    break;
                }
                0xB8..=0xBF => {
                    let rd = (op - 0xB8) | if rex_b { 8 } else { 0 };
                    if rex_w {
                        if pc + 8 > bytes.len() {
                            pc = start;
                            break;
                        }
                        let imm = u64::from_le_bytes(bytes[pc..pc + 8].try_into().ok()?);
                        pc += 8;
                        ops.push(JitOp::MovImm64 { dst: rd, imm });
                    } else {
                        if pc + 4 > bytes.len() {
                            pc = start;
                            break;
                        }
                        let imm = u32::from_le_bytes(bytes[pc..pc + 4].try_into().ok()?) as u64;
                        pc += 4;
                        ops.push(JitOp::MovImm64 { dst: rd, imm });
                    }
                    insns += 1;
                }
                0x89 | 0x8B | 0x01 | 0x03 | 0x29 | 0x2B | 0x21 | 0x23 | 0x09 | 0x0B | 0x31 | 0x33 => {
                    if pc >= bytes.len() {
                        pc = start;
                        break;
                    }
                    let modrm = bytes[pc];
                    if (modrm >> 6) != 3 {
                        pc = start;
                        break;
                    }
                    pc += 1;
                    let reg = ((modrm >> 3) & 7) | if rex_r { 8 } else { 0 };
                    let rm = (modrm & 7) | if rex_b { 8 } else { 0 };
                    if !rex_w && op == 0x89 {
                        ops.push(JitOp::MovReg32 { dst: rm, src: reg });
                    } else if !rex_w && op == 0x8B {
                        ops.push(JitOp::MovReg32 { dst: reg, src: rm });
                    } else if !rex_w && op == 0x31 && reg == rm {
                        ops.push(JitOp::MovImm64 { dst: rm, imm: 0 });
                    } else if !rex_w {
                        pc = start;
                        break;
                    } else {
                        let (dst, src) = if (op & 2) == 0 { (rm, reg) } else { (reg, rm) };
                        match op & 0xFC {
                            0x88 => ops.push(JitOp::MovReg64 { dst, src }),
                            0x00 => ops.push(JitOp::AddReg64 { dst, src }),
                            0x28 => ops.push(JitOp::SubReg64 { dst, src }),
                            0x20 => ops.push(JitOp::AndReg64 { dst, src }),
                            0x08 => ops.push(JitOp::OrReg64 { dst, src }),
                            0x30 => ops.push(JitOp::XorReg64 { dst, src }),
                            _ => {
                                pc = start;
                                break;
                            }
                        }
                    }
                    insns += 1;
                }
                0x05 | 0x2D | 0x25 | 0x0D | 0x35 if rex_w => {
                    if pc + 4 > bytes.len() {
                        pc = start;
                        break;
                    }
                    let imm = i32::from_le_bytes(bytes[pc..pc + 4].try_into().ok()?) as i64;
                    pc += 4;
                    match op {
                        0x05 => ops.push(JitOp::AddImm64 { dst: 0, imm }),
                        0x2D => ops.push(JitOp::SubImm64 { dst: 0, imm }),
                        0x25 => ops.push(JitOp::AndImm64 { dst: 0, imm }),
                        0x0D => ops.push(JitOp::OrImm64 { dst: 0, imm }),
                        0x35 => ops.push(JitOp::XorImm64 { dst: 0, imm }),
                        _ => unreachable!(),
                    }
                    insns += 1;
                }
                0x81 | 0x83 if rex_w => {
                    if pc >= bytes.len() {
                        pc = start;
                        break;
                    }
                    let modrm = bytes[pc];
                    if (modrm >> 6) != 3 {
                        pc = start;
                        break;
                    }
                    pc += 1;
                    let subop = (modrm >> 3) & 7;
                    let dst = (modrm & 7) | if rex_b { 8 } else { 0 };
                    let imm = if op == 0x83 {
                        if pc >= bytes.len() {
                            pc = start;
                            break;
                        }
                        let v = (bytes[pc] as i8) as i64;
                        pc += 1;
                        v
                    } else {
                        if pc + 4 > bytes.len() {
                            pc = start;
                            break;
                        }
                        let v = i32::from_le_bytes(bytes[pc..pc + 4].try_into().ok()?) as i64;
                        pc += 4;
                        v
                    };
                    match subop {
                        0 => ops.push(JitOp::AddImm64 { dst, imm }),
                        1 => ops.push(JitOp::OrImm64 { dst, imm }),
                        4 => ops.push(JitOp::AndImm64 { dst, imm }),
                        5 => ops.push(JitOp::SubImm64 { dst, imm }),
                        6 => ops.push(JitOp::XorImm64 { dst, imm }),
                        _ => {
                            pc = start;
                            break;
                        }
                    }
                    insns += 1;
                }
                0x69 | 0x6B if rex_w => {
                    if pc >= bytes.len() {
                        pc = start;
                        break;
                    }
                    let modrm = bytes[pc];
                    if (modrm >> 6) != 3 {
                        pc = start;
                        break;
                    }
                    pc += 1;
                    let dst = ((modrm >> 3) & 7) | if rex_r { 8 } else { 0 };
                    let src = (modrm & 7) | if rex_b { 8 } else { 0 };
                    let imm = if op == 0x6B {
                        if pc >= bytes.len() {
                            pc = start;
                            break;
                        }
                        let v = (bytes[pc] as i8) as i64;
                        pc += 1;
                        v
                    } else {
                        if pc + 4 > bytes.len() {
                            pc = start;
                            break;
                        }
                        let v = i32::from_le_bytes(bytes[pc..pc + 4].try_into().ok()?) as i64;
                        pc += 4;
                        v
                    };
                    ops.push(JitOp::ImulImm64 { dst, src, imm });
                    insns += 1;
                }
                0xC1 if rex_w => {
                    if pc + 2 > bytes.len() {
                        pc = start;
                        break;
                    }
                    let modrm = bytes[pc];
                    if (modrm >> 6) != 3 {
                        pc = start;
                        break;
                    }
                    let subop = (modrm >> 3) & 7;
                    let dst = (modrm & 7) | if rex_b { 8 } else { 0 };
                    let count = bytes[pc + 1] & 63;
                    pc += 2;
                    match subop {
                        4 => ops.push(JitOp::ShlImm64 { dst, count }),
                        5 => ops.push(JitOp::ShrImm64 { dst, count }),
                        7 => ops.push(JitOp::SarImm64 { dst, count }),
                        _ => {
                            pc = start;
                            break;
                        }
                    }
                    insns += 1;
                }
                0x0F if rex_w => {
                    if pc + 2 > bytes.len() || bytes[pc] != 0xAF {
                        pc = start;
                        break;
                    }
                    let modrm = bytes[pc + 1];
                    if (modrm >> 6) != 3 {
                        pc = start;
                        break;
                    }
                    pc += 2;
                    let dst = ((modrm >> 3) & 7) | if rex_r { 8 } else { 0 };
                    let src = (modrm & 7) | if rex_b { 8 } else { 0 };
                    ops.push(JitOp::ImulReg64 { dst, src });
                    insns += 1;
                }
                _ => {
                    pc = start;
                    break;
                }
            }
        }

        if pc == 0 || insns == 0 {
            None
        } else {
            Some((ops, pc, insns, ends_with_ret))
        }
    }

    fn push_u32_leb(out: &mut Vec<u8>, mut val: u32) {
        loop {
            let mut b = (val & 0x7F) as u8;
            val >>= 7;
            if val != 0 {
                b |= 0x80;
            }
            out.push(b);
            if val == 0 {
                break;
            }
        }
    }

    fn push_i64_sleb(out: &mut Vec<u8>, mut val: i64) {
        loop {
            let b = (val & 0x7F) as u8;
            val >>= 7;
            let done = (val == 0 && (b & 0x40) == 0) || (val == -1 && (b & 0x40) != 0);
            if done {
                out.push(b);
                break;
            } else {
                out.push(b | 0x80);
            }
        }
    }

    fn push_section(wasm: &mut Vec<u8>, id: u8, payload: &[u8]) {
        wasm.push(id);
        Self::push_u32_leb(wasm, payload.len() as u32);
        wasm.extend_from_slice(payload);
    }

    /// Emits a complete, valid WebAssembly binary module exporting:
    /// `(func (export "run_block") (param $ctx i32) (result i64))`
    /// where `$ctx` points to `[u64; 16]` (`RAX..R15`) in `(import "env" "mem" (memory 1))`,
    /// updates the register file in place, and returns `(i64.const insn_count)`.
    fn emit_wasm_module(ops: &[JitOp], insn_count: u32) -> Vec<u8> {
        let mut wasm = Vec::with_capacity(256);
        wasm.extend_from_slice(b"\0asm\x01\0\0\0");

        // Section 1: Type [(param i32) -> (result i64)]
        let type_sec = [0x01u8, 0x60, 0x01, 0x7F, 0x01, 0x7E];
        Self::push_section(&mut wasm, 1, &type_sec);

        // Section 2: Import (import "env" "mem" (memory 1))
        let mut import_sec = Vec::new();
        import_sec.push(1); // 1 import
        import_sec.push(3);
        import_sec.extend_from_slice(b"env");
        import_sec.push(3);
        import_sec.extend_from_slice(b"mem");
        import_sec.push(0x02); // memory
        import_sec.push(0x00); // limits: min only
        import_sec.push(0x01); // min 1 page
        Self::push_section(&mut wasm, 2, &import_sec);

        // Section 3: Function [type 0]
        Self::push_section(&mut wasm, 3, &[0x01, 0x00]);

        // Section 7: Export "run_block" -> func 0
        let mut export_sec = Vec::new();
        export_sec.push(1);
        export_sec.push(9);
        export_sec.extend_from_slice(b"run_block");
        export_sec.push(0x00);
        export_sec.push(0x00);
        Self::push_section(&mut wasm, 7, &export_sec);

        // Track which registers are read/written so we only load/store touched GPRs!
        let mut read_mask = 0u16;
        let mut write_mask = 0u16;
        for &op in ops {
            match op {
                JitOp::MovImm64 { dst, .. } => {
                    write_mask |= 1 << dst;
                }
                JitOp::MovReg64 { dst, src } | JitOp::MovReg32 { dst, src } => {
                    read_mask |= 1 << src;
                    write_mask |= 1 << dst;
                }
                JitOp::AddReg64 { dst, src }
                | JitOp::SubReg64 { dst, src }
                | JitOp::AndReg64 { dst, src }
                | JitOp::OrReg64 { dst, src }
                | JitOp::XorReg64 { dst, src }
                | JitOp::ImulReg64 { dst, src } => {
                    read_mask |= (1 << dst) | (1 << src);
                    write_mask |= 1 << dst;
                }
                JitOp::ImulImm64 { dst, src, .. } => {
                    read_mask |= 1 << src;
                    write_mask |= 1 << dst;
                }
                JitOp::AddImm64 { dst, .. }
                | JitOp::SubImm64 { dst, .. }
                | JitOp::AndImm64 { dst, .. }
                | JitOp::OrImm64 { dst, .. }
                | JitOp::XorImm64 { dst, .. }
                | JitOp::ShlImm64 { dst, .. }
                | JitOp::ShrImm64 { dst, .. }
                | JitOp::SarImm64 { dst, .. } => {
                    read_mask |= 1 << dst;
                    write_mask |= 1 << dst;
                }
            }
        }
        let load_mask = read_mask | write_mask;

        // Body: local 0 = param i32 ($ctx); locals 1..=16 = i64 GPRs (RAX..R15)
        let mut body = Vec::with_capacity(192);
        body.push(1); // 1 local declaration group
        body.push(16); // count = 16
        body.push(0x7E); // type = i64

        for reg in 0..16u8 {
            if (load_mask & (1 << reg)) != 0 {
                body.push(0x20); // local.get 0 ($ctx)
                body.push(0x00);
                body.push(0x29); // i64.load
                body.push(0x03); // align = 8 (2^3)
                Self::push_u32_leb(&mut body, (reg as u32) * 8);
                body.push(0x21); // local.set (reg + 1)
                body.push(reg + 1);
            }
        }

        for &op in ops {
            match op {
                JitOp::MovImm64 { dst, imm } => {
                    body.push(0x42); // i64.const
                    Self::push_i64_sleb(&mut body, imm as i64);
                    body.push(0x21);
                    body.push(dst + 1);
                }
                JitOp::MovReg64 { dst, src } => {
                    body.push(0x20);
                    body.push(src + 1);
                    body.push(0x21);
                    body.push(dst + 1);
                }
                JitOp::MovReg32 { dst, src } => {
                    body.push(0x20);
                    body.push(src + 1);
                    body.push(0x42);
                    Self::push_i64_sleb(&mut body, 0xFFFF_FFFF);
                    body.push(0x83); // i64.and
                    body.push(0x21);
                    body.push(dst + 1);
                }
                JitOp::AddReg64 { dst, src } => {
                    body.extend_from_slice(&[0x20, dst + 1, 0x20, src + 1, 0x7C, 0x21, dst + 1]);
                }
                JitOp::SubReg64 { dst, src } => {
                    body.extend_from_slice(&[0x20, dst + 1, 0x20, src + 1, 0x7D, 0x21, dst + 1]);
                }
                JitOp::AndReg64 { dst, src } => {
                    body.extend_from_slice(&[0x20, dst + 1, 0x20, src + 1, 0x83, 0x21, dst + 1]);
                }
                JitOp::OrReg64 { dst, src } => {
                    body.extend_from_slice(&[0x20, dst + 1, 0x20, src + 1, 0x84, 0x21, dst + 1]);
                }
                JitOp::XorReg64 { dst, src } => {
                    body.extend_from_slice(&[0x20, dst + 1, 0x20, src + 1, 0x85, 0x21, dst + 1]);
                }
                JitOp::ImulReg64 { dst, src } => {
                    body.extend_from_slice(&[0x20, dst + 1, 0x20, src + 1, 0x7E, 0x21, dst + 1]);
                }
                JitOp::ImulImm64 { dst, src, imm } => {
                    body.push(0x20);
                    body.push(src + 1);
                    body.push(0x42);
                    Self::push_i64_sleb(&mut body, imm);
                    body.push(0x7E); // i64.mul
                    body.push(0x21);
                    body.push(dst + 1);
                }
                JitOp::AddImm64 { dst, imm } => {
                    body.push(0x20);
                    body.push(dst + 1);
                    body.push(0x42);
                    Self::push_i64_sleb(&mut body, imm);
                    body.push(0x7C); // i64.add
                    body.push(0x21);
                    body.push(dst + 1);
                }
                JitOp::SubImm64 { dst, imm } => {
                    body.push(0x20);
                    body.push(dst + 1);
                    body.push(0x42);
                    Self::push_i64_sleb(&mut body, imm);
                    body.push(0x7D); // i64.sub
                    body.push(0x21);
                    body.push(dst + 1);
                }
                JitOp::AndImm64 { dst, imm } => {
                    body.push(0x20);
                    body.push(dst + 1);
                    body.push(0x42);
                    Self::push_i64_sleb(&mut body, imm);
                    body.push(0x83); // i64.and
                    body.push(0x21);
                    body.push(dst + 1);
                }
                JitOp::OrImm64 { dst, imm } => {
                    body.push(0x20);
                    body.push(dst + 1);
                    body.push(0x42);
                    Self::push_i64_sleb(&mut body, imm);
                    body.push(0x84); // i64.or
                    body.push(0x21);
                    body.push(dst + 1);
                }
                JitOp::XorImm64 { dst, imm } => {
                    body.push(0x20);
                    body.push(dst + 1);
                    body.push(0x42);
                    Self::push_i64_sleb(&mut body, imm);
                    body.push(0x85); // i64.xor
                    body.push(0x21);
                    body.push(dst + 1);
                }
                JitOp::ShlImm64 { dst, count } => {
                    body.push(0x20);
                    body.push(dst + 1);
                    body.push(0x42);
                    Self::push_i64_sleb(&mut body, count as i64);
                    body.push(0x86); // i64.shl
                    body.push(0x21);
                    body.push(dst + 1);
                }
                JitOp::ShrImm64 { dst, count } => {
                    body.push(0x20);
                    body.push(dst + 1);
                    body.push(0x42);
                    Self::push_i64_sleb(&mut body, count as i64);
                    body.push(0x88); // i64.shr_u
                    body.push(0x21);
                    body.push(dst + 1);
                }
                JitOp::SarImm64 { dst, count } => {
                    body.push(0x20);
                    body.push(dst + 1);
                    body.push(0x42);
                    Self::push_i64_sleb(&mut body, count as i64);
                    body.push(0x87); // i64.shr_s
                    body.push(0x21);
                    body.push(dst + 1);
                }
            }
        }

        for reg in 0..16u8 {
            if (write_mask & (1 << reg)) != 0 {
                body.push(0x20); // local.get 0 ($ctx)
                body.push(0x00);
                body.push(0x20); // local.get (reg + 1)
                body.push(reg + 1);
                body.push(0x37); // i64.store
                body.push(0x03); // align = 8
                Self::push_u32_leb(&mut body, (reg as u32) * 8);
            }
        }

        // Return executed instruction count as i64
        body.push(0x42);
        Self::push_i64_sleb(&mut body, insn_count as i64);
        body.push(0x0B); // end

        let mut code_sec = Vec::with_capacity(body.len() + 8);
        code_sec.push(1); // 1 function body
        Self::push_u32_leb(&mut code_sec, body.len() as u32);
        code_sec.extend_from_slice(&body);
        Self::push_section(&mut wasm, 10, &code_sec);

        wasm
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compile_runtime_x64_block_to_valid_wasm() {
        let mut jit = HybridWasmJit::new();
        let x64_code: [u8; 16] = [
            0x48, 0x89, 0xC8, // mov rax, rcx
            0x48, 0x6B, 0xC0, 0x06, // imul rax, rax, 6
            0x48, 0x01, 0xD0, // add rax, rdx
            0x48, 0x35, 0xAA, 0x55, 0x00, 0x00, // xor rax, 0x55aa
        ];
        let art = jit.try_compile_block(0x5000_0000, 1, &x64_code).unwrap();
        assert_eq!(&art.wasm_bytes[0..8], b"\0asm\x01\0\0\0");
        assert_eq!(art.byte_len, 16);
        assert_eq!(art.insn_count, 4);

        // Verify self-modifying epoch invalidation
        assert!(jit.get_valid_artifact(0x5000_0000, 1).is_some());
        assert!(jit.get_valid_artifact(0x5000_0000, 2).is_none());
        assert_eq!(jit.invalidations, 1);
    }
}
