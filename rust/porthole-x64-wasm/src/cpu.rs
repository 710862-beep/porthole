use std::collections::HashMap;

use crate::vmm::{MemoryTrap, VirtualMemoryManager, PAGE_MASK};

pub const CF: u64 = 1 << 0;
pub const PF: u64 = 1 << 2;
pub const AF: u64 = 1 << 4;
pub const ZF: u64 = 1 << 6;
pub const SF: u64 = 1 << 7;
pub const DF: u64 = 1 << 10;
pub const OF: u64 = 1 << 11;

#[derive(Debug, Default, Clone, Copy)]
pub struct Prefixes {
    pub lock: bool,
    pub rep_f3: bool,
    pub repne_f2: bool,
    pub osz_66: bool,
    pub asz_67: bool,
    pub seg: u8, // 0 = none, 0x64 = FS, 0x65 = GS
    pub has_rex: bool,
    pub rex_w: bool,
    pub rex_r: bool,
    pub rex_x: bool,
    pub rex_b: bool,
}

#[derive(Debug, Clone)]
pub enum ExecOutcome {
    Next,
    Branch(u64),
    Fault(String),
}

#[derive(Debug, Clone, Copy)]
pub enum Addressing {
    Reg(usize),
    Abs(u64),
    RipRel { disp: i32, seg_base: u64, asz_67: bool },
}

#[derive(Debug, Clone)]
pub struct CachedBasicBlock {
    pub start_rip: u64,
    pub page_base: u64,
    pub page_epoch: u32,
    pub code_window: Vec<u8>,
    pub exec_count: u32,
    pub jit_checked: bool,
}

#[derive(Clone)]
pub struct CpuState {
    pub gpr: [u64; 16], // RAX, RCX, RDX, RBX, RSP, RBP, RSI, RDI, R8..R15
    pub rip: u64,
    pub rflags: u64,
    pub gs_base: u64,
    pub fs_base: u64,
    pub ymm: [[u8; 32]; 16],
    pub mxcsr: u32,
    pub fpu_regs: [f64; 8],
    pub fpu_top: u8,
    pub fpu_cw: u16,
    pub fpu_sw: u16,
    pub icache: HashMap<u64, CachedBasicBlock>,
    pub instructions_executed: u64,
    pub icache_hits: u64,
    pub icache_misses: u64,
    /// Last executed RIPs, used to explain guest faults without an interactive debugger.
    pub rip_history: [u64; 16],
    pub rip_history_len: usize,
}

impl CpuState {
    pub fn new() -> Self {
        Self {
            gpr: [0; 16],
            rip: 0,
            rflags: 0x0202,
            gs_base: 0,
            fs_base: 0,
            ymm: [[0u8; 32]; 16],
            mxcsr: 0x1F80,
            fpu_regs: [0.0; 8],
            fpu_top: 0,
            fpu_cw: 0x037F,
            fpu_sw: 0,
            icache: HashMap::new(),
            instructions_executed: 0,
            icache_hits: 0,
            icache_misses: 0,
            rip_history: [0; 16],
            rip_history_len: 0,
        }
    }

    #[inline]
    pub fn read_gpr(&self, reg: usize, size: usize, has_rex: bool) -> u64 {
        match size {
            8 => self.gpr[reg & 15],
            4 => self.gpr[reg & 15] & 0xFFFF_FFFF,
            2 => self.gpr[reg & 15] & 0xFFFF,
            1 => {
                if !has_rex && (4..=7).contains(&reg) {
                    (self.gpr[reg - 4] >> 8) & 0xFF
                } else {
                    self.gpr[reg & 15] & 0xFF
                }
            }
            _ => unreachable!(),
        }
    }

    #[inline]
    pub fn write_gpr(&mut self, reg: usize, size: usize, has_rex: bool, val: u64) {
        let r = reg & 15;
        match size {
            8 => self.gpr[r] = val,
            4 => self.gpr[r] = val & 0xFFFF_FFFF,
            2 => self.gpr[r] = (self.gpr[r] & !0xFFFF) | (val & 0xFFFF),
            1 => {
                if !has_rex && (4..=7).contains(&reg) {
                    let base = reg - 4;
                    self.gpr[base] = (self.gpr[base] & !0xFF00) | ((val & 0xFF) << 8);
                } else {
                    self.gpr[r] = (self.gpr[r] & !0xFF) | (val & 0xFF);
                }
            }
            _ => unreachable!(),
        }
    }

    #[inline]
    fn seg_base(&self, pfx: &Prefixes) -> u64 {
        match pfx.seg {
            0x64 => self.fs_base,
            0x65 => self.gs_base,
            _ => 0,
        }
    }

    pub fn decode_modrm_addressing(
        &self,
        pfx: &Prefixes,
        code: &[u8],
        cursor: &mut usize,
    ) -> (u8, usize, usize, Addressing) {
        let modrm = code[*cursor];
        *cursor += 1;
        let mod_bits = modrm >> 6;
        let reg = (((modrm >> 3) & 7) as usize) | if pfx.rex_r { 8 } else { 0 };
        let rm_low = (modrm & 7) as usize;
        let rm = rm_low | if pfx.rex_b { 8 } else { 0 };

        if mod_bits == 3 {
            return (modrm, reg, rm, Addressing::Reg(rm));
        }

        let seg_base = self.seg_base(pfx);

        if rm_low == 4 {
            // SIB byte
            let sib = code[*cursor];
            *cursor += 1;
            let scale = 1u64 << (sib >> 6);
            let idx_low = ((sib >> 3) & 7) as usize;
            let idx = idx_low | if pfx.rex_x { 8 } else { 0 };
            let base_low = (sib & 7) as usize;
            let base = base_low | if pfx.rex_b { 8 } else { 0 };

            let base_val = if mod_bits == 0 && base_low == 5 {
                let disp32 = i32::from_le_bytes(code[*cursor..*cursor + 4].try_into().unwrap());
                *cursor += 4;
                disp32 as i64 as u64
            } else {
                self.gpr[base]
            };

            // Index register RSP (4 without REX.X) means no index
            let idx_val = if idx == 4 {
                0
            } else {
                self.gpr[idx].wrapping_mul(scale)
            };

            let disp: i64 = match mod_bits {
                0 => 0,
                1 => {
                    let d = code[*cursor] as i8 as i64;
                    *cursor += 1;
                    d
                }
                2 => {
                    let d = i32::from_le_bytes(code[*cursor..*cursor + 4].try_into().unwrap()) as i64;
                    *cursor += 4;
                    d
                }
                _ => 0,
            };

            let mut ea = base_val.wrapping_add(idx_val).wrapping_add(disp as u64);
            if pfx.asz_67 {
                ea &= 0xFFFF_FFFF;
            }
            return (modrm, reg, rm, Addressing::Abs(seg_base.wrapping_add(ea)));
        }

        if mod_bits == 0 && rm_low == 5 {
            let disp32 = i32::from_le_bytes(code[*cursor..*cursor + 4].try_into().unwrap());
            *cursor += 4;
            return (
                modrm,
                reg,
                rm,
                Addressing::RipRel {
                    disp: disp32,
                    seg_base,
                    asz_67: pfx.asz_67,
                },
            );
        }

        let disp: i64 = match mod_bits {
            0 => 0,
            1 => {
                let d = code[*cursor] as i8 as i64;
                *cursor += 1;
                d
            }
            2 => {
                let d = i32::from_le_bytes(code[*cursor..*cursor + 4].try_into().unwrap()) as i64;
                *cursor += 4;
                d
            }
            _ => 0,
        };
        let mut ea = self.gpr[rm].wrapping_add(disp as u64);
        if pfx.asz_67 {
            ea &= 0xFFFF_FFFF;
        }
        (modrm, reg, rm, Addressing::Abs(seg_base.wrapping_add(ea)))
    }

    #[inline]
    pub fn resolve_ea(&self, addr: Addressing, next_rip: u64) -> u64 {
        match addr {
            Addressing::Reg(_) => 0,
            Addressing::Abs(ea) => ea,
            Addressing::RipRel {
                disp,
                seg_base,
                asz_67,
            } => {
                let mut ea = next_rip.wrapping_add(disp as i64 as u64);
                if asz_67 {
                    ea &= 0xFFFF_FFFF;
                }
                seg_base.wrapping_add(ea)
            }
        }
    }

    pub fn decode_modrm_ea(
        &self,
        pfx: &Prefixes,
        code: &[u8],
        cursor: &mut usize,
        insn_rip: u64,
    ) -> Result<(u8, usize, usize, u64), MemoryTrap> {
        self.decode_modrm_ea_imm(pfx, code, cursor, insn_rip, 0)
    }

    pub fn decode_modrm_ea_imm(
        &self,
        pfx: &Prefixes,
        code: &[u8],
        cursor: &mut usize,
        insn_rip: u64,
        trailing_imm_bytes: usize,
    ) -> Result<(u8, usize, usize, u64), MemoryTrap> {
        let (modrm, reg, rm, addressing) = self.decode_modrm_addressing(pfx, code, cursor);
        let next_rip = insn_rip.wrapping_add((*cursor + trailing_imm_bytes) as u64);
        Ok((modrm, reg, rm, self.resolve_ea(addressing, next_rip)))
    }

    fn read_rm(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        addr: Addressing,
        next_rip: u64,
        size: usize,
        has_rex: bool,
    ) -> Result<u64, MemoryTrap> {
        match addr {
            Addressing::Reg(r) => Ok(self.read_gpr(r, size, has_rex)),
            _ => {
                let ea = self.resolve_ea(addr, next_rip);
                match size {
                    1 => Ok(vmm.read_u8(ea)? as u64),
                    2 => Ok(vmm.read_u16(ea)? as u64),
                    4 => Ok(vmm.read_u32(ea)? as u64),
                    8 => Ok(vmm.read_u64(ea)?),
                    _ => unreachable!(),
                }
            }
        }
    }

    fn write_rm(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        addr: Addressing,
        next_rip: u64,
        size: usize,
        has_rex: bool,
        val: u64,
    ) -> Result<(), MemoryTrap> {
        match addr {
            Addressing::Reg(r) => {
                self.write_gpr(r, size, has_rex, val);
                Ok(())
            }
            _ => {
                let ea = self.resolve_ea(addr, next_rip);
                match size {
                    1 => vmm.write_u8(ea, val as u8),
                    2 => vmm.write_u16(ea, val as u16),
                    4 => vmm.write_u32(ea, val as u32),
                    8 => vmm.write_u64(ea, val),
                    _ => unreachable!(),
                }
            }
        }
    }

    #[inline]
    fn parity8(v: u8) -> bool {
        v.count_ones() % 2 == 0
    }

    #[inline]
    fn mask_for_size(size: usize) -> u64 {
        match size {
            1 => 0xFF,
            2 => 0xFFFF,
            4 => 0xFFFF_FFFF,
            8 => u64::MAX,
            _ => unreachable!(),
        }
    }

    #[inline]
    fn sign_bit_for_size(size: usize) -> u64 {
        1u64 << (size * 8 - 1)
    }

    fn set_szp_flags(&mut self, res: u64, size: usize) {
        let mask = Self::mask_for_size(size);
        let sign = Self::sign_bit_for_size(size);
        let r = res & mask;
        self.rflags &= !(ZF | SF | PF);
        if r == 0 {
            self.rflags |= ZF;
        }
        if (r & sign) != 0 {
            self.rflags |= SF;
        }
        if Self::parity8(r as u8) {
            self.rflags |= PF;
        }
    }

    pub fn alu_op(&mut self, op: u8, a_raw: u64, b_raw: u64, size: usize) -> u64 {
        let mask = Self::mask_for_size(size);
        let sign = Self::sign_bit_for_size(size);
        let a = a_raw & mask;
        let b = b_raw & mask;
        let cf_in = if (self.rflags & CF) != 0 { 1u64 } else { 0u64 };

        match op {
            0 => {
                // ADD
                let (s1, c1) = a.overflowing_add(b);
                let res = s1 & mask;
                let cf = if size == 8 { c1 } else { s1 > mask };
                let of = ((!(a ^ b)) & (a ^ res) & sign) != 0;
                let af = ((a ^ b ^ res) & 0x10) != 0;
                self.rflags &= !(CF | OF | AF);
                if cf {
                    self.rflags |= CF;
                }
                if of {
                    self.rflags |= OF;
                }
                if af {
                    self.rflags |= AF;
                }
                self.set_szp_flags(res, size);
                res
            }
            2 => {
                // ADC
                let (s1, c1) = a.overflowing_add(b);
                let (s2, c2) = s1.overflowing_add(cf_in);
                let res = s2 & mask;
                let cf = if size == 8 {
                    c1 || c2
                } else {
                    (a as u128 + b as u128 + cf_in as u128) > mask as u128
                };
                let of = ((!(a ^ b)) & (a ^ res) & sign) != 0;
                let af = ((a ^ b ^ res) & 0x10) != 0;
                self.rflags &= !(CF | OF | AF);
                if cf {
                    self.rflags |= CF;
                }
                if of {
                    self.rflags |= OF;
                }
                if af {
                    self.rflags |= AF;
                }
                self.set_szp_flags(res, size);
                res
            }
            3 => {
                // SBB
                let (d1, c1) = a.overflowing_sub(b);
                let (d2, c2) = d1.overflowing_sub(cf_in);
                let res = d2 & mask;
                let cf = if size == 8 {
                    c1 || c2
                } else {
                    (a as u128) < (b as u128 + cf_in as u128)
                };
                let of = (((a ^ b) & (a ^ res)) & sign) != 0;
                let af = ((a ^ b ^ res) & 0x10) != 0;
                self.rflags &= !(CF | OF | AF);
                if cf {
                    self.rflags |= CF;
                }
                if of {
                    self.rflags |= OF;
                }
                if af {
                    self.rflags |= AF;
                }
                self.set_szp_flags(res, size);
                res
            }
            5 | 7 => {
                // SUB / CMP
                let (d1, c1) = a.overflowing_sub(b);
                let res = d1 & mask;
                let cf = if size == 8 { c1 } else { a < b };
                let of = (((a ^ b) & (a ^ res)) & sign) != 0;
                let af = ((a ^ b ^ res) & 0x10) != 0;
                self.rflags &= !(CF | OF | AF);
                if cf {
                    self.rflags |= CF;
                }
                if of {
                    self.rflags |= OF;
                }
                if af {
                    self.rflags |= AF;
                }
                self.set_szp_flags(res, size);
                if op == 7 { a } else { res }
            }
            1 | 4 | 6 => {
                // OR (1), AND (4), XOR (6)
                let res = match op {
                    1 => a | b,
                    4 => a & b,
                    6 => a ^ b,
                    _ => unreachable!(),
                } & mask;
                self.rflags &= !(CF | OF | AF);
                self.set_szp_flags(res, size);
                res
            }
            _ => a,
        }
    }

    pub fn eval_cc(&self, cc: u8) -> bool {
        let cf = (self.rflags & CF) != 0;
        let pf = (self.rflags & PF) != 0;
        let zf = (self.rflags & ZF) != 0;
        let sf = (self.rflags & SF) != 0;
        let of = (self.rflags & OF) != 0;
        match cc & 0x0F {
            0x0 => of,
            0x1 => !of,
            0x2 => cf,
            0x3 => !cf,
            0x4 => zf,
            0x5 => !zf,
            0x6 => cf || zf,
            0x7 => !cf && !zf,
            0x8 => sf,
            0x9 => !sf,
            0xA => pf,
            0xB => !pf,
            0xC => sf != of,
            0xD => sf == of,
            0xE => zf || (sf != of),
            0xF => !zf && (sf == of),
            _ => unreachable!(),
        }
    }

    fn shift_op(&mut self, subop: u8, val_raw: u64, count_raw: u8, size: usize) -> u64 {
        let mask = Self::mask_for_size(size);
        let bits = (size * 8) as u32;
        let shift_mask = if size == 8 { 63 } else { 31 };
        let count = (count_raw & shift_mask) as u32;
        let v = val_raw & mask;
        if count == 0 {
            return v;
        }
        let sign = Self::sign_bit_for_size(size);

        match subop {
            0 => {
                // ROL
                let c = count % bits;
                let res = if c == 0 {
                    v
                } else {
                    ((v << c) | (v >> (bits - c))) & mask
                };
                let cf = (res & 1) != 0;
                self.rflags = (self.rflags & !CF) | if cf { CF } else { 0 };
                if count == 1 {
                    let msb = (res & sign) != 0;
                    self.rflags = (self.rflags & !OF) | if msb ^ cf { OF } else { 0 };
                }
                res
            }
            1 => {
                // ROR
                let c = count % bits;
                let res = if c == 0 {
                    v
                } else {
                    ((v >> c) | (v << (bits - c))) & mask
                };
                let cf = (res & sign) != 0;
                self.rflags = (self.rflags & !CF) | if cf { CF } else { 0 };
                if count == 1 {
                    let msb2 = (res & (sign >> 1)) != 0;
                    self.rflags = (self.rflags & !OF) | if cf ^ msb2 { OF } else { 0 };
                }
                res
            }
            4 | 6 => {
                // SHL / SAL
                let cf = if count <= bits {
                    ((v >> (bits - count)) & 1) != 0
                } else {
                    false
                };
                let res = if count >= bits { 0 } else { (v << count) & mask };
                self.rflags = (self.rflags & !(CF | AF)) | if cf { CF } else { 0 };
                if count == 1 {
                    let msb = (res & sign) != 0;
                    self.rflags = (self.rflags & !OF) | if msb ^ cf { OF } else { 0 };
                }
                self.set_szp_flags(res, size);
                res
            }
            5 => {
                // SHR
                let cf = if count <= bits {
                    ((v >> (count - 1)) & 1) != 0
                } else {
                    false
                };
                let res = if count >= bits { 0 } else { (v >> count) & mask };
                self.rflags = (self.rflags & !(CF | AF)) | if cf { CF } else { 0 };
                if count == 1 {
                    let old_msb = (v & sign) != 0;
                    self.rflags = (self.rflags & !OF) | if old_msb { OF } else { 0 };
                }
                self.set_szp_flags(res, size);
                res
            }
            7 => {
                // SAR
                let sv: i64 = match size {
                    1 => (v as u8 as i8) as i64,
                    2 => (v as u16 as i16) as i64,
                    4 => (v as u32 as i32) as i64,
                    8 => v as i64,
                    _ => unreachable!(),
                };
                let cf = if count >= bits {
                    sv < 0
                } else {
                    ((sv >> (count - 1)) & 1) != 0
                };
                let shifted = if count >= 63 {
                    if sv < 0 { -1i64 } else { 0i64 }
                } else {
                    sv >> count
                };
                let res = (shifted as u64) & mask;
                self.rflags = (self.rflags & !(CF | OF | AF)) | if cf { CF } else { 0 };
                self.set_szp_flags(res, size);
                res
            }
            _ => v,
        }
    }

    #[inline]
    fn operand_size(pfx: &Prefixes, byte_op: bool) -> usize {
        if byte_op {
            1
        } else if pfx.rex_w {
            8
        } else if pfx.osz_66 {
            2
        } else {
            4
        }
    }

    #[inline]
    fn read_sign_ext_imm(code: &[u8], cursor: &mut usize, imm_size: usize) -> u64 {
        match imm_size {
            1 => {
                let v = code[*cursor] as i8 as i64 as u64;
                *cursor += 1;
                v
            }
            2 => {
                let v = i16::from_le_bytes(code[*cursor..*cursor + 2].try_into().unwrap()) as i64 as u64;
                *cursor += 2;
                v
            }
            4 => {
                let v = i32::from_le_bytes(code[*cursor..*cursor + 4].try_into().unwrap()) as i64 as u64;
                *cursor += 4;
                v
            }
            _ => unreachable!(),
        }
    }

    /// Fetches up to 16 instruction bytes at `self.rip` using the BasicBlock `icache` when resident
    /// on a single non-modified page, falling back to `vmm.read_bytes` across page boundaries.
    pub fn fetch_insn_bytes(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        buf: &mut [u8; 16],
    ) -> Result<usize, MemoryTrap> {
        let rip = self.rip;
        let page_base = rip & !PAGE_MASK;
        let off = (rip & PAGE_MASK) as usize;
        let cur_epoch = vmm.page_write_epoch(page_base);

        if off + 16 <= 4096 {
            if let Some(cb) = self.icache.get_mut(&page_base) {
                if cb.page_epoch == cur_epoch && !vmm.is_page_swapped(page_base) {
                    buf.copy_from_slice(&cb.code_window[off..off + 16]);
                    cb.exec_count = cb.exec_count.wrapping_add(1);
                    self.icache_hits += 1;
                    return Ok(16);
                }
            }
            let page = vmm.read_page(page_base)?;
            self.icache_misses += 1;
            buf.copy_from_slice(&page[off..off + 16]);
            self.icache.insert(
                page_base,
                CachedBasicBlock {
                    start_rip: page_base,
                    page_base,
                    page_epoch: cur_epoch,
                    code_window: page.to_vec(),
                    exec_count: 1,
                    jit_checked: false,
                },
            );
            return Ok(16);
        }

        // Cross-page instruction: read first page, then read second page only if resident/committed
        let first_len = 4096 - off;
        vmm.read_bytes(rip, &mut buf[..first_len])?;
        if vmm.find_region(page_base + 4096).is_some() {
            vmm.read_bytes(page_base + 4096, &mut buf[first_len..16])?;
            Ok(16)
        } else {
            Ok(first_len)
        }
    }

    /// Records `rip` in the small history ring used by fault diagnostics.
    pub fn note_rip(&mut self, rip: u64) {
        let slot = self.rip_history_len % self.rip_history.len();
        self.rip_history[slot] = rip;
        self.rip_history_len = self.rip_history_len.wrapping_add(1);
    }

    pub fn render_rip_history(&self) -> String {
        let len = self.rip_history_len.min(self.rip_history.len());
        let mut out = String::new();
        for i in (0..len).rev().take(8) {
            let idx = (self.rip_history_len + self.rip_history.len() - 1 - i) % self.rip_history.len();
            out.push_str(&format!("0x{:x} ", self.rip_history[idx]));
        }
        out.trim_end().to_string()
    }

    pub fn step_one(&mut self, vmm: &mut VirtualMemoryManager) -> Result<ExecOutcome, MemoryTrap> {
        let insn_rip = self.rip;
        self.note_rip(insn_rip);
        let mut buf = [0u8; 16];
        let _avail = self.fetch_insn_bytes(vmm, &mut buf)?;
        let code = &buf[..];
        let mut cursor = 0usize;
        let mut pfx = Prefixes::default();

        // Parse legacy + REX prefixes
        loop {
            let b = code[cursor];
            match b {
                0xF0 => {
                    pfx.lock = true;
                    cursor += 1;
                }
                0xF2 => {
                    pfx.repne_f2 = true;
                    pfx.rep_f3 = false;
                    cursor += 1;
                }
                0xF3 => {
                    pfx.rep_f3 = true;
                    pfx.repne_f2 = false;
                    cursor += 1;
                }
                0x66 => {
                    pfx.osz_66 = true;
                    cursor += 1;
                }
                0x67 => {
                    pfx.asz_67 = true;
                    cursor += 1;
                }
                0x64 | 0x65 => {
                    pfx.seg = b;
                    cursor += 1;
                }
                0x26 | 0x2E | 0x36 | 0x3E => {
                    cursor += 1;
                }
                0x40..=0x4F => {
                    pfx.has_rex = true;
                    pfx.rex_w = (b & 8) != 0;
                    pfx.rex_r = (b & 4) != 0;
                    pfx.rex_x = (b & 2) != 0;
                    pfx.rex_b = (b & 1) != 0;
                    cursor += 1;
                }
                _ => break,
            }
        }

        let op = code[cursor];
        cursor += 1;

        let outcome = match op {
            // VEX 2-byte / 3-byte
            0xC4 | 0xC5 => {
                self.exec_vex(vmm, op, pfx.seg, pfx.asz_67, code, &mut cursor, insn_rip)?
            }

            // x87 FPU escape opcodes
            0xD8..=0xDF => self.exec_x87(vmm, &pfx, op, code, &mut cursor, insn_rip)?,

            // Standard ALU: ADD(00..05), OR(08..0D), ADC(10..15), SBB(18..1D), AND(20..25), SUB(28..2D), XOR(30..35), CMP(38..3D)
            0x00..=0x05
            | 0x08..=0x0D
            | 0x10..=0x15
            | 0x18..=0x1D
            | 0x20..=0x25
            | 0x28..=0x2D
            | 0x30..=0x35
            | 0x38..=0x3D => {
                let alu = op >> 3;
                let kind = op & 7;
                let byte_op = (kind & 1) == 0;
                let sz = Self::operand_size(&pfx, byte_op);
                match kind {
                    0 | 1 => {
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let next_rip = insn_rip + cursor as u64;
                        let lhs = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                        let rhs = self.read_gpr(reg, sz, pfx.has_rex);
                        let res = self.alu_op(alu, lhs, rhs, sz);
                        if alu != 7 {
                            self.write_rm(vmm, addr, next_rip, sz, pfx.has_rex, res)?;
                        }
                    }
                    2 | 3 => {
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let next_rip = insn_rip + cursor as u64;
                        // Special case: xor r, r -> doesn't even fault if reg
                        let lhs = self.read_gpr(reg, sz, pfx.has_rex);
                        let rhs = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                        let res = self.alu_op(alu, lhs, rhs, sz);
                        if alu != 7 {
                            self.write_gpr(reg, sz, pfx.has_rex, res);
                        }
                    }
                    4 | 5 => {
                        let imm_sz = if sz == 8 { 4 } else { sz };
                        let rhs = Self::read_sign_ext_imm(code, &mut cursor, imm_sz);
                        let lhs = self.read_gpr(0, sz, pfx.has_rex);
                        let res = self.alu_op(alu, lhs, rhs, sz);
                        if alu != 7 {
                            self.write_gpr(0, sz, pfx.has_rex, res);
                        }
                    }
                    _ => unreachable!(),
                }
                ExecOutcome::Next
            }

            // PUSH r64 / r16 (50..57)
            0x50..=0x57 => {
                let reg = ((op - 0x50) as usize) | if pfx.rex_b { 8 } else { 0 };
                if pfx.osz_66 && !pfx.rex_w {
                    let val = self.gpr[reg] as u16;
                    let new_rsp = self.gpr[4].wrapping_sub(2);
                    vmm.write_u16(new_rsp, val)?;
                    self.gpr[4] = new_rsp;
                } else {
                    let val = self.gpr[reg];
                    let new_rsp = self.gpr[4].wrapping_sub(8);
                    vmm.write_u64(new_rsp, val)?;
                    self.gpr[4] = new_rsp;
                }
                ExecOutcome::Next
            }

            // POP r64 / r16 (58..5F)
            0x58..=0x5F => {
                let reg = ((op - 0x58) as usize) | if pfx.rex_b { 8 } else { 0 };
                if pfx.osz_66 && !pfx.rex_w {
                    let val = vmm.read_u16(self.gpr[4])?;
                    self.gpr[4] = self.gpr[4].wrapping_add(2);
                    self.write_gpr(reg, 2, pfx.has_rex, val as u64);
                } else {
                    let val = vmm.read_u64(self.gpr[4])?;
                    self.gpr[4] = self.gpr[4].wrapping_add(8);
                    self.gpr[reg] = val;
                }
                ExecOutcome::Next
            }

            // MOVSXD r64, r/m32 (63)
            0x63 => {
                let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                let next_rip = insn_rip + cursor as u64;
                if pfx.rex_w {
                    let v = self.read_rm(vmm, addr, next_rip, 4, pfx.has_rex)? as u32 as i32 as i64 as u64;
                    self.gpr[reg] = v;
                } else {
                    let sz = if pfx.osz_66 { 2 } else { 4 };
                    let v = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                    self.write_gpr(reg, sz, pfx.has_rex, v);
                }
                ExecOutcome::Next
            }

            // PUSH imm32 / imm8 (68, 6A)
            0x68 | 0x6A => {
                let imm = Self::read_sign_ext_imm(code, &mut cursor, if op == 0x6A { 1 } else { 4 });
                let new_rsp = self.gpr[4].wrapping_sub(8);
                vmm.write_u64(new_rsp, imm)?;
                self.gpr[4] = new_rsp;
                ExecOutcome::Next
            }

            // IMUL r, r/m, imm32/imm8 (69, 6B)
            0x69 | 0x6B => {
                let sz = Self::operand_size(&pfx, false);
                let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                let imm_sz = if op == 0x6B { 1 } else if sz == 2 { 2 } else { 4 };
                let imm = Self::read_sign_ext_imm(code, &mut cursor, imm_sz) as i64;
                let next_rip = insn_rip + cursor as u64;
                let src_raw = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                let (res, ovf) = match sz {
                    2 => {
                        let p = (src_raw as u16 as i16 as i64) * (imm as i16 as i64);
                        (p as u64, p < i16::MIN as i64 || p > i16::MAX as i64)
                    }
                    4 => {
                        let p = (src_raw as u32 as i32 as i64) * (imm as i32 as i64);
                        (p as u32 as u64, p < i32::MIN as i64 || p > i32::MAX as i64)
                    }
                    8 => {
                        let p = (src_raw as i64 as i128) * (imm as i128);
                        (p as u64, p < i64::MIN as i128 || p > i64::MAX as i128)
                    }
                    _ => unreachable!(),
                };
                self.rflags = (self.rflags & !(CF | OF)) | if ovf { CF | OF } else { 0 };
                self.write_gpr(reg, sz, pfx.has_rex, res);
                ExecOutcome::Next
            }

            // Jcc rel8 (70..7F)
            0x70..=0x7F => {
                let disp = code[cursor] as i8 as i64;
                cursor += 1;
                if self.eval_cc(op - 0x70) {
                    let target = (insn_rip + cursor as u64).wrapping_add(disp as u64);
                    ExecOutcome::Branch(target)
                } else {
                    ExecOutcome::Next
                }
            }

            // Group 1 immediate ALU: 80 / 81 / 83
            0x80 | 0x81 | 0x82 | 0x83 => {
                let byte_op = op == 0x80 || op == 0x82;
                let sz = Self::operand_size(&pfx, byte_op);
                let (_m, reg_ext, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                let alu = (reg_ext & 7) as u8;
                let imm_sz = if op == 0x83 || byte_op {
                    1
                } else if sz == 2 {
                    2
                } else {
                    4
                };
                let rhs = Self::read_sign_ext_imm(code, &mut cursor, imm_sz);
                let next_rip = insn_rip + cursor as u64;
                let lhs = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                let res = self.alu_op(alu, lhs, rhs, sz);
                if alu != 7 {
                    self.write_rm(vmm, addr, next_rip, sz, pfx.has_rex, res)?;
                }
                ExecOutcome::Next
            }

            // TEST r/m, r (84, 85)
            0x84 | 0x85 => {
                let sz = Self::operand_size(&pfx, op == 0x84);
                let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                let next_rip = insn_rip + cursor as u64;
                let a = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                let b = self.read_gpr(reg, sz, pfx.has_rex);
                let _ = self.alu_op(4, a, b, sz);
                ExecOutcome::Next
            }

            // XCHG r/m, r (86, 87)
            0x86 | 0x87 => {
                let sz = Self::operand_size(&pfx, op == 0x86);
                let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                let next_rip = insn_rip + cursor as u64;
                let a = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                let b = self.read_gpr(reg, sz, pfx.has_rex);
                self.write_rm(vmm, addr, next_rip, sz, pfx.has_rex, b)?;
                self.write_gpr(reg, sz, pfx.has_rex, a);
                ExecOutcome::Next
            }

            // MOV r/m, r (88, 89) & MOV r, r/m (8A, 8B)
            0x88..=0x8B => {
                let sz = Self::operand_size(&pfx, (op & 1) == 0);
                let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                let next_rip = insn_rip + cursor as u64;
                if (op & 2) == 0 {
                    let v = self.read_gpr(reg, sz, pfx.has_rex);
                    self.write_rm(vmm, addr, next_rip, sz, pfx.has_rex, v)?;
                } else {
                    let v = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                    self.write_gpr(reg, sz, pfx.has_rex, v);
                }
                ExecOutcome::Next
            }

            // LEA r, m (8D)
            0x8D => {
                let sz = Self::operand_size(&pfx, false);
                let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                let next_rip = insn_rip + cursor as u64;
                // Note: LEA ignores segment override
                let raw_ea = match addr {
                    Addressing::Abs(ea) => ea.wrapping_sub(self.seg_base(&pfx)),
                    Addressing::RipRel { disp, asz_67, .. } => {
                        let e = next_rip.wrapping_add(disp as i64 as u64);
                        if asz_67 { e & 0xFFFF_FFFF } else { e }
                    }
                    Addressing::Reg(_) => 0,
                };
                self.write_gpr(reg, sz, pfx.has_rex, raw_ea);
                ExecOutcome::Next
            }

            // POP r/m64 (8F /0)
            0x8F => {
                let (_m, _reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                let next_rip = insn_rip + cursor as u64;
                let val = vmm.read_u64(self.gpr[4])?;
                let old_rsp = self.gpr[4];
                self.gpr[4] = old_rsp.wrapping_add(8);
                if let Err(trap) = self.write_rm(vmm, addr, next_rip, 8, pfx.has_rex, val) {
                    self.gpr[4] = old_rsp;
                    return Err(trap);
                }
                ExecOutcome::Next
            }

            // NOP / PAUSE / XCHG RAX, r (90..97)
            0x90..=0x97 => {
                let reg = ((op - 0x90) as usize) | if pfx.rex_b { 8 } else { 0 };
                if reg != 0 {
                    let sz = Self::operand_size(&pfx, false);
                    let a = self.read_gpr(0, sz, pfx.has_rex);
                    let b = self.read_gpr(reg, sz, pfx.has_rex);
                    self.write_gpr(0, sz, pfx.has_rex, b);
                    self.write_gpr(reg, sz, pfx.has_rex, a);
                }
                ExecOutcome::Next
            }

            // CBW / CWDE / CDQE (98)
            0x98 => {
                if pfx.rex_w {
                    self.gpr[0] = (self.gpr[0] as u32 as i32 as i64) as u64;
                } else if pfx.osz_66 {
                    let v = (self.gpr[0] as u8 as i8 as i16) as u16;
                    self.write_gpr(0, 2, pfx.has_rex, v as u64);
                } else {
                    self.gpr[0] = (self.gpr[0] as u16 as i16 as i32 as u32) as u64;
                }
                ExecOutcome::Next
            }

            // CWD / CDQ / CQO (99)
            0x99 => {
                if pfx.rex_w {
                    self.gpr[2] = if (self.gpr[0] as i64) < 0 { u64::MAX } else { 0 };
                } else if pfx.osz_66 {
                    let d = if (self.gpr[0] as u16 as i16) < 0 { 0xFFFF } else { 0 };
                    self.write_gpr(2, 2, pfx.has_rex, d);
                } else {
                    self.gpr[2] = if (self.gpr[0] as u32 as i32) < 0 {
                        0xFFFF_FFFF
                    } else {
                        0
                    };
                }
                ExecOutcome::Next
            }

            // PUSHFQ / POPFQ / SAHF / LAHF (9C..9F)
            0x9C => {
                let new_rsp = self.gpr[4].wrapping_sub(8);
                vmm.write_u64(new_rsp, self.rflags | 2)?;
                self.gpr[4] = new_rsp;
                ExecOutcome::Next
            }
            0x9D => {
                let f = vmm.read_u64(self.gpr[4])?;
                self.gpr[4] = self.gpr[4].wrapping_add(8);
                self.rflags = (f & 0x0025_7FD5) | 0x0202;
                ExecOutcome::Next
            }
            0x9E => {
                let ah = (self.gpr[0] >> 8) & 0xD5;
                self.rflags = (self.rflags & !0xD5) | ah | 2;
                ExecOutcome::Next
            }
            0x9F => {
                let flags_low = (self.rflags & 0xD5) | 2;
                self.gpr[0] = (self.gpr[0] & !0xFF00) | (flags_low << 8);
                ExecOutcome::Next
            }

            // MOV AL/AX/EAX/RAX, moffs64 (A0..A3)
            0xA0..=0xA3 => {
                let sz = Self::operand_size(&pfx, (op & 1) == 0);
                let moffs = if pfx.asz_67 {
                    let a = u32::from_le_bytes(code[cursor..cursor + 4].try_into().unwrap()) as u64;
                    cursor += 4;
                    a
                } else {
                    let a = u64::from_le_bytes(code[cursor..cursor + 8].try_into().unwrap());
                    cursor += 8;
                    a
                };
                let ea = self.seg_base(&pfx).wrapping_add(moffs);
                if op <= 0xA1 {
                    let v = match sz {
                        1 => vmm.read_u8(ea)? as u64,
                        2 => vmm.read_u16(ea)? as u64,
                        4 => vmm.read_u32(ea)? as u64,
                        8 => vmm.read_u64(ea)?,
                        _ => unreachable!(),
                    };
                    self.write_gpr(0, sz, pfx.has_rex, v);
                } else {
                    let v = self.read_gpr(0, sz, pfx.has_rex);
                    match sz {
                        1 => vmm.write_u8(ea, v as u8)?,
                        2 => vmm.write_u16(ea, v as u16)?,
                        4 => vmm.write_u32(ea, v as u32)?,
                        8 => vmm.write_u64(ea, v)?,
                        _ => unreachable!(),
                    }
                }
                ExecOutcome::Next
            }

            // String instructions & TEST AL/RAX, imm: MOVS (A4,A5), CMPS (A6,A7), TEST (A8,A9), STOS (AA,AB), LODS (AC,AD), SCAS (AE,AF)
            0xA4..=0xAF => {
                if op == 0xA8 || op == 0xA9 {
                    // TEST AL/EAX/RAX, imm
                    let sz = Self::operand_size(&pfx, op == 0xA8);
                    let imm_sz = if sz == 8 { 4 } else { sz };
                    let rhs = Self::read_sign_ext_imm(code, &mut cursor, imm_sz);
                    let lhs = self.read_gpr(0, sz, pfx.has_rex);
                    let _ = self.alu_op(4, lhs, rhs, sz);
                } else {
                    let sz = Self::operand_size(&pfx, (op & 1) == 0);
                    let step: i64 = if (self.rflags & DF) != 0 {
                        -(sz as i64)
                    } else {
                        sz as i64
                    };
                    let has_rep = pfx.rep_f3 || pfx.repne_f2;
                    let is_cmps_scas = op == 0xA6 || op == 0xA7 || op == 0xAE || op == 0xAF;

                    let exec_single = |cpu: &mut Self, vmm: &mut VirtualMemoryManager| -> Result<(), MemoryTrap> {
                        let rsi = cpu.gpr[6];
                        let rdi = cpu.gpr[7];
                        match op & 0xFE {
                            0xA4 => {
                                let mut tmp = [0u8; 8];
                                vmm.read_bytes(rsi, &mut tmp[..sz])?;
                                vmm.write_bytes(rdi, &tmp[..sz])?;
                                cpu.gpr[6] = rsi.wrapping_add(step as u64);
                                cpu.gpr[7] = rdi.wrapping_add(step as u64);
                            }
                            0xAA => {
                                let v = cpu.read_gpr(0, sz, pfx.has_rex).to_le_bytes();
                                vmm.write_bytes(rdi, &v[..sz])?;
                                cpu.gpr[7] = rdi.wrapping_add(step as u64);
                            }
                            0xAC => {
                                let mut tmp = [0u8; 8];
                                vmm.read_bytes(rsi, &mut tmp[..sz])?;
                                let v = u64::from_le_bytes(tmp);
                                cpu.write_gpr(0, sz, pfx.has_rex, v);
                                cpu.gpr[6] = rsi.wrapping_add(step as u64);
                            }
                            0xA6 => {
                                let mut a = [0u8; 8];
                                let mut b = [0u8; 8];
                                vmm.read_bytes(rsi, &mut a[..sz])?;
                                vmm.read_bytes(rdi, &mut b[..sz])?;
                                let _ = cpu.alu_op(7, u64::from_le_bytes(a), u64::from_le_bytes(b), sz);
                                cpu.gpr[6] = rsi.wrapping_add(step as u64);
                                cpu.gpr[7] = rdi.wrapping_add(step as u64);
                            }
                            0xAE => {
                                let mut b = [0u8; 8];
                                vmm.read_bytes(rdi, &mut b[..sz])?;
                                let a = cpu.read_gpr(0, sz, pfx.has_rex);
                                let _ = cpu.alu_op(7, a, u64::from_le_bytes(b), sz);
                                cpu.gpr[7] = rdi.wrapping_add(step as u64);
                            }
                            _ => unreachable!(),
                        }
                        Ok(())
                    };

                    if !has_rep {
                        exec_single(self, vmm)?;
                    } else {
                        while self.gpr[1] != 0 {
                            exec_single(self, vmm)?;
                            self.gpr[1] = self.gpr[1].wrapping_sub(1);
                            if is_cmps_scas {
                                let zf = (self.rflags & ZF) != 0;
                                if pfx.rep_f3 && !zf {
                                    break;
                                }
                                if pfx.repne_f2 && zf {
                                    break;
                                }
                            }
                        }
                    }
                }
                ExecOutcome::Next
            }

            // MOV r8, imm8 (B0..B7)
            0xB0..=0xB7 => {
                let reg = ((op - 0xB0) as usize) | if pfx.rex_b { 8 } else { 0 };
                let imm = code[cursor] as u64;
                cursor += 1;
                self.write_gpr(reg, 1, pfx.has_rex, imm);
                ExecOutcome::Next
            }

            // MOV r16/32/64, imm16/32/64 (B8..BF)
            0xB8..=0xBF => {
                let reg = ((op - 0xB8) as usize) | if pfx.rex_b { 8 } else { 0 };
                let sz = Self::operand_size(&pfx, false);
                let val = match sz {
                    2 => {
                        let v = u16::from_le_bytes(code[cursor..cursor + 2].try_into().unwrap()) as u64;
                        cursor += 2;
                        v
                    }
                    4 => {
                        let v = u32::from_le_bytes(code[cursor..cursor + 4].try_into().unwrap()) as u64;
                        cursor += 4;
                        v
                    }
                    8 => {
                        let v = u64::from_le_bytes(code[cursor..cursor + 8].try_into().unwrap());
                        cursor += 8;
                        v
                    }
                    _ => unreachable!(),
                };
                self.write_gpr(reg, sz, pfx.has_rex, val);
                ExecOutcome::Next
            }

            // Shift Group 2: C0, C1, D0, D1, D2, D3
            0xC0 | 0xC1 | 0xD0..=0xD3 => {
                let byte_op = (op & 1) == 0;
                let sz = Self::operand_size(&pfx, byte_op);
                let (_m, reg_ext, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                let subop = (reg_ext & 7) as u8;
                let cnt = match op {
                    0xC0 | 0xC1 => {
                        let c = code[cursor];
                        cursor += 1;
                        c
                    }
                    0xD0 | 0xD1 => 1,
                    0xD2 | 0xD3 => self.gpr[1] as u8,
                    _ => unreachable!(),
                };
                let next_rip = insn_rip + cursor as u64;
                let val = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                let res = self.shift_op(subop, val, cnt, sz);
                self.write_rm(vmm, addr, next_rip, sz, pfx.has_rex, res)?;
                ExecOutcome::Next
            }

            // RET imm16 (C2) / RET (C3)
            0xC2 => {
                let pop_bytes = u16::from_le_bytes(code[cursor..cursor + 2].try_into().unwrap()) as u64;
                cursor += 2;
                let ret_rip = vmm.read_u64(self.gpr[4])?;
                self.gpr[4] = self.gpr[4].wrapping_add(8 + pop_bytes);
                ExecOutcome::Branch(ret_rip)
            }
            0xC3 => {
                let ret_rip = vmm.read_u64(self.gpr[4])?;
                self.gpr[4] = self.gpr[4].wrapping_add(8);
                ExecOutcome::Branch(ret_rip)
            }

            // MOV r/m, imm (C6, C7)
            0xC6 | 0xC7 => {
                let sz = Self::operand_size(&pfx, op == 0xC6);
                let (_m, _reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                let imm_sz = if sz == 8 { 4 } else { sz };
                let val = Self::read_sign_ext_imm(code, &mut cursor, imm_sz);
                let next_rip = insn_rip + cursor as u64;
                self.write_rm(vmm, addr, next_rip, sz, pfx.has_rex, val)?;
                ExecOutcome::Next
            }

            // LEAVE (C9)
            0xC9 => {
                let rbp = self.gpr[5];
                let saved_rbp = vmm.read_u64(rbp)?;
                self.gpr[4] = rbp.wrapping_add(8);
                self.gpr[5] = saved_rbp;
                ExecOutcome::Next
            }

            // INT3 (CC) and INT imm8 (CD). Debug-service INT 2D raises a breakpoint
            // exception; the handler sees RIP after the two-byte instruction.
            0xCC => ExecOutcome::Fault(format!("INT3 breakpoint at 0x{insn_rip:x}")),
            0xCD => {
                let vector = code[cursor]; cursor += 1;
                ExecOutcome::Fault(format!("INT 0x{vector:02x} at 0x{insn_rip:x}"))
            }

            // CALL rel32 (E8)
            0xE8 => {
                let rel = i32::from_le_bytes(code[cursor..cursor + 4].try_into().unwrap()) as i64;
                cursor += 4;
                let next_rip = insn_rip + cursor as u64;
                let target = next_rip.wrapping_add(rel as u64);
                let new_rsp = self.gpr[4].wrapping_sub(8);
                vmm.write_u64(new_rsp, next_rip)?;
                self.gpr[4] = new_rsp;
                ExecOutcome::Branch(target)
            }

            // JMP rel32 (E9) / JMP rel8 (EB)
            0xE9 => {
                let rel = i32::from_le_bytes(code[cursor..cursor + 4].try_into().unwrap()) as i64;
                cursor += 4;
                let target = (insn_rip + cursor as u64).wrapping_add(rel as u64);
                ExecOutcome::Branch(target)
            }
            0xEB => {
                let rel = code[cursor] as i8 as i64;
                cursor += 1;
                let target = (insn_rip + cursor as u64).wrapping_add(rel as u64);
                ExecOutcome::Branch(target)
            }

            //CMC / CLC / STC / CLD / STD (F5, F8, F9, FC, FD)
            0xF5 => {
                self.rflags ^= CF;
                ExecOutcome::Next
            }
            0xF8 => {
                self.rflags &= !CF;
                ExecOutcome::Next
            }
            0xF9 => {
                self.rflags |= CF;
                ExecOutcome::Next
            }
            0xFC => {
                self.rflags &= !DF;
                ExecOutcome::Next
            }
            0xFD => {
                self.rflags |= DF;
                ExecOutcome::Next
            }

            // Unary Group 3: F6 / F7 (TEST, NOT, NEG, MUL, IMUL, DIV, IDIV)
            0xF6 | 0xF7 => {
                let byte_op = op == 0xF6;
                let sz = Self::operand_size(&pfx, byte_op);
                let (_m, reg_ext, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                let subop = reg_ext & 7;
                if subop == 0 || subop == 1 {
                    let imm_sz = if sz == 8 { 4 } else { sz };
                    let imm = Self::read_sign_ext_imm(code, &mut cursor, imm_sz);
                    let next_rip = insn_rip + cursor as u64;
                    let lhs = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                    let _ = self.alu_op(4, lhs, imm, sz);
                } else {
                    let next_rip = insn_rip + cursor as u64;
                    let v = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                    match subop {
                        2 => {
                            let res = (!v) & Self::mask_for_size(sz);
                            self.write_rm(vmm, addr, next_rip, sz, pfx.has_rex, res)?;
                        }
                        3 => {
                            let res = self.alu_op(5, 0, v, sz);
                            self.write_rm(vmm, addr, next_rip, sz, pfx.has_rex, res)?;
                        }
                        4 => {
                            // MUL unsigned
                            match sz {
                                1 => {
                                    let p = (self.gpr[0] & 0xFF) * (v & 0xFF);
                                    self.write_gpr(0, 2, pfx.has_rex, p);
                                    let ovf = (p >> 8) != 0;
                                    self.rflags = (self.rflags & !(CF | OF)) | if ovf { CF | OF } else { 0 };
                                }
                                2 => {
                                    let p = (self.gpr[0] & 0xFFFF) * (v & 0xFFFF);
                                    self.write_gpr(0, 2, pfx.has_rex, p);
                                    self.write_gpr(2, 2, pfx.has_rex, p >> 16);
                                    let ovf = (p >> 16) != 0;
                                    self.rflags = (self.rflags & !(CF | OF)) | if ovf { CF | OF } else { 0 };
                                }
                                4 => {
                                    let p = (self.gpr[0] & 0xFFFF_FFFF) * (v & 0xFFFF_FFFF);
                                    self.gpr[0] = p & 0xFFFF_FFFF;
                                    self.gpr[2] = (p >> 32) & 0xFFFF_FFFF;
                                    let ovf = (p >> 32) != 0;
                                    self.rflags = (self.rflags & !(CF | OF)) | if ovf { CF | OF } else { 0 };
                                }
                                8 => {
                                    let p = (self.gpr[0] as u128) * (v as u128);
                                    self.gpr[0] = p as u64;
                                    self.gpr[2] = (p >> 64) as u64;
                                    let ovf = (p >> 64) != 0;
                                    self.rflags = (self.rflags & !(CF | OF)) | if ovf { CF | OF } else { 0 };
                                }
                                _ => unreachable!(),
                            }
                        }
                        5 => {
                            // IMUL signed 1-operand
                            match sz {
                                1 => {
                                    let p = (self.gpr[0] as u8 as i8 as i16) * (v as u8 as i8 as i16);
                                    self.write_gpr(0, 2, pfx.has_rex, p as u16 as u64);
                                    let ovf = p != (p as i8 as i16);
                                    self.rflags = (self.rflags & !(CF | OF)) | if ovf { CF | OF } else { 0 };
                                }
                                2 => {
                                    let p = (self.gpr[0] as u16 as i16 as i32) * (v as u16 as i16 as i32);
                                    self.write_gpr(0, 2, pfx.has_rex, (p as u16) as u64);
                                    self.write_gpr(2, 2, pfx.has_rex, ((p >> 16) as u16) as u64);
                                    let ovf = p != (p as i16 as i32);
                                    self.rflags = (self.rflags & !(CF | OF)) | if ovf { CF | OF } else { 0 };
                                }
                                4 => {
                                    let p = (self.gpr[0] as u32 as i32 as i64) * (v as u32 as i32 as i64);
                                    self.gpr[0] = (p as u32) as u64;
                                    self.gpr[2] = ((p >> 32) as u32) as u64;
                                    let ovf = p != (p as i32 as i64);
                                    self.rflags = (self.rflags & !(CF | OF)) | if ovf { CF | OF } else { 0 };
                                }
                                8 => {
                                    let p = (self.gpr[0] as i64 as i128) * (v as i64 as i128);
                                    self.gpr[0] = p as u64;
                                    self.gpr[2] = (p >> 64) as u64;
                                    let ovf = p != (p as i64 as i128);
                                    self.rflags = (self.rflags & !(CF | OF)) | if ovf { CF | OF } else { 0 };
                                }
                                _ => unreachable!(),
                            }
                        }
                        6 => {
                            // DIV unsigned
                            if v == 0 {
                                return Ok(ExecOutcome::Fault("Divide by zero".to_string()));
                            }
                            match sz {
                                1 => {
                                    let num = self.gpr[0] & 0xFFFF;
                                    let q = num / v;
                                    let r = num % v;
                                    self.write_gpr(0, 2, pfx.has_rex, (r << 8) | (q & 0xFF));
                                }
                                2 => {
                                    let num = ((self.gpr[2] & 0xFFFF) << 16) | (self.gpr[0] & 0xFFFF);
                                    self.write_gpr(0, 2, pfx.has_rex, num / v);
                                    self.write_gpr(2, 2, pfx.has_rex, num % v);
                                }
                                4 => {
                                    let num = ((self.gpr[2] & 0xFFFF_FFFF) << 32) | (self.gpr[0] & 0xFFFF_FFFF);
                                    self.gpr[0] = (num / v) & 0xFFFF_FFFF;
                                    self.gpr[2] = (num % v) & 0xFFFF_FFFF;
                                }
                                8 => {
                                    let num = ((self.gpr[2] as u128) << 64) | (self.gpr[0] as u128);
                                    let den = v as u128;
                                    self.gpr[0] = (num / den) as u64;
                                    self.gpr[2] = (num % den) as u64;
                                }
                                _ => unreachable!(),
                            }
                        }
                        7 => {
                            // IDIV signed
                            if v == 0 {
                                return Ok(ExecOutcome::Fault("Signed divide by zero".to_string()));
                            }
                            match sz {
                                1 => {
                                    let num = self.gpr[0] as u16 as i16;
                                    let den = v as u8 as i8 as i16;
                                    let q = (num / den) as i8 as u8 as u64;
                                    let r = (num % den) as i8 as u8 as u64;
                                    self.write_gpr(0, 2, pfx.has_rex, (r << 8) | q);
                                }
                                2 => {
                                    let num = (((self.gpr[2] & 0xFFFF) << 16) | (self.gpr[0] & 0xFFFF)) as u32 as i32;
                                    let den = v as u16 as i16 as i32;
                                    self.write_gpr(0, 2, pfx.has_rex, (num / den) as i16 as u16 as u64);
                                    self.write_gpr(2, 2, pfx.has_rex, (num % den) as i16 as u16 as u64);
                                }
                                4 => {
                                    let num = (((self.gpr[2] & 0xFFFF_FFFF) << 32) | (self.gpr[0] & 0xFFFF_FFFF)) as i64;
                                    let den = v as u32 as i32 as i64;
                                    self.gpr[0] = ((num / den) as i32 as u32) as u64;
                                    self.gpr[2] = ((num % den) as i32 as u32) as u64;
                                }
                                8 => {
                                    let num = (((self.gpr[2] as u128) << 64) | (self.gpr[0] as u128)) as i128;
                                    let den = v as i64 as i128;
                                    self.gpr[0] = (num / den) as i64 as u64;
                                    self.gpr[2] = (num % den) as i64 as u64;
                                }
                                _ => unreachable!(),
                            }
                        }
                        _ => {}
                    }
                }
                ExecOutcome::Next
            }

            // Group 4 / 5: FE / FF (INC, DEC, CALL r/m64, JMP r/m64, PUSH r/m64)
            0xFE | 0xFF => {
                let byte_op = op == 0xFE;
                let sz = Self::operand_size(&pfx, byte_op);
                let (_m, reg_ext, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                let subop = reg_ext & 7;
                let next_rip = insn_rip + cursor as u64;
                match subop {
                    0 | 1 => {
                        let old_cf = self.rflags & CF;
                        let v = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                        let res = self.alu_op(if subop == 0 { 0 } else { 5 }, v, 1, sz);
                        self.rflags = (self.rflags & !CF) | old_cf;
                        self.write_rm(vmm, addr, next_rip, sz, pfx.has_rex, res)?;
                        ExecOutcome::Next
                    }
                    2 if !byte_op => {
                        // CALL r/m64
                        let target = self.read_rm(vmm, addr, next_rip, 8, pfx.has_rex)?;
                        let new_rsp = self.gpr[4].wrapping_sub(8);
                        vmm.write_u64(new_rsp, next_rip)?;
                        self.gpr[4] = new_rsp;
                        ExecOutcome::Branch(target)
                    }
                    4 if !byte_op => {
                        // JMP r/m64
                        let target = self.read_rm(vmm, addr, next_rip, 8, pfx.has_rex)?;
                        ExecOutcome::Branch(target)
                    }
                    6 if !byte_op => {
                        // PUSH r/m64
                        let v = self.read_rm(vmm, addr, next_rip, 8, pfx.has_rex)?;
                        let new_rsp = self.gpr[4].wrapping_sub(8);
                        vmm.write_u64(new_rsp, v)?;
                        self.gpr[4] = new_rsp;
                        ExecOutcome::Next
                    }
                    _ => ExecOutcome::Fault(format!("Unimplemented FF/{subop} at 0x{insn_rip:x}")),
                }
            }

            // Two-byte 0x0F escape
            0x0F => {
                let op2 = code[cursor];
                cursor += 1;
                match op2 {
                    // XGETBV (0F 01 D0)
                    0x01 if code[cursor] == 0xD0 => {
                        cursor += 1;
                        self.gpr[0] = 0x07; // X87 + SSE + AVX state enabled
                        self.gpr[2] = 0;
                        ExecOutcome::Next
                    }
                    // UD2
                    0x0B => ExecOutcome::Fault(format!("UD2 at 0x{insn_rip:x}")),
                    // Multi-byte NOP / ENDBR64 (0F 18..1F)
                    0x18..=0x1F => {
                        let _ = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        ExecOutcome::Next
                    }
                    // RDTSC (0F 31)
                    0x31 => {
                        let tsc = self.instructions_executed.wrapping_mul(32) + 0x1000_0000;
                        self.gpr[0] = tsc & 0xFFFF_FFFF;
                        self.gpr[2] = (tsc >> 32) & 0xFFFF_FFFF;
                        ExecOutcome::Next
                    }
                    // Three-byte 0F 38 / 0F 3A legacy SSE3/SSSE3/SSE4
                    0x38 => {
                        let op3 = code[cursor];
                        cursor += 1;
                        // CRC32 (F2 0F 38 F0/F1) and MOVBE (0F 38 F0/F1) use integer operands,
                        // not XMM registers, so they are decoded before the XMM path below.
                        // 7-Zip's hardware CRC32 path (selected when CPUID advertises SSE4.2)
                        // faulted here as "Unimplemented 0F 38 0xf1".
                        if matches!(op3, 0xF0 | 0xF1) {
                            let (_m2, reg2, _rm2, addr2) =
                                self.decode_modrm_addressing(&pfx, code, &mut cursor);
                            let next_rip2 = insn_rip + cursor as u64;
                            if pfx.repne_f2 {
                                // CRC32 r/m: F0 => byte source, F1 => operand-size source.
                                let dest_sz = if pfx.rex_w { 8 } else { 4 };
                                let src_sz = if op3 == 0xF0 {
                                    1
                                } else {
                                    Self::operand_size(&pfx, false)
                                };
                                let src = self.read_rm(vmm, addr2, next_rip2, src_sz, pfx.has_rex)?;
                                let mut crc = self.gpr[reg2] as u32;
                                for i in 0..src_sz {
                                    let b = ((src >> (i * 8)) & 0xFF) as u8;
                                    crc ^= b as u32;
                                    for _ in 0..8 {
                                        crc = if crc & 1 != 0 {
                                            (crc >> 1) ^ 0x82F6_3B78
                                        } else {
                                            crc >> 1
                                        };
                                    }
                                }
                                self.write_gpr(reg2, dest_sz, pfx.has_rex, crc as u64);
                            } else {
                                // MOVBE: F0 loads with byte swap, F1 stores with byte swap.
                                let sz = Self::operand_size(&pfx, false);
                                if op3 == 0xF0 {
                                    let raw = self.read_rm(vmm, addr2, next_rip2, sz, pfx.has_rex)?;
                                    let swapped = match sz {
                                        2 => (raw as u16).swap_bytes() as u64,
                                        4 => (raw as u32).swap_bytes() as u64,
                                        _ => raw.swap_bytes(),
                                    };
                                    self.write_gpr(reg2, sz, pfx.has_rex, swapped);
                                } else {
                                    let raw = self.read_gpr(reg2, sz, pfx.has_rex);
                                    let swapped = match sz {
                                        2 => (raw as u16).swap_bytes() as u64,
                                        4 => (raw as u32).swap_bytes() as u64,
                                        _ => raw.swap_bytes(),
                                    };
                                    self.write_rm(vmm, addr2, next_rip2, sz, pfx.has_rex, swapped)?;
                                }
                            }
                            return Ok(ExecOutcome::Next);
                        }
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let next_rip = insn_rip + cursor as u64;
                        let a = self.get_xmm(reg);
                        let b = match addr {
                            Addressing::Reg(r) => self.get_xmm(r),
                            _ => vmm.read_u128(self.resolve_ea(addr, next_rip))?,
                        };
                        let mut out = [0u8; 16];
                        match op3 {
                            0x00 => {
                                // pshufb
                                for i in 0..16 {
                                    out[i] = if (b[i] & 0x80) != 0 {
                                        0
                                    } else {
                                        a[(b[i] & 0x0F) as usize]
                                    };
                                }
                            }
                            0x40 => {
                                // pmulld
                                for i in 0..4 {
                                    let x = i32::from_le_bytes(a[i * 4..i * 4 + 4].try_into().unwrap());
                                    let y = i32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
                                    out[i * 4..i * 4 + 4].copy_from_slice(&x.wrapping_mul(y).to_le_bytes());
                                }
                            }
                            _ => {
                                return Ok(ExecOutcome::Fault(format!(
                                    "Unimplemented 0F 38 0x{op3:02x} at 0x{insn_rip:x}"
                                )));
                            }
                        }
                        self.set_xmm_preserve_upper(reg, &out);
                        ExecOutcome::Next
                    }
                    0x3A => {
                        let op3 = code[cursor];
                        cursor += 1;
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let imm = code[cursor];
                        cursor += 1;
                        let next_rip = insn_rip + cursor as u64;
                        match op3 {
                            0x0F => {
                                // palignr
                                let a = self.get_xmm(reg);
                                let b = match addr {
                                    Addressing::Reg(r) => self.get_xmm(r),
                                    _ => vmm.read_u128(self.resolve_ea(addr, next_rip))?,
                                };
                                let mut concat = [0u8; 32];
                                concat[0..16].copy_from_slice(&b);
                                concat[16..32].copy_from_slice(&a);
                                let mut out = [0u8; 16];
                                let shift = imm as usize;
                                for i in 0..16 {
                                    if shift + i < 32 {
                                        out[i] = concat[shift + i];
                                    }
                                }
                                self.set_xmm_preserve_upper(reg, &out);
                            }
                            0x15 => {
                                // pextrw r/m16, xmm, imm8
                                let src = self.get_xmm(reg);
                                let lane = (imm & 7) as usize;
                                let w = u16::from_le_bytes(src[lane * 2..lane * 2 + 2].try_into().unwrap());
                                match addr {
                                    Addressing::Reg(r) => self.gpr[r] = w as u64,
                                    _ => vmm.write_u16(self.resolve_ea(addr, next_rip), w)?,
                                }
                            }
                            0x16 => {
                                // pextrd / pextrq
                                let src = self.get_xmm(reg);
                                if pfx.rex_w {
                                    let lane = (imm & 1) as usize;
                                    let q = u64::from_le_bytes(src[lane * 8..lane * 8 + 8].try_into().unwrap());
                                    self.write_rm(vmm, addr, next_rip, 8, pfx.has_rex, q)?;
                                } else {
                                    let lane = (imm & 3) as usize;
                                    let d = u32::from_le_bytes(src[lane * 4..lane * 4 + 4].try_into().unwrap());
                                    self.write_rm(vmm, addr, next_rip, 4, pfx.has_rex, d as u64)?;
                                }
                            }
                            0x22 => {
                                // pinsrd / pinsrq
                                let mut dst = self.get_xmm(reg);
                                if pfx.rex_w {
                                    let lane = (imm & 1) as usize;
                                    let q = self.read_rm(vmm, addr, next_rip, 8, pfx.has_rex)?;
                                    dst[lane * 8..lane * 8 + 8].copy_from_slice(&q.to_le_bytes());
                                } else {
                                    let lane = (imm & 3) as usize;
                                    let d = self.read_rm(vmm, addr, next_rip, 4, pfx.has_rex)? as u32;
                                    dst[lane * 4..lane * 4 + 4].copy_from_slice(&d.to_le_bytes());
                                }
                                self.set_xmm_preserve_upper(reg, &dst);
                            }
                            _ => {
                                return Ok(ExecOutcome::Fault(format!(
                                    "Unimplemented 0F 3A 0x{op3:02x} at 0x{insn_rip:x}"
                                )));
                            }
                        }
                        ExecOutcome::Next
                    }
                    // CMOVcc (0F 40..4F)
                    0x40..=0x4F => {
                        let sz = Self::operand_size(&pfx, false);
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let next_rip = insn_rip + cursor as u64;
                        let val = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                        if self.eval_cc(op2 - 0x40) {
                            self.write_gpr(reg, sz, pfx.has_rex, val);
                        } else if sz == 4 {
                            // CRITICAL x86-64 architectural rule: 32-bit CMOVcc ALWAYS zero-extends upper 32 bits even when false!
                            self.gpr[reg] &= 0xFFFF_FFFF;
                        }
                        ExecOutcome::Next
                    }
                    // Jcc rel32 (0F 80..8F)
                    0x80..=0x8F => {
                        let rel = i32::from_le_bytes(code[cursor..cursor + 4].try_into().unwrap()) as i64;
                        cursor += 4;
                        if self.eval_cc(op2 - 0x80) {
                            let target = (insn_rip + cursor as u64).wrapping_add(rel as u64);
                            ExecOutcome::Branch(target)
                        } else {
                            ExecOutcome::Next
                        }
                    }
                    // SETcc r/m8 (0F 90..9F)
                    0x90..=0x9F => {
                        let (_m, _reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let next_rip = insn_rip + cursor as u64;
                        let v = if self.eval_cc(op2 - 0x90) { 1u64 } else { 0u64 };
                        self.write_rm(vmm, addr, next_rip, 1, pfx.has_rex, v)?;
                        ExecOutcome::Next
                    }
                    // CPUID (0F A2)
                    0xA2 => {
                        let leaf = self.gpr[0] as u32;
                        let subleaf = self.gpr[1] as u32;
                        match leaf {
                            0 => {
                                self.gpr[0] = 7;
                                self.gpr[3] = u32::from_le_bytes(*b"Genu") as u64;
                                self.gpr[2] = u32::from_le_bytes(*b"ineI") as u64;
                                self.gpr[1] = u32::from_le_bytes(*b"ntel") as u64;
                            }
                            1 => {
                                self.gpr[0] = 0x0003_06C3; // Haswell family/model
                                self.gpr[3] = 0x0001_0800;
                                // ECX: SSE3(0) | SSSE3(9) | FMA(12) | CMPXCHG16B(13) | SSE4.1(19) | SSE4.2(20) | POPCNT(23) | XSAVE(26) | OSXSAVE(27) | AVX(28)
                                self.gpr[1] = (1 << 0)
                                    | (1 << 9)
                                    | (1 << 12)
                                    | (1 << 13)
                                    | (1 << 19)
                                    | (1 << 20)
                                    | (1 << 23)
                                    | (1 << 26)
                                    | (1 << 27)
                                    | (1 << 28);
                                // EDX: FPU(0) | TSC(4) | CMOV(15) | MMX(23) | FXSR(24) | SSE(25) | SSE2(26)
                                self.gpr[2] = (1 << 0)
                                    | (1 << 4)
                                    | (1 << 15)
                                    | (1 << 23)
                                    | (1 << 24)
                                    | (1 << 25)
                                    | (1 << 26);
                            }
                            7 if subleaf == 0 => {
                                self.gpr[0] = 0;
                                // EBX: BMI1(3) | AVX2(5) | BMI2(8)
                                self.gpr[3] = (1 << 3) | (1 << 5) | (1 << 8);
                                self.gpr[1] = 0;
                                self.gpr[2] = 0;
                            }
                            0x8000_0000 => {
                                self.gpr[0] = 0x8000_0008;
                                self.gpr[3] = 0;
                                self.gpr[1] = 0;
                                self.gpr[2] = 0;
                            }
                            _ => {
                                self.gpr[0] = 0;
                                self.gpr[3] = 0;
                                self.gpr[1] = 0;
                                self.gpr[2] = 0;
                            }
                        }
                        ExecOutcome::Next
                    }
                    // BT / BTS / BTR / BTC r/m, r (0F A3, AB, B3, BB) & 0F BA /4..7
                    0xA3 | 0xAB | 0xB3 | 0xBB | 0xBA => {
                        let sz = Self::operand_size(&pfx, false);
                        let bits = (sz * 8) as u64;
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let (bit_op, bit_idx_signed): (u8, i64) = if op2 == 0xBA {
                            let imm = code[cursor];
                            cursor += 1;
                            ((reg & 7) as u8, imm as i64)
                        } else {
                            let kind = match op2 {
                                0xA3 => 4,
                                0xAB => 5,
                                0xB3 => 6,
                                0xBB => 7,
                                _ => unreachable!(),
                            };
                            let rv = match sz {
                                2 => self.read_gpr(reg, 2, pfx.has_rex) as u16 as i16 as i64,
                                4 => self.read_gpr(reg, 4, pfx.has_rex) as u32 as i32 as i64,
                                8 => self.read_gpr(reg, 8, pfx.has_rex) as i64,
                                _ => unreachable!(),
                            };
                            (kind, rv)
                        };
                        let next_rip = insn_rip + cursor as u64;
                        match addr {
                            Addressing::Reg(r) => {
                                let b = (bit_idx_signed as u64) & (bits - 1);
                                let v = self.read_gpr(r, sz, pfx.has_rex);
                                let cf = ((v >> b) & 1) != 0;
                                self.rflags = (self.rflags & !CF) | if cf { CF } else { 0 };
                                let nv = match bit_op {
                                    5 => v | (1u64 << b),
                                    6 => v & !(1u64 << b),
                                    7 => v ^ (1u64 << b),
                                    _ => v,
                                };
                                if bit_op != 4 {
                                    self.write_gpr(r, sz, pfx.has_rex, nv);
                                }
                            }
                            _ => {
                                let base_ea = self.resolve_ea(addr, next_rip);
                                let (byte_off, bit_in_elem) = if op2 == 0xBA {
                                    (0i64, (bit_idx_signed as u64) & (bits - 1))
                                } else {
                                    let elem_bits = bits as i64;
                                    let elem_idx = bit_idx_signed.div_euclid(elem_bits);
                                    let rem = bit_idx_signed.rem_euclid(elem_bits) as u64;
                                    (elem_idx * (sz as i64), rem)
                                };
                                let ea = base_ea.wrapping_add(byte_off as u64);
                                let v = match sz {
                                    2 => vmm.read_u16(ea)? as u64,
                                    4 => vmm.read_u32(ea)? as u64,
                                    8 => vmm.read_u64(ea)?,
                                    _ => unreachable!(),
                                };
                                let cf = ((v >> bit_in_elem) & 1) != 0;
                                self.rflags = (self.rflags & !CF) | if cf { CF } else { 0 };
                                if bit_op != 4 {
                                    let nv = match bit_op {
                                        5 => v | (1u64 << bit_in_elem),
                                        6 => v & !(1u64 << bit_in_elem),
                                        7 => v ^ (1u64 << bit_in_elem),
                                        _ => v,
                                    };
                                    match sz {
                                        2 => vmm.write_u16(ea, nv as u16)?,
                                        4 => vmm.write_u32(ea, nv as u32)?,
                                        8 => vmm.write_u64(ea, nv)?,
                                        _ => unreachable!(),
                                    }
                                }
                            }
                        }
                        ExecOutcome::Next
                    }
                    // SHLD (0F A4, A5) & SHRD (0F AC, AD)
                    0xA4 | 0xA5 | 0xAC | 0xAD => {
                        let sz = Self::operand_size(&pfx, false);
                        let bits = (sz * 8) as u32;
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let raw_cnt = if op2 == 0xA4 || op2 == 0xAC {
                            let c = code[cursor];
                            cursor += 1;
                            c
                        } else {
                            self.gpr[1] as u8
                        };
                        let next_rip = insn_rip + cursor as u64;
                        let cnt = (raw_cnt & if sz == 8 { 63 } else { 31 }) as u32;
                        if cnt != 0 && cnt < bits {
                            let dst = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                            let src = self.read_gpr(reg, sz, pfx.has_rex);
                            let mask = Self::mask_for_size(sz);
                            let (res, cf) = if op2 <= 0xA5 {
                                let r = ((dst << cnt) | (src >> (bits - cnt))) & mask;
                                let c = ((dst >> (bits - cnt)) & 1) != 0;
                                (r, c)
                            } else {
                                let r = ((dst >> cnt) | (src << (bits - cnt))) & mask;
                                let c = ((dst >> (cnt - 1)) & 1) != 0;
                                (r, c)
                            };
                            self.rflags = (self.rflags & !CF) | if cf { CF } else { 0 };
                            self.set_szp_flags(res, sz);
                            self.write_rm(vmm, addr, next_rip, sz, pfx.has_rex, res)?;
                        }
                        ExecOutcome::Next
                    }
                    // IMUL r, r/m (0F AF)
                    0xAF => {
                        let sz = Self::operand_size(&pfx, false);
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let next_rip = insn_rip + cursor as u64;
                        let a = self.read_gpr(reg, sz, pfx.has_rex);
                        let b = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                        let (res, ovf) = match sz {
                            2 => {
                                let p = (a as u16 as i16 as i32) * (b as u16 as i16 as i32);
                                ((p as u16) as u64, p != (p as i16 as i32))
                            }
                            4 => {
                                let p = (a as u32 as i32 as i64) * (b as u32 as i32 as i64);
                                ((p as u32) as u64, p != (p as i32 as i64))
                            }
                            8 => {
                                let p = (a as i64 as i128) * (b as i64 as i128);
                                (p as u64, p != (p as i64 as i128))
                            }
                            _ => unreachable!(),
                        };
                        self.rflags = (self.rflags & !(CF | OF)) | if ovf { CF | OF } else { 0 };
                        self.write_gpr(reg, sz, pfx.has_rex, res);
                        ExecOutcome::Next
                    }
                    // CMPXCHG r/m, r (0F B0, B1)
                    0xB0 | 0xB1 => {
                        let sz = Self::operand_size(&pfx, op2 == 0xB0);
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let next_rip = insn_rip + cursor as u64;
                        let dst = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                        let acc = self.read_gpr(0, sz, pfx.has_rex);
                        let _ = self.alu_op(7, acc, dst, sz);
                        if acc == dst {
                            let src = self.read_gpr(reg, sz, pfx.has_rex);
                            self.write_rm(vmm, addr, next_rip, sz, pfx.has_rex, src)?;
                        } else {
                            self.write_gpr(0, sz, pfx.has_rex, dst);
                        }
                        ExecOutcome::Next
                    }
                    // MOVZX (0F B6, B7) & MOVSX (0F BE, BF)
                    0xB6 | 0xB7 | 0xBE | 0xBF => {
                        let src_sz = if op2 == 0xB6 || op2 == 0xBE { 1 } else { 2 };
                        let dst_sz = Self::operand_size(&pfx, false);
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let next_rip = insn_rip + cursor as u64;
                        let raw = self.read_rm(vmm, addr, next_rip, src_sz, pfx.has_rex)?;
                        let ext = if op2 >= 0xBE {
                            if src_sz == 1 {
                                raw as u8 as i8 as i64 as u64
                            } else {
                                raw as u16 as i16 as i64 as u64
                            }
                        } else {
                            raw
                        };
                        self.write_gpr(reg, dst_sz, pfx.has_rex, ext);
                        ExecOutcome::Next
                    }
                    // POPCNT (F3 0F B8)
                    0xB8 if pfx.rep_f3 => {
                        let sz = Self::operand_size(&pfx, false);
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let next_rip = insn_rip + cursor as u64;
                        let v = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                        let cnt = v.count_ones() as u64;
                        self.rflags &= !(CF | OF | SF | AF | PF);
                        if cnt == 0 {
                            self.rflags |= ZF;
                        } else {
                            self.rflags &= !ZF;
                        }
                        self.write_gpr(reg, sz, pfx.has_rex, cnt);
                        ExecOutcome::Next
                    }
                    // BSF / TZCNT (0F BC) & BSR / LZCNT (0F BD)
                    0xBC | 0xBD => {
                        let sz = Self::operand_size(&pfx, false);
                        let bits = (sz * 8) as u64;
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let next_rip = insn_rip + cursor as u64;
                        let v = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                        if pfx.rep_f3 {
                            // TZCNT / LZCNT
                            let res = if v == 0 {
                                bits
                            } else if op2 == 0xBC {
                                v.trailing_zeros() as u64
                            } else {
                                (v.leading_zeros() as u64) - (64 - bits)
                            };
                            self.rflags &= !(CF | ZF);
                            if v == 0 {
                                self.rflags |= CF;
                            }
                            if res == 0 {
                                self.rflags |= ZF;
                            }
                            self.write_gpr(reg, sz, pfx.has_rex, res);
                        } else if v == 0 {
                            self.rflags |= ZF;
                        } else {
                            self.rflags &= !ZF;
                            let res = if op2 == 0xBC {
                                v.trailing_zeros() as u64
                            } else {
                                63 - (v.leading_zeros() as u64)
                            };
                            self.write_gpr(reg, sz, pfx.has_rex, res);
                        }
                        ExecOutcome::Next
                    }
                    // XADD r/m, r (0F C0, C1)
                    0xC0 | 0xC1 => {
                        let sz = Self::operand_size(&pfx, op2 == 0xC0);
                        let (_m, reg, _rm, addr) = self.decode_modrm_addressing(&pfx, code, &mut cursor);
                        let next_rip = insn_rip + cursor as u64;
                        let dst = self.read_rm(vmm, addr, next_rip, sz, pfx.has_rex)?;
                        let src = self.read_gpr(reg, sz, pfx.has_rex);
                        let sum = self.alu_op(0, dst, src, sz);
                        self.write_rm(vmm, addr, next_rip, sz, pfx.has_rex, sum)?;
                        self.write_gpr(reg, sz, pfx.has_rex, dst);
                        ExecOutcome::Next
                    }
                    // BSWAP r32 / r64 (0F C8..CF)
                    0xC8..=0xCF => {
                        let reg = ((op2 - 0xC8) as usize) | if pfx.rex_b { 8 } else { 0 };
                        if pfx.rex_w {
                            self.gpr[reg] = self.gpr[reg].swap_bytes();
                        } else {
                            self.gpr[reg] = (self.gpr[reg] as u32).swap_bytes() as u64;
                        }
                        ExecOutcome::Next
                    }
                    _ => {
                        // Legacy SSE / SSE2
                        let mut simd_pfx = pfx;
                        // Adjust RIP-relative for trailing imm8 opcodes in cpu_simd.rs (0x70..0x73, 0xC2, 0xC4, 0xC5, 0xC6)
                        let has_imm8 = matches!(op2, 0x70 | 0x71 | 0x72 | 0x73 | 0xC2 | 0xC4 | 0xC5 | 0xC6);
                        let fake_rip = if has_imm8 { insn_rip + 1 } else { insn_rip };
                        match self.exec_sse_0f(vmm, &mut simd_pfx, op2, code, &mut cursor, fake_rip)? {
                            Some(out) => out,
                            None => ExecOutcome::Fault(format!(
                                "Unimplemented 0F 0x{op2:02x} at 0x{insn_rip:x}"
                            )),
                        }
                    }
                }
            }

            _ => ExecOutcome::Fault(format!("Unimplemented opcode 0x{op:02x} at 0x{insn_rip:x}")),
        };

        self.instructions_executed = self.instructions_executed.wrapping_add(1);
        match outcome {
            ExecOutcome::Next => {
                self.rip = insn_rip.wrapping_add(cursor as u64);
                Ok(ExecOutcome::Next)
            }
            ExecOutcome::Branch(target) => {
                self.rip = target;
                Ok(ExecOutcome::Branch(target))
            }
            ExecOutcome::Fault(msg) => Ok(ExecOutcome::Fault(msg)),
        }
    }
}
