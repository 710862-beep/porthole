use crate::cpu::{CpuState, ExecOutcome, Prefixes};
use crate::vmm::{MemoryTrap, VirtualMemoryManager};

#[inline]
fn f64_to_f80(val: f64) -> [u8; 10] {
    let bits = val.to_bits();
    let sign = ((bits >> 63) & 1) as u16;
    let exp = ((bits >> 52) & 0x7FF) as i32;
    let frac = bits & 0x000F_FFFF_FFFF_FFFF;

    let (exp80, mant80): (u16, u64) = if exp == 0 && frac == 0 {
        (sign << 15, 0)
    } else if exp == 0x7FF {
        let m = 0x8000_0000_0000_0000u64 | (frac << 11);
        ((sign << 15) | 0x7FFF, m)
    } else if exp == 0 {
        let mut f = frac;
        let mut e = -1022 + 16383;
        while (f & (1u64 << 52)) == 0 {
            f <<= 1;
            e -= 1;
        }
        let m = (1u64 << 63) | ((f & 0x000F_FFFF_FFFF_FFFF) << 11);
        ((sign << 15) | (e.max(0) as u16), m)
    } else {
        let e = (exp - 1023 + 16383) as u16;
        let m = 0x8000_0000_0000_0000u64 | (frac << 11);
        ((sign << 15) | e, m)
    };

    let mut out = [0u8; 10];
    out[0..8].copy_from_slice(&mant80.to_le_bytes());
    out[8..10].copy_from_slice(&exp80.to_le_bytes());
    out
}

#[inline]
fn f80_to_f64(bytes: &[u8; 10]) -> f64 {
    let mant = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
    let se = u16::from_le_bytes(bytes[8..10].try_into().unwrap());
    let sign = if (se & 0x8000) != 0 { -1.0f64 } else { 1.0f64 };
    let exp = (se & 0x7FFF) as i32;

    if exp == 0 && mant == 0 {
        return 0.0 * sign;
    }
    if exp == 0x7FFF {
        if (mant & 0x7FFF_FFFF_FFFF_FFFF) == 0 {
            return f64::INFINITY * sign;
        }
        return f64::NAN;
    }
    let unbiased = if exp == 0 { -16382 } else { exp - 16383 };
    let frac = (mant as f64) / ((1u64 << 63) as f64);
    sign * frac * 2.0f64.powi(unbiased)
}

#[inline]
fn cmp_f32_pred(a: f32, b: f32, imm: u8) -> bool {
    let unord = a.is_nan() || b.is_nan();
    match imm & 0x1F {
        0 | 8 | 16 | 24 => !unord && a == b,
        1 | 9 | 17 | 25 => !unord && a < b,
        2 | 10 | 18 | 26 => !unord && a <= b,
        3 | 19 => unord,
        4 | 12 | 20 | 28 => unord || a != b,
        5 | 13 | 21 | 29 => unord || !(a < b),
        6 | 14 | 22 | 30 => unord || !(a <= b),
        7 | 15 | 23 | 31 => !unord,
        11 => false,
        27 => true,
        _ => false,
    }
}

#[inline]
fn cmp_f64_pred(a: f64, b: f64, imm: u8) -> bool {
    let unord = a.is_nan() || b.is_nan();
    match imm & 0x1F {
        0 | 8 | 16 | 24 => !unord && a == b,
        1 | 9 | 17 | 25 => !unord && a < b,
        2 | 10 | 18 | 26 => !unord && a <= b,
        3 | 19 => unord,
        4 | 12 | 20 | 28 => unord || a != b,
        5 | 13 | 21 | 29 => unord || !(a < b),
        6 | 14 | 22 | 30 => unord || !(a <= b),
        7 | 15 | 23 | 31 => !unord,
        11 => false,
        27 => true,
        _ => false,
    }
}

impl CpuState {
    #[inline]
    pub fn get_xmm(&self, reg: usize) -> [u8; 16] {
        let mut out = [0u8; 16];
        out.copy_from_slice(&self.ymm[reg & 15][0..16]);
        out
    }

    #[inline]
    pub fn set_xmm_preserve_upper(&mut self, reg: usize, val: &[u8; 16]) {
        self.ymm[reg & 15][0..16].copy_from_slice(val);
    }

    #[inline]
    pub fn set_xmm_vex_zero_upper(&mut self, reg: usize, val: &[u8; 16]) {
        self.ymm[reg & 15][0..16].copy_from_slice(val);
        self.ymm[reg & 15][16..32].fill(0);
    }

    #[inline]
    pub fn get_ymm(&self, reg: usize) -> [u8; 32] {
        self.ymm[reg & 15]
    }

    #[inline]
    pub fn set_ymm(&mut self, reg: usize, val: &[u8; 32]) {
        self.ymm[reg & 15] = *val;
    }

    fn read_xmm_rm(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        modrm: u8,
        ea: u64,
        rm_reg: usize,
    ) -> Result<[u8; 16], MemoryTrap> {
        if (modrm >> 6) == 3 {
            Ok(self.get_xmm(rm_reg))
        } else {
            vmm.read_u128(ea)
        }
    }

    fn read_ymm_rm(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        modrm: u8,
        ea: u64,
        rm_reg: usize,
    ) -> Result<[u8; 32], MemoryTrap> {
        if (modrm >> 6) == 3 {
            Ok(self.get_ymm(rm_reg))
        } else {
            vmm.read_u256(ea)
        }
    }

    fn read_f32_rm(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        modrm: u8,
        ea: u64,
        rm_reg: usize,
    ) -> Result<f32, MemoryTrap> {
        if (modrm >> 6) == 3 {
            let x = self.get_xmm(rm_reg);
            Ok(f32::from_le_bytes(x[0..4].try_into().unwrap()))
        } else {
            Ok(f32::from_bits(vmm.read_u32(ea)?))
        }
    }

    fn read_f64_rm(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        modrm: u8,
        ea: u64,
        rm_reg: usize,
    ) -> Result<f64, MemoryTrap> {
        if (modrm >> 6) == 3 {
            let x = self.get_xmm(rm_reg);
            Ok(f64::from_le_bytes(x[0..8].try_into().unwrap()))
        } else {
            Ok(f64::from_bits(vmm.read_u64(ea)?))
        }
    }

    pub fn set_ucomi_flags_f64(&mut self, a: f64, b: f64) {
        // Clear CF(0), PF(2), AF(4), ZF(6), SF(7), OF(11)
        self.rflags &= !(0x001 | 0x004 | 0x010 | 0x040 | 0x080 | 0x800);
        if a.is_nan() || b.is_nan() {
            self.rflags |= 0x001 | 0x004 | 0x040; // ZF=1, PF=1, CF=1
        } else if a < b {
            self.rflags |= 0x001; // CF=1
        } else if a == b {
            self.rflags |= 0x040; // ZF=1
        }
    }

    /// Executes legacy 0x0F SSE / SSE2 instructions (`0F ...` where opcode is SIMD/FP).
    pub fn exec_sse_0f(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        pfx: &Prefixes,
        op2: u8,
        code: &[u8],
        cursor: &mut usize,
        insn_rip: u64,
    ) -> Result<Option<ExecOutcome>, MemoryTrap> {
        let pp = if pfx.rep_f3 {
            2u8
        } else if pfx.repne_f2 {
            3u8
        } else if pfx.osz_66 {
            1u8
        } else {
            0u8
        };

        match op2 {
            0x10 => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                match pp {
                    0 | 1 => {
                        let v = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                        self.set_xmm_preserve_upper(reg, &v);
                    }
                    2 => {
                        if (modrm >> 6) == 3 {
                            let src = self.get_xmm(rm);
                            let mut dst = self.get_xmm(reg);
                            dst[0..4].copy_from_slice(&src[0..4]);
                            self.set_xmm_preserve_upper(reg, &dst);
                        } else {
                            let v = vmm.read_u32(ea)?;
                            let mut dst = [0u8; 16];
                            dst[0..4].copy_from_slice(&v.to_le_bytes());
                            self.set_xmm_preserve_upper(reg, &dst);
                        }
                    }
                    3 => {
                        if (modrm >> 6) == 3 {
                            let src = self.get_xmm(rm);
                            let mut dst = self.get_xmm(reg);
                            dst[0..8].copy_from_slice(&src[0..8]);
                            self.set_xmm_preserve_upper(reg, &dst);
                        } else {
                            let v = vmm.read_u64(ea)?;
                            let mut dst = [0u8; 16];
                            dst[0..8].copy_from_slice(&v.to_le_bytes());
                            self.set_xmm_preserve_upper(reg, &dst);
                        }
                    }
                    _ => unreachable!(),
                }
                Ok(Some(ExecOutcome::Next))
            }
            0x11 => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let src = self.get_xmm(reg);
                match pp {
                    0 | 1 => {
                        if (modrm >> 6) == 3 {
                            self.set_xmm_preserve_upper(rm, &src);
                        } else {
                            vmm.write_u128(ea, &src)?;
                        }
                    }
                    2 => {
                        if (modrm >> 6) == 3 {
                            let mut dst = self.get_xmm(rm);
                            dst[0..4].copy_from_slice(&src[0..4]);
                            self.set_xmm_preserve_upper(rm, &dst);
                        } else {
                            vmm.write_bytes(ea, &src[0..4])?;
                        }
                    }
                    3 => {
                        if (modrm >> 6) == 3 {
                            let mut dst = self.get_xmm(rm);
                            dst[0..8].copy_from_slice(&src[0..8]);
                            self.set_xmm_preserve_upper(rm, &dst);
                        } else {
                            vmm.write_bytes(ea, &src[0..8])?;
                        }
                    }
                    _ => unreachable!(),
                }
                Ok(Some(ExecOutcome::Next))
            }
            0x12 => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let mut dst = self.get_xmm(reg);
                if pp == 2 {
                    // movsldup
                    let src = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                    dst[0..4].copy_from_slice(&src[0..4]);
                    dst[4..8].copy_from_slice(&src[0..4]);
                    dst[8..12].copy_from_slice(&src[8..12]);
                    dst[12..16].copy_from_slice(&src[8..12]);
                } else if pp == 3 {
                    // movddup
                    let lo = if (modrm >> 6) == 3 {
                        u64::from_le_bytes(self.get_xmm(rm)[0..8].try_into().unwrap())
                    } else {
                        vmm.read_u64(ea)?
                    };
                    dst[0..8].copy_from_slice(&lo.to_le_bytes());
                    dst[8..16].copy_from_slice(&lo.to_le_bytes());
                } else if (modrm >> 6) == 3 {
                    // movhlps xmm1, xmm2
                    let src = self.get_xmm(rm);
                    dst[0..8].copy_from_slice(&src[8..16]);
                } else {
                    // movlps / movlpd xmm1, m64
                    let lo = vmm.read_u64(ea)?;
                    dst[0..8].copy_from_slice(&lo.to_le_bytes());
                }
                self.set_xmm_preserve_upper(reg, &dst);
                Ok(Some(ExecOutcome::Next))
            }
            0x13 => {
                let (_modrm, reg, _rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let src = self.get_xmm(reg);
                vmm.write_bytes(ea, &src[0..8])?;
                Ok(Some(ExecOutcome::Next))
            }
            0x14 => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let a = self.get_xmm(reg);
                let b = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                let mut out = [0u8; 16];
                if pp == 1 {
                    // unpcklpd
                    out[0..8].copy_from_slice(&a[0..8]);
                    out[8..16].copy_from_slice(&b[0..8]);
                } else {
                    // unpcklps
                    out[0..4].copy_from_slice(&a[0..4]);
                    out[4..8].copy_from_slice(&b[0..4]);
                    out[8..12].copy_from_slice(&a[4..8]);
                    out[12..16].copy_from_slice(&b[4..8]);
                }
                self.set_xmm_preserve_upper(reg, &out);
                Ok(Some(ExecOutcome::Next))
            }
            0x15 => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let a = self.get_xmm(reg);
                let b = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                let mut out = [0u8; 16];
                if pp == 1 {
                    // unpckhpd
                    out[0..8].copy_from_slice(&a[8..16]);
                    out[8..16].copy_from_slice(&b[8..16]);
                } else {
                    // unpckhps
                    out[0..4].copy_from_slice(&a[8..12]);
                    out[4..8].copy_from_slice(&b[8..12]);
                    out[8..12].copy_from_slice(&a[12..16]);
                    out[12..16].copy_from_slice(&b[12..16]);
                }
                self.set_xmm_preserve_upper(reg, &out);
                Ok(Some(ExecOutcome::Next))
            }
            0x16 => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let mut dst = self.get_xmm(reg);
                if pp == 2 {
                    // movshdup
                    let src = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                    dst[0..4].copy_from_slice(&src[4..8]);
                    dst[4..8].copy_from_slice(&src[4..8]);
                    dst[8..12].copy_from_slice(&src[12..16]);
                    dst[12..16].copy_from_slice(&src[12..16]);
                } else if (modrm >> 6) == 3 {
                    // movlhps xmm1, xmm2
                    let src = self.get_xmm(rm);
                    dst[8..16].copy_from_slice(&src[0..8]);
                } else {
                    // movhps / movhpd xmm1, m64
                    let hi = vmm.read_u64(ea)?;
                    dst[8..16].copy_from_slice(&hi.to_le_bytes());
                }
                self.set_xmm_preserve_upper(reg, &dst);
                Ok(Some(ExecOutcome::Next))
            }
            0x17 => {
                let (_modrm, reg, _rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let src = self.get_xmm(reg);
                vmm.write_bytes(ea, &src[8..16])?;
                Ok(Some(ExecOutcome::Next))
            }
            0x28 | 0x6F => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let v = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                self.set_xmm_preserve_upper(reg, &v);
                Ok(Some(ExecOutcome::Next))
            }
            0x29 | 0x7F => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let src = self.get_xmm(reg);
                if (modrm >> 6) == 3 {
                    self.set_xmm_preserve_upper(rm, &src);
                } else {
                    vmm.write_u128(ea, &src)?;
                }
                Ok(Some(ExecOutcome::Next))
            }
            0x2A => {
                // cvtsi2ss (F3) / cvtsi2sd (F2)
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let si: i64 = if pfx.rex_w {
                    if (modrm >> 6) == 3 {
                        self.gpr[rm] as i64
                    } else {
                        vmm.read_u64(ea)? as i64
                    }
                } else if (modrm >> 6) == 3 {
                    (self.gpr[rm] as u32 as i32) as i64
                } else {
                    (vmm.read_u32(ea)? as i32) as i64
                };
                let mut dst = self.get_xmm(reg);
                if pp == 2 {
                    dst[0..4].copy_from_slice(&(si as f32).to_le_bytes());
                } else if pp == 3 {
                    dst[0..8].copy_from_slice(&(si as f64).to_le_bytes());
                }
                self.set_xmm_preserve_upper(reg, &dst);
                Ok(Some(ExecOutcome::Next))
            }
            0x2C | 0x2D => {
                // cvttss2si / cvtss2si / cvttsd2si / cvtsd2si
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let trunc = op2 == 0x2C;
                if pp == 2 {
                    let f = self.read_f32_rm(vmm, modrm, ea, rm)?;
                    let r = if trunc { f.trunc() } else { f.round_ties_even() };
                    if pfx.rex_w {
                        let v = if !r.is_finite() || r < (i64::MIN as f32) || r >= (i64::MAX as f32) {
                            i64::MIN
                        } else {
                            r as i64
                        };
                        self.gpr[reg] = v as u64;
                    } else {
                        let v = if !r.is_finite() || r < (i32::MIN as f32) || r >= (2147483648.0f32) {
                            i32::MIN
                        } else {
                            r as i32
                        };
                        self.gpr[reg] = (v as u32) as u64;
                    }
                } else {
                    let f = self.read_f64_rm(vmm, modrm, ea, rm)?;
                    let r = if trunc { f.trunc() } else { f.round_ties_even() };
                    if pfx.rex_w {
                        let v = if !r.is_finite() || r < (i64::MIN as f64) || r >= 9223372036854775808.0f64 {
                            i64::MIN
                        } else {
                            r as i64
                        };
                        self.gpr[reg] = v as u64;
                    } else {
                        let v = if !r.is_finite() || r < (i32::MIN as f64) || r >= 2147483648.0f64 {
                            i32::MIN
                        } else {
                            r as i32
                        };
                        self.gpr[reg] = (v as u32) as u64;
                    }
                }
                Ok(Some(ExecOutcome::Next))
            }
            0x2E | 0x2F => {
                // ucomiss / comiss / ucomisd / comisd
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                if pp == 1 {
                    let a = f64::from_le_bytes(self.get_xmm(reg)[0..8].try_into().unwrap());
                    let b = self.read_f64_rm(vmm, modrm, ea, rm)?;
                    self.set_ucomi_flags_f64(a, b);
                } else {
                    let a = f32::from_le_bytes(self.get_xmm(reg)[0..4].try_into().unwrap()) as f64;
                    let b = self.read_f32_rm(vmm, modrm, ea, rm)? as f64;
                    self.set_ucomi_flags_f64(a, b);
                }
                Ok(Some(ExecOutcome::Next))
            }
            0x50 => {
                let (_modrm, reg, rm, _ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let x = self.get_xmm(rm);
                let mask = if pp == 1 {
                    (((x[7] >> 7) & 1) | (((x[15] >> 7) & 1) << 1)) as u64
                } else {
                    (((x[3] >> 7) & 1)
                        | (((x[7] >> 7) & 1) << 1)
                        | (((x[11] >> 7) & 1) << 2)
                        | (((x[15] >> 7) & 1) << 3)) as u64
                };
                self.gpr[reg] = mask;
                Ok(Some(ExecOutcome::Next))
            }
            0x51 | 0x54 | 0x55 | 0x56 | 0x57 | 0x58 | 0x59 | 0x5A | 0x5B | 0x5C | 0x5D | 0x5E | 0x5F => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                if op2 == 0x54 || op2 == 0x55 || op2 == 0x56 || op2 == 0x57 {
                    let a = self.get_xmm(reg);
                    let b = if reg == rm && (modrm >> 6) == 3 && op2 == 0x57 {
                        a
                    } else {
                        self.read_xmm_rm(vmm, modrm, ea, rm)?
                    };
                    let mut out = [0u8; 16];
                    for i in 0..16 {
                        out[i] = match op2 {
                            0x54 => a[i] & b[i],
                            0x55 => (!a[i]) & b[i],
                            0x56 => a[i] | b[i],
                            0x57 => a[i] ^ b[i],
                            _ => unreachable!(),
                        };
                    }
                    self.set_xmm_preserve_upper(reg, &out);
                    return Ok(Some(ExecOutcome::Next));
                }
                if op2 == 0x5A {
                    let mut dst = self.get_xmm(reg);
                    match pp {
                        0 => {
                            let s = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                            let f0 = f32::from_le_bytes(s[0..4].try_into().unwrap()) as f64;
                            let f1 = f32::from_le_bytes(s[4..8].try_into().unwrap()) as f64;
                            dst[0..8].copy_from_slice(&f0.to_le_bytes());
                            dst[8..16].copy_from_slice(&f1.to_le_bytes());
                        }
                        1 => {
                            let s = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                            let d0 = f64::from_le_bytes(s[0..8].try_into().unwrap()) as f32;
                            let d1 = f64::from_le_bytes(s[8..16].try_into().unwrap()) as f32;
                            dst = [0u8; 16];
                            dst[0..4].copy_from_slice(&d0.to_le_bytes());
                            dst[4..8].copy_from_slice(&d1.to_le_bytes());
                        }
                        2 => {
                            let s = self.read_f32_rm(vmm, modrm, ea, rm)? as f64;
                            dst[0..8].copy_from_slice(&s.to_le_bytes());
                        }
                        3 => {
                            let s = self.read_f64_rm(vmm, modrm, ea, rm)? as f32;
                            dst[0..4].copy_from_slice(&s.to_le_bytes());
                        }
                        _ => {}
                    }
                    self.set_xmm_preserve_upper(reg, &dst);
                    return Ok(Some(ExecOutcome::Next));
                }
                if op2 == 0x5B {
                    let s = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                    let mut out = [0u8; 16];
                    for lane in 0..4 {
                        let o = lane * 4;
                        match pp {
                            0 => {
                                let iv = i32::from_le_bytes(s[o..o + 4].try_into().unwrap());
                                out[o..o + 4].copy_from_slice(&(iv as f32).to_le_bytes());
                            }
                            1 => {
                                let fv = f32::from_le_bytes(s[o..o + 4].try_into().unwrap()).round_ties_even();
                                let iv = if !fv.is_finite() || fv < i32::MIN as f32 || fv >= 2147483648.0f32 {
                                    i32::MIN
                                } else {
                                    fv as i32
                                };
                                out[o..o + 4].copy_from_slice(&iv.to_le_bytes());
                            }
                            2 => {
                                let fv = f32::from_le_bytes(s[o..o + 4].try_into().unwrap()).trunc();
                                let iv = if !fv.is_finite() || fv < i32::MIN as f32 || fv >= 2147483648.0f32 {
                                    i32::MIN
                                } else {
                                    fv as i32
                                };
                                out[o..o + 4].copy_from_slice(&iv.to_le_bytes());
                            }
                            _ => {}
                        }
                    }
                    self.set_xmm_preserve_upper(reg, &out);
                    return Ok(Some(ExecOutcome::Next));
                }

                let mut dst = self.get_xmm(reg);
                match pp {
                    0 => {
                        let b = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                        for lane in 0..4 {
                            let o = lane * 4;
                            let x = f32::from_le_bytes(dst[o..o + 4].try_into().unwrap());
                            let y = f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
                            let r = match op2 {
                                0x51 => y.sqrt(),
                                0x58 => x + y,
                                0x59 => x * y,
                                0x5C => x - y,
                                0x5D => if x < y { x } else { y },
                                0x5E => x / y,
                                0x5F => if x > y { x } else { y },
                                _ => x,
                            };
                            dst[o..o + 4].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    1 => {
                        let b = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                        for lane in 0..2 {
                            let o = lane * 8;
                            let x = f64::from_le_bytes(dst[o..o + 8].try_into().unwrap());
                            let y = f64::from_le_bytes(b[o..o + 8].try_into().unwrap());
                            let r = match op2 {
                                0x51 => y.sqrt(),
                                0x58 => x + y,
                                0x59 => x * y,
                                0x5C => x - y,
                                0x5D => if x < y { x } else { y },
                                0x5E => x / y,
                                0x5F => if x > y { x } else { y },
                                _ => x,
                            };
                            dst[o..o + 8].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    2 => {
                        let x = f32::from_le_bytes(dst[0..4].try_into().unwrap());
                        let y = self.read_f32_rm(vmm, modrm, ea, rm)?;
                        let r = match op2 {
                            0x51 => y.sqrt(),
                            0x58 => x + y,
                            0x59 => x * y,
                            0x5C => x - y,
                            0x5D => if x < y { x } else { y },
                            0x5E => x / y,
                            0x5F => if x > y { x } else { y },
                            _ => x,
                        };
                        dst[0..4].copy_from_slice(&r.to_le_bytes());
                    }
                    3 => {
                        let x = f64::from_le_bytes(dst[0..8].try_into().unwrap());
                        let y = self.read_f64_rm(vmm, modrm, ea, rm)?;
                        let r = match op2 {
                            0x51 => y.sqrt(),
                            0x58 => x + y,
                            0x59 => x * y,
                            0x5C => x - y,
                            0x5D => if x < y { x } else { y },
                            0x5E => x / y,
                            0x5F => if x > y { x } else { y },
                            _ => x,
                        };
                        dst[0..8].copy_from_slice(&r.to_le_bytes());
                    }
                    _ => {}
                }
                self.set_xmm_preserve_upper(reg, &dst);
                Ok(Some(ExecOutcome::Next))
            }
            0x60 | 0x61 | 0x62 | 0x68 | 0x69 | 0x6A | 0x6C | 0x6D if pp == 1 => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let a = self.get_xmm(reg);
                let b = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                let mut out = [0u8; 16];
                match op2 {
                    0x60 => {
                        for i in 0..8 {
                            out[i * 2] = a[i];
                            out[i * 2 + 1] = b[i];
                        }
                    }
                    0x61 => {
                        for i in 0..4 {
                            out[i * 4..i * 4 + 2].copy_from_slice(&a[i * 2..i * 2 + 2]);
                            out[i * 4 + 2..i * 4 + 4].copy_from_slice(&b[i * 2..i * 2 + 2]);
                        }
                    }
                    0x62 => {
                        for i in 0..2 {
                            out[i * 8..i * 8 + 4].copy_from_slice(&a[i * 4..i * 4 + 4]);
                            out[i * 8 + 4..i * 8 + 8].copy_from_slice(&b[i * 4..i * 4 + 4]);
                        }
                    }
                    0x68 => {
                        for i in 0..8 {
                            out[i * 2] = a[8 + i];
                            out[i * 2 + 1] = b[8 + i];
                        }
                    }
                    0x69 => {
                        for i in 0..4 {
                            out[i * 4..i * 4 + 2].copy_from_slice(&a[8 + i * 2..10 + i * 2]);
                            out[i * 4 + 2..i * 4 + 4].copy_from_slice(&b[8 + i * 2..10 + i * 2]);
                        }
                    }
                    0x6A => {
                        for i in 0..2 {
                            out[i * 8..i * 8 + 4].copy_from_slice(&a[8 + i * 4..12 + i * 4]);
                            out[i * 8 + 4..i * 8 + 8].copy_from_slice(&b[8 + i * 4..12 + i * 4]);
                        }
                    }
                    0x6C => {
                        out[0..8].copy_from_slice(&a[0..8]);
                        out[8..16].copy_from_slice(&b[0..8]);
                    }
                    0x6D => {
                        out[0..8].copy_from_slice(&a[8..16]);
                        out[8..16].copy_from_slice(&b[8..16]);
                    }
                    _ => unreachable!(),
                }
                self.set_xmm_preserve_upper(reg, &out);
                Ok(Some(ExecOutcome::Next))
            }
            0x63 | 0x67 | 0x6B if pp == 1 => {
                // PACKSSWB (0F 63) / PACKUSWB (0F 67): pack 8x i16 from dest then 8x i16 from src
                // into 16 bytes with saturation. PACKSSDW (0F 6B): pack 4x i32 -> 4x i16 each.
                // (Hit by Chocolate Doom's MD5 WAD-checksum code at W_Init.)
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let a = self.get_xmm(reg);
                let b = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                let mut out = [0u8; 16];
                let get16 = |src: &[u8; 16], i: usize| -> i16 {
                    i16::from_le_bytes(src[i * 2..i * 2 + 2].try_into().unwrap())
                };
                let get32 = |src: &[u8; 16], i: usize| -> i32 {
                    i32::from_le_bytes(src[i * 4..i * 4 + 4].try_into().unwrap())
                };
                match op2 {
                    0x63 => {
                        for i in 0..8 {
                            out[i] = get16(&a, i).clamp(-128, 127) as i8 as u8;
                            out[8 + i] = get16(&b, i).clamp(-128, 127) as i8 as u8;
                        }
                    }
                    0x67 => {
                        for i in 0..8 {
                            out[i] = get16(&a, i).clamp(0, 255) as u8;
                            out[8 + i] = get16(&b, i).clamp(0, 255) as u8;
                        }
                    }
                    _ => {
                        // 0x6B PACKSSDW
                        for i in 0..4 {
                            let va = get32(&a, i).clamp(-32768, 32767) as i16;
                            let vb = get32(&b, i).clamp(-32768, 32767) as i16;
                            out[i * 2..i * 2 + 2].copy_from_slice(&va.to_le_bytes());
                            out[8 + i * 2..10 + i * 2].copy_from_slice(&vb.to_le_bytes());
                        }
                    }
                }
                self.set_xmm_preserve_upper(reg, &out);
                Ok(Some(ExecOutcome::Next))
            }
            0x64 | 0x65 | 0x66 | 0x74 | 0x75 | 0x76 if pp == 1 => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let a = self.get_xmm(reg);
                let b = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                let mut out = [0u8; 16];
                match op2 {
                    0x74 => {
                        for i in 0..16 {
                            out[i] = if a[i] == b[i] { 0xFF } else { 0 };
                        }
                    }
                    0x64 => {
                        for i in 0..16 {
                            out[i] = if (a[i] as i8) > (b[i] as i8) { 0xFF } else { 0 };
                        }
                    }
                    0x75 | 0x65 => {
                        for i in 0..8 {
                            let x = i16::from_le_bytes(a[i * 2..i * 2 + 2].try_into().unwrap());
                            let y = i16::from_le_bytes(b[i * 2..i * 2 + 2].try_into().unwrap());
                            let m: u16 = if (op2 == 0x75 && x == y) || (op2 == 0x65 && x > y) {
                                0xFFFF
                            } else {
                                0
                            };
                            out[i * 2..i * 2 + 2].copy_from_slice(&m.to_le_bytes());
                        }
                    }
                    0x76 | 0x66 => {
                        for i in 0..4 {
                            let x = i32::from_le_bytes(a[i * 4..i * 4 + 4].try_into().unwrap());
                            let y = i32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
                            let m: u32 = if (op2 == 0x76 && x == y) || (op2 == 0x66 && x > y) {
                                0xFFFF_FFFF
                            } else {
                                0
                            };
                            out[i * 4..i * 4 + 4].copy_from_slice(&m.to_le_bytes());
                        }
                    }
                    _ => unreachable!(),
                }
                self.set_xmm_preserve_upper(reg, &out);
                Ok(Some(ExecOutcome::Next))
            }
            0x6E if pp == 1 => {
                // movd / movq xmm, r/m32 or r/m64
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let mut out = [0u8; 16];
                if pfx.rex_w {
                    let v = if (modrm >> 6) == 3 { self.gpr[rm] } else { vmm.read_u64(ea)? };
                    out[0..8].copy_from_slice(&v.to_le_bytes());
                } else {
                    let v = if (modrm >> 6) == 3 {
                        self.gpr[rm] as u32
                    } else {
                        vmm.read_u32(ea)?
                    };
                    out[0..4].copy_from_slice(&v.to_le_bytes());
                }
                self.set_xmm_preserve_upper(reg, &out);
                Ok(Some(ExecOutcome::Next))
            }
            0x7E => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                if pp == 2 {
                    // movq xmm1, xmm2/m64
                    let lo = if (modrm >> 6) == 3 {
                        u64::from_le_bytes(self.get_xmm(rm)[0..8].try_into().unwrap())
                    } else {
                        vmm.read_u64(ea)?
                    };
                    let mut out = [0u8; 16];
                    out[0..8].copy_from_slice(&lo.to_le_bytes());
                    self.set_xmm_preserve_upper(reg, &out);
                } else if pp == 1 {
                    // movd / movq r/m32/64, xmm
                    let src = self.get_xmm(reg);
                    if pfx.rex_w {
                        let v = u64::from_le_bytes(src[0..8].try_into().unwrap());
                        if (modrm >> 6) == 3 {
                            self.gpr[rm] = v;
                        } else {
                            vmm.write_u64(ea, v)?;
                        }
                    } else {
                        let v = u32::from_le_bytes(src[0..4].try_into().unwrap());
                        if (modrm >> 6) == 3 {
                            self.gpr[rm] = v as u64;
                        } else {
                            vmm.write_u32(ea, v)?;
                        }
                    }
                }
                Ok(Some(ExecOutcome::Next))
            }
            0x70 => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let imm = code[*cursor];
                *cursor += 1;
                let src = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                let mut out = src;
                match pp {
                    1 => {
                        // pshufd
                        for i in 0..4 {
                            let s = ((imm >> (i * 2)) & 3) as usize;
                            out[i * 4..i * 4 + 4].copy_from_slice(&src[s * 4..s * 4 + 4]);
                        }
                    }
                    3 => {
                        // pshuflw
                        for i in 0..4 {
                            let s = ((imm >> (i * 2)) & 3) as usize;
                            out[i * 2..i * 2 + 2].copy_from_slice(&src[s * 2..s * 2 + 2]);
                        }
                    }
                    2 => {
                        // pshufhw
                        for i in 0..4 {
                            let s = ((imm >> (i * 2)) & 3) as usize;
                            out[8 + i * 2..10 + i * 2].copy_from_slice(&src[8 + s * 2..10 + s * 2]);
                        }
                    }
                    _ => {}
                }
                self.set_xmm_preserve_upper(reg, &out);
                Ok(Some(ExecOutcome::Next))
            }
            0x71 | 0x72 | 0x73 if pp == 1 => {
                let (_modrm, subop_ext, rm, _ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let subop = subop_ext & 7;
                let imm = code[*cursor] as u32;
                *cursor += 1;
                let mut x = self.get_xmm(rm);
                match (op2, subop) {
                    (0x71, 2) => {
                        for i in 0..8 {
                            let v = u16::from_le_bytes(x[i * 2..i * 2 + 2].try_into().unwrap());
                            let r = if imm >= 16 { 0 } else { v >> imm };
                            x[i * 2..i * 2 + 2].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    (0x71, 4) => {
                        for i in 0..8 {
                            let v = i16::from_le_bytes(x[i * 2..i * 2 + 2].try_into().unwrap());
                            let r = v >> imm.min(15);
                            x[i * 2..i * 2 + 2].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    (0x71, 6) => {
                        for i in 0..8 {
                            let v = u16::from_le_bytes(x[i * 2..i * 2 + 2].try_into().unwrap());
                            let r = if imm >= 16 { 0 } else { v << imm };
                            x[i * 2..i * 2 + 2].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    (0x72, 2) => {
                        for i in 0..4 {
                            let v = u32::from_le_bytes(x[i * 4..i * 4 + 4].try_into().unwrap());
                            let r = if imm >= 32 { 0 } else { v >> imm };
                            x[i * 4..i * 4 + 4].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    (0x72, 4) => {
                        for i in 0..4 {
                            let v = i32::from_le_bytes(x[i * 4..i * 4 + 4].try_into().unwrap());
                            let r = v >> imm.min(31);
                            x[i * 4..i * 4 + 4].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    (0x72, 6) => {
                        for i in 0..4 {
                            let v = u32::from_le_bytes(x[i * 4..i * 4 + 4].try_into().unwrap());
                            let r = if imm >= 32 { 0 } else { v << imm };
                            x[i * 4..i * 4 + 4].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    (0x73, 2) => {
                        for i in 0..2 {
                            let v = u64::from_le_bytes(x[i * 8..i * 8 + 8].try_into().unwrap());
                            let r = if imm >= 64 { 0 } else { v >> imm };
                            x[i * 8..i * 8 + 8].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    (0x73, 6) => {
                        for i in 0..2 {
                            let v = u64::from_le_bytes(x[i * 8..i * 8 + 8].try_into().unwrap());
                            let r = if imm >= 64 { 0 } else { v << imm };
                            x[i * 8..i * 8 + 8].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    (0x73, 3) => {
                        // psrldq
                        let shift = (imm as usize).min(16);
                        let mut out = [0u8; 16];
                        if shift < 16 {
                            out[0..16 - shift].copy_from_slice(&x[shift..16]);
                        }
                        x = out;
                    }
                    (0x73, 7) => {
                        // pslldq
                        let shift = (imm as usize).min(16);
                        let mut out = [0u8; 16];
                        if shift < 16 {
                            out[shift..16].copy_from_slice(&x[0..16 - shift]);
                        }
                        x = out;
                    }
                    _ => {}
                }
                self.set_xmm_preserve_upper(rm, &x);
                Ok(Some(ExecOutcome::Next))
            }
            0xAE => {
                // fxsave/fxrstor/ldmxcsr/stmxcsr/lfence/mfence/sfence
                let (modrm, subop_ext, _rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let subop = subop_ext & 7;
                if (modrm >> 6) == 3 {
                    // lfence / mfence / sfence
                    return Ok(Some(ExecOutcome::Next));
                }
                match subop {
                    2 => {
                        self.mxcsr = vmm.read_u32(ea)?;
                    }
                    3 => {
                        vmm.write_u32(ea, self.mxcsr)?;
                    }
                    0 => {
                        let mut zero = [0u8; 512];
                        zero[24..28].copy_from_slice(&self.mxcsr.to_le_bytes());
                        vmm.write_bytes(ea, &zero)?;
                    }
                    1 => {
                        self.mxcsr = vmm.read_u32(ea + 24)?;
                    }
                    _ => {}
                }
                Ok(Some(ExecOutcome::Next))
            }
            0xC2 => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let imm = code[*cursor];
                *cursor += 1;
                let mut dst = self.get_xmm(reg);
                match pp {
                    0 => {
                        let b = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                        for i in 0..4 {
                            let x = f32::from_le_bytes(dst[i * 4..i * 4 + 4].try_into().unwrap());
                            let y = f32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
                            let m: u32 = if cmp_f32_pred(x, y, imm) { 0xFFFF_FFFF } else { 0 };
                            dst[i * 4..i * 4 + 4].copy_from_slice(&m.to_le_bytes());
                        }
                    }
                    1 => {
                        let b = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                        for i in 0..2 {
                            let x = f64::from_le_bytes(dst[i * 8..i * 8 + 8].try_into().unwrap());
                            let y = f64::from_le_bytes(b[i * 8..i * 8 + 8].try_into().unwrap());
                            let m: u64 = if cmp_f64_pred(x, y, imm) { u64::MAX } else { 0 };
                            dst[i * 8..i * 8 + 8].copy_from_slice(&m.to_le_bytes());
                        }
                    }
                    2 => {
                        let x = f32::from_le_bytes(dst[0..4].try_into().unwrap());
                        let y = self.read_f32_rm(vmm, modrm, ea, rm)?;
                        let m: u32 = if cmp_f32_pred(x, y, imm) { 0xFFFF_FFFF } else { 0 };
                        dst[0..4].copy_from_slice(&m.to_le_bytes());
                    }
                    3 => {
                        let x = f64::from_le_bytes(dst[0..8].try_into().unwrap());
                        let y = self.read_f64_rm(vmm, modrm, ea, rm)?;
                        let m: u64 = if cmp_f64_pred(x, y, imm) { u64::MAX } else { 0 };
                        dst[0..8].copy_from_slice(&m.to_le_bytes());
                    }
                    _ => {}
                }
                self.set_xmm_preserve_upper(reg, &dst);
                Ok(Some(ExecOutcome::Next))
            }
            0xC4 if pp == 1 => {
                // pinsrw xmm, r32/m16, imm8
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let imm = (code[*cursor] & 7) as usize;
                *cursor += 1;
                let w = if (modrm >> 6) == 3 {
                    self.gpr[rm] as u16
                } else {
                    vmm.read_u16(ea)?
                };
                let mut dst = self.get_xmm(reg);
                dst[imm * 2..imm * 2 + 2].copy_from_slice(&w.to_le_bytes());
                self.set_xmm_preserve_upper(reg, &dst);
                Ok(Some(ExecOutcome::Next))
            }
            0xC5 if pp == 1 => {
                // pextrw r32, xmm, imm8
                let (_modrm, reg, rm, _ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let imm = (code[*cursor] & 7) as usize;
                *cursor += 1;
                let src = self.get_xmm(rm);
                let w = u16::from_le_bytes(src[imm * 2..imm * 2 + 2].try_into().unwrap());
                self.gpr[reg] = w as u64;
                Ok(Some(ExecOutcome::Next))
            }
            0xC6 => {
                // shufps / shufpd
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let imm = code[*cursor];
                *cursor += 1;
                let a = self.get_xmm(reg);
                let b = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                let mut out = [0u8; 16];
                if pp == 1 {
                    let s0 = (imm & 1) as usize;
                    let s1 = ((imm >> 1) & 1) as usize;
                    out[0..8].copy_from_slice(&a[s0 * 8..s0 * 8 + 8]);
                    out[8..16].copy_from_slice(&b[s1 * 8..s1 * 8 + 8]);
                } else {
                    let s0 = (imm & 3) as usize;
                    let s1 = ((imm >> 2) & 3) as usize;
                    let s2 = ((imm >> 4) & 3) as usize;
                    let s3 = ((imm >> 6) & 3) as usize;
                    out[0..4].copy_from_slice(&a[s0 * 4..s0 * 4 + 4]);
                    out[4..8].copy_from_slice(&a[s1 * 4..s1 * 4 + 4]);
                    out[8..12].copy_from_slice(&b[s2 * 4..s2 * 4 + 4]);
                    out[12..16].copy_from_slice(&b[s3 * 4..s3 * 4 + 4]);
                }
                self.set_xmm_preserve_upper(reg, &out);
                Ok(Some(ExecOutcome::Next))
            }
            0xD1 | 0xD2 | 0xD3 | 0xE1 | 0xE2 | 0xF1 | 0xF2 | 0xF3 if pp == 1 => {
                // psrlw/d/q, psraw/d, psllw/d/q by xmm/m128 count
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let mut a = self.get_xmm(reg);
                let cnt_vec = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                let cnt = u64::from_le_bytes(cnt_vec[0..8].try_into().unwrap());
                match op2 {
                    0xD1 => {
                        for i in 0..8 {
                            let v = u16::from_le_bytes(a[i * 2..i * 2 + 2].try_into().unwrap());
                            let r = if cnt >= 16 { 0 } else { v >> cnt };
                            a[i * 2..i * 2 + 2].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    0xD2 => {
                        for i in 0..4 {
                            let v = u32::from_le_bytes(a[i * 4..i * 4 + 4].try_into().unwrap());
                            let r = if cnt >= 32 { 0 } else { v >> cnt };
                            a[i * 4..i * 4 + 4].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    0xD3 => {
                        for i in 0..2 {
                            let v = u64::from_le_bytes(a[i * 8..i * 8 + 8].try_into().unwrap());
                            let r = if cnt >= 64 { 0 } else { v >> cnt };
                            a[i * 8..i * 8 + 8].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    0xE1 => {
                        for i in 0..8 {
                            let v = i16::from_le_bytes(a[i * 2..i * 2 + 2].try_into().unwrap());
                            let r = v >> cnt.min(15);
                            a[i * 2..i * 2 + 2].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    0xE2 => {
                        for i in 0..4 {
                            let v = i32::from_le_bytes(a[i * 4..i * 4 + 4].try_into().unwrap());
                            let r = v >> cnt.min(31);
                            a[i * 4..i * 4 + 4].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    0xF1 => {
                        for i in 0..8 {
                            let v = u16::from_le_bytes(a[i * 2..i * 2 + 2].try_into().unwrap());
                            let r = if cnt >= 16 { 0 } else { v << cnt };
                            a[i * 2..i * 2 + 2].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    0xF2 => {
                        for i in 0..4 {
                            let v = u32::from_le_bytes(a[i * 4..i * 4 + 4].try_into().unwrap());
                            let r = if cnt >= 32 { 0 } else { v << cnt };
                            a[i * 4..i * 4 + 4].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    0xF3 => {
                        for i in 0..2 {
                            let v = u64::from_le_bytes(a[i * 8..i * 8 + 8].try_into().unwrap());
                            let r = if cnt >= 64 { 0 } else { v << cnt };
                            a[i * 8..i * 8 + 8].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    _ => unreachable!(),
                }
                self.set_xmm_preserve_upper(reg, &a);
                Ok(Some(ExecOutcome::Next))
            }
            0xD4 | 0xD5 | 0xDB | 0xDF | 0xEB | 0xEF | 0xF8 | 0xF9 | 0xFA | 0xFB | 0xFC | 0xFD | 0xFE if pp == 1 => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let a = self.get_xmm(reg);
                let b = if reg == rm && (modrm >> 6) == 3 && op2 == 0xEF {
                    a
                } else {
                    self.read_xmm_rm(vmm, modrm, ea, rm)?
                };
                let mut out = [0u8; 16];
                match op2 {
                    0xDB => {
                        for i in 0..16 {
                            out[i] = a[i] & b[i];
                        }
                    }
                    0xDF => {
                        for i in 0..16 {
                            out[i] = (!a[i]) & b[i];
                        }
                    }
                    0xEB => {
                        for i in 0..16 {
                            out[i] = a[i] | b[i];
                        }
                    }
                    0xEF => {
                        for i in 0..16 {
                            out[i] = a[i] ^ b[i];
                        }
                    }
                    0xFC => {
                        for i in 0..16 {
                            out[i] = a[i].wrapping_add(b[i]);
                        }
                    }
                    0xF8 => {
                        for i in 0..16 {
                            out[i] = a[i].wrapping_sub(b[i]);
                        }
                    }
                    0xFD | 0xF9 | 0xD5 => {
                        for i in 0..8 {
                            let x = u16::from_le_bytes(a[i * 2..i * 2 + 2].try_into().unwrap());
                            let y = u16::from_le_bytes(b[i * 2..i * 2 + 2].try_into().unwrap());
                            let r = match op2 {
                                0xFD => x.wrapping_add(y),
                                0xF9 => x.wrapping_sub(y),
                                0xD5 => x.wrapping_mul(y),
                                _ => unreachable!(),
                            };
                            out[i * 2..i * 2 + 2].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    0xFE | 0xFA => {
                        for i in 0..4 {
                            let x = u32::from_le_bytes(a[i * 4..i * 4 + 4].try_into().unwrap());
                            let y = u32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
                            let r = if op2 == 0xFE {
                                x.wrapping_add(y)
                            } else {
                                x.wrapping_sub(y)
                            };
                            out[i * 4..i * 4 + 4].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    0xD4 | 0xFB => {
                        for i in 0..2 {
                            let x = u64::from_le_bytes(a[i * 8..i * 8 + 8].try_into().unwrap());
                            let y = u64::from_le_bytes(b[i * 8..i * 8 + 8].try_into().unwrap());
                            let r = if op2 == 0xD4 {
                                x.wrapping_add(y)
                            } else {
                                x.wrapping_sub(y)
                            };
                            out[i * 8..i * 8 + 8].copy_from_slice(&r.to_le_bytes());
                        }
                    }
                    _ => unreachable!(),
                }
                self.set_xmm_preserve_upper(reg, &out);
                Ok(Some(ExecOutcome::Next))
            }
            0xD6 if pp == 1 => {
                // movq xmm2/m64, xmm1
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let lo = u64::from_le_bytes(self.get_xmm(reg)[0..8].try_into().unwrap());
                if (modrm >> 6) == 3 {
                    let mut out = [0u8; 16];
                    out[0..8].copy_from_slice(&lo.to_le_bytes());
                    self.set_xmm_preserve_upper(rm, &out);
                } else {
                    vmm.write_u64(ea, lo)?;
                }
                Ok(Some(ExecOutcome::Next))
            }
            0xD7 if pp == 1 => {
                // pmovmskb r32, xmm
                let (_modrm, reg, rm, _ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let x = self.get_xmm(rm);
                let mut mask = 0u32;
                for i in 0..16 {
                    if (x[i] & 0x80) != 0 {
                        mask |= 1 << i;
                    }
                }
                self.gpr[reg] = mask as u64;
                Ok(Some(ExecOutcome::Next))
            }
            0xE6 => {
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let s = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                let mut out = [0u8; 16];
                match pp {
                    2 => {
                        // cvtdq2pd
                        let i0 = i32::from_le_bytes(s[0..4].try_into().unwrap()) as f64;
                        let i1 = i32::from_le_bytes(s[4..8].try_into().unwrap()) as f64;
                        out[0..8].copy_from_slice(&i0.to_le_bytes());
                        out[8..16].copy_from_slice(&i1.to_le_bytes());
                    }
                    1 | 3 => {
                        // cvttpd2dq (66) / cvtpd2dq (F2)
                        let trunc = pp == 1;
                        for lane in 0..2 {
                            let d = f64::from_le_bytes(s[lane * 8..lane * 8 + 8].try_into().unwrap());
                            let r = if trunc { d.trunc() } else { d.round_ties_even() };
                            let iv = if !r.is_finite() || r < i32::MIN as f64 || r >= 2147483648.0f64 {
                                i32::MIN
                            } else {
                                r as i32
                            };
                            out[lane * 4..lane * 4 + 4].copy_from_slice(&iv.to_le_bytes());
                        }
                    }
                    _ => {}
                }
                self.set_xmm_preserve_upper(reg, &out);
                Ok(Some(ExecOutcome::Next))
            }
            0xF0 if pp == 3 => {
                // lddqu
                let (modrm, reg, rm, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
                let v = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                self.set_xmm_preserve_upper(reg, &v);
                Ok(Some(ExecOutcome::Next))
            }
            _ => Ok(None),
        }
    }

    /// Executes VEX-encoded AVX / AVX2 / FMA3 / BMI instructions (`C5` 2-byte or `C4` 3-byte VEX).
    pub fn exec_vex(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        vex_op: u8,
        seg_override: u8,
        addr_32: bool,
        code: &[u8],
        cursor: &mut usize,
        insn_rip: u64,
    ) -> Result<ExecOutcome, MemoryTrap> {
        let mut pfx = Prefixes::default();
        pfx.seg = seg_override;
        pfx.asz_67 = addr_32;

        let (mmmmm, vex_l, vvvv, pp): (u8, bool, usize, u8);
        if vex_op == 0xC5 {
            let b1 = code[*cursor];
            *cursor += 1;
            pfx.rex_r = (b1 & 0x80) == 0;
            vvvv = (((!b1) >> 3) & 0x0F) as usize;
            vex_l = (b1 & 0x04) != 0;
            pp = b1 & 0x03;
            mmmmm = 1;
        } else {
            let b1 = code[*cursor];
            let b2 = code[*cursor + 1];
            *cursor += 2;
            pfx.rex_r = (b1 & 0x80) == 0;
            pfx.rex_x = (b1 & 0x40) == 0;
            pfx.rex_b = (b1 & 0x20) == 0;
            mmmmm = b1 & 0x1F;
            pfx.rex_w = (b2 & 0x80) != 0;
            vvvv = (((!b2) >> 3) & 0x0F) as usize;
            vex_l = (b2 & 0x04) != 0;
            pp = b2 & 0x03;
        }

        let op = code[*cursor];
        *cursor += 1;

        if mmmmm == 1 {
            if op == 0x77 {
                // vzeroupper / vzeroall
                for r in 0..16 {
                    if vex_l {
                        self.ymm[r] = [0u8; 32];
                    } else {
                        self.ymm[r][16..32].fill(0);
                    }
                }
                return Ok(ExecOutcome::Next);
            }

            let adj_rip = if op == 0xC2 { insn_rip + 1 } else { insn_rip };
            let (modrm, reg, rm, ea) = self.decode_modrm_ea(&pfx, code, cursor, adj_rip)?;
            match op {
                0x10 | 0x28 | 0x6F => {
                    match pp {
                        0 | 1 if op != 0x6F || pp == 1 => {
                            if vex_l {
                                let v = self.read_ymm_rm(vmm, modrm, ea, rm)?;
                                self.set_ymm(reg, &v);
                            } else {
                                let v = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                                self.set_xmm_vex_zero_upper(reg, &v);
                            }
                        }
                        2 if op == 0x6F => {
                            if vex_l {
                                let v = self.read_ymm_rm(vmm, modrm, ea, rm)?;
                                self.set_ymm(reg, &v);
                            } else {
                                let v = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                                self.set_xmm_vex_zero_upper(reg, &v);
                            }
                        }
                        2 => {
                            // vmovss
                            if (modrm >> 6) == 3 {
                                let mut out = self.get_xmm(vvvv);
                                let src = self.get_xmm(rm);
                                out[0..4].copy_from_slice(&src[0..4]);
                                self.set_xmm_vex_zero_upper(reg, &out);
                            } else {
                                let v = vmm.read_u32(ea)?;
                                let mut out = [0u8; 16];
                                out[0..4].copy_from_slice(&v.to_le_bytes());
                                self.set_xmm_vex_zero_upper(reg, &out);
                            }
                        }
                        3 => {
                            // vmovsd
                            if (modrm >> 6) == 3 {
                                let mut out = self.get_xmm(vvvv);
                                let src = self.get_xmm(rm);
                                out[0..8].copy_from_slice(&src[0..8]);
                                self.set_xmm_vex_zero_upper(reg, &out);
                            } else {
                                let v = vmm.read_u64(ea)?;
                                let mut out = [0u8; 16];
                                out[0..8].copy_from_slice(&v.to_le_bytes());
                                self.set_xmm_vex_zero_upper(reg, &out);
                            }
                        }
                        _ => {}
                    }
                    Ok(ExecOutcome::Next)
                }
                0x11 | 0x29 | 0x7F => {
                    if op != 0x11 || pp == 0 || pp == 1 {
                        if vex_l {
                            let s = self.get_ymm(reg);
                            if (modrm >> 6) == 3 {
                                self.set_ymm(rm, &s);
                            } else {
                                vmm.write_u256(ea, &s)?;
                            }
                        } else {
                            let s = self.get_xmm(reg);
                            if (modrm >> 6) == 3 {
                                self.set_xmm_vex_zero_upper(rm, &s);
                            } else {
                                vmm.write_u128(ea, &s)?;
                            }
                        }
                    } else if pp == 2 {
                        let s = self.get_xmm(reg);
                        if (modrm >> 6) == 3 {
                            let mut out = self.get_xmm(vvvv);
                            out[0..4].copy_from_slice(&s[0..4]);
                            self.set_xmm_vex_zero_upper(rm, &out);
                        } else {
                            vmm.write_bytes(ea, &s[0..4])?;
                        }
                    } else if pp == 3 {
                        let s = self.get_xmm(reg);
                        if (modrm >> 6) == 3 {
                            let mut out = self.get_xmm(vvvv);
                            out[0..8].copy_from_slice(&s[0..8]);
                            self.set_xmm_vex_zero_upper(rm, &out);
                        } else {
                            vmm.write_bytes(ea, &s[0..8])?;
                        }
                    }
                    Ok(ExecOutcome::Next)
                }
                0x2E | 0x2F => {
                    if pp == 1 {
                        let a = f64::from_le_bytes(self.get_xmm(reg)[0..8].try_into().unwrap());
                        let b = self.read_f64_rm(vmm, modrm, ea, rm)?;
                        self.set_ucomi_flags_f64(a, b);
                    } else {
                        let a = f32::from_le_bytes(self.get_xmm(reg)[0..4].try_into().unwrap()) as f64;
                        let b = self.read_f32_rm(vmm, modrm, ea, rm)? as f64;
                        self.set_ucomi_flags_f64(a, b);
                    }
                    Ok(ExecOutcome::Next)
                }
                0x54 | 0x55 | 0x56 | 0x57 | 0xDB | 0xDF | 0xEB | 0xEF => {
                    let a = self.get_ymm(vvvv);
                    let b = if vex_l {
                        self.read_ymm_rm(vmm, modrm, ea, rm)?
                    } else {
                        let x = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                        let mut y = [0u8; 32];
                        y[0..16].copy_from_slice(&x);
                        y
                    };
                    let len = if vex_l { 32 } else { 16 };
                    let mut out = [0u8; 32];
                    for i in 0..len {
                        out[i] = match op {
                            0x54 | 0xDB => a[i] & b[i],
                            0x55 | 0xDF => (!a[i]) & b[i],
                            0x56 | 0xEB => a[i] | b[i],
                            0x57 | 0xEF => a[i] ^ b[i],
                            _ => unreachable!(),
                        };
                    }
                    self.set_ymm(reg, &out);
                    Ok(ExecOutcome::Next)
                }
                0x51 | 0x58 | 0x59 | 0x5C | 0x5D | 0x5E | 0x5F => {
                    match pp {
                        0 => {
                            let lanes = if vex_l { 8 } else { 4 };
                            let a = self.get_ymm(vvvv);
                            let b = if vex_l {
                                self.read_ymm_rm(vmm, modrm, ea, rm)?
                            } else {
                                let x = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                                let mut y = [0u8; 32];
                                y[0..16].copy_from_slice(&x);
                                y
                            };
                            let mut out = [0u8; 32];
                            for i in 0..lanes {
                                let o = i * 4;
                                let x = f32::from_le_bytes(a[o..o + 4].try_into().unwrap());
                                let y = f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
                                let r = match op {
                                    0x51 => y.sqrt(),
                                    0x58 => x + y,
                                    0x59 => x * y,
                                    0x5C => x - y,
                                    0x5D => if x < y { x } else { y },
                                    0x5E => x / y,
                                    0x5F => if x > y { x } else { y },
                                    _ => x,
                                };
                                out[o..o + 4].copy_from_slice(&r.to_le_bytes());
                            }
                            self.set_ymm(reg, &out);
                        }
                        1 => {
                            let lanes = if vex_l { 4 } else { 2 };
                            let a = self.get_ymm(vvvv);
                            let b = if vex_l {
                                self.read_ymm_rm(vmm, modrm, ea, rm)?
                            } else {
                                let x = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                                let mut y = [0u8; 32];
                                y[0..16].copy_from_slice(&x);
                                y
                            };
                            let mut out = [0u8; 32];
                            for i in 0..lanes {
                                let o = i * 8;
                                let x = f64::from_le_bytes(a[o..o + 8].try_into().unwrap());
                                let y = f64::from_le_bytes(b[o..o + 8].try_into().unwrap());
                                let r = match op {
                                    0x51 => y.sqrt(),
                                    0x58 => x + y,
                                    0x59 => x * y,
                                    0x5C => x - y,
                                    0x5D => if x < y { x } else { y },
                                    0x5E => x / y,
                                    0x5F => if x > y { x } else { y },
                                    _ => x,
                                };
                                out[o..o + 8].copy_from_slice(&r.to_le_bytes());
                            }
                            self.set_ymm(reg, &out);
                        }
                        2 => {
                            let mut out = self.get_xmm(vvvv);
                            let x = f32::from_le_bytes(out[0..4].try_into().unwrap());
                            let y = self.read_f32_rm(vmm, modrm, ea, rm)?;
                            let r = match op {
                                0x51 => y.sqrt(),
                                0x58 => x + y,
                                0x59 => x * y,
                                0x5C => x - y,
                                0x5D => if x < y { x } else { y },
                                0x5E => x / y,
                                0x5F => if x > y { x } else { y },
                                _ => x,
                            };
                            out[0..4].copy_from_slice(&r.to_le_bytes());
                            self.set_xmm_vex_zero_upper(reg, &out);
                        }
                        3 => {
                            let mut out = self.get_xmm(vvvv);
                            let x = f64::from_le_bytes(out[0..8].try_into().unwrap());
                            let y = self.read_f64_rm(vmm, modrm, ea, rm)?;
                            let r = match op {
                                0x51 => y.sqrt(),
                                0x58 => x + y,
                                0x59 => x * y,
                                0x5C => x - y,
                                0x5D => if x < y { x } else { y },
                                0x5E => x / y,
                                0x5F => if x > y { x } else { y },
                                _ => x,
                            };
                            out[0..8].copy_from_slice(&r.to_le_bytes());
                            self.set_xmm_vex_zero_upper(reg, &out);
                        }
                        _ => {}
                    }
                    Ok(ExecOutcome::Next)
                }
                0x5A => {
                    if pp == 2 {
                        // vcvtss2sd xmm1, xmm2, xmm3/m32
                        let mut out = self.get_xmm(vvvv);
                        let s = self.read_f32_rm(vmm, modrm, ea, rm)? as f64;
                        out[0..8].copy_from_slice(&s.to_le_bytes());
                        self.set_xmm_vex_zero_upper(reg, &out);
                    } else if pp == 3 {
                        let mut out = self.get_xmm(vvvv);
                        let s = self.read_f64_rm(vmm, modrm, ea, rm)? as f32;
                        out[0..4].copy_from_slice(&s.to_le_bytes());
                        self.set_xmm_vex_zero_upper(reg, &out);
                    }
                    Ok(ExecOutcome::Next)
                }
                0x6E if pp == 1 => {
                    let mut out = [0u8; 16];
                    if pfx.rex_w {
                        let v = if (modrm >> 6) == 3 { self.gpr[rm] } else { vmm.read_u64(ea)? };
                        out[0..8].copy_from_slice(&v.to_le_bytes());
                    } else {
                        let v = if (modrm >> 6) == 3 {
                            self.gpr[rm] as u32
                        } else {
                            vmm.read_u32(ea)?
                        };
                        out[0..4].copy_from_slice(&v.to_le_bytes());
                    }
                    self.set_xmm_vex_zero_upper(reg, &out);
                    Ok(ExecOutcome::Next)
                }
                0x7E => {
                    if pp == 2 {
                        let lo = if (modrm >> 6) == 3 {
                            u64::from_le_bytes(self.get_xmm(rm)[0..8].try_into().unwrap())
                        } else {
                            vmm.read_u64(ea)?
                        };
                        let mut out = [0u8; 16];
                        out[0..8].copy_from_slice(&lo.to_le_bytes());
                        self.set_xmm_vex_zero_upper(reg, &out);
                    } else if pp == 1 {
                        let src = self.get_xmm(reg);
                        if pfx.rex_w {
                            let v = u64::from_le_bytes(src[0..8].try_into().unwrap());
                            if (modrm >> 6) == 3 {
                                self.gpr[rm] = v;
                            } else {
                                vmm.write_u64(ea, v)?;
                            }
                        } else {
                            let v = u32::from_le_bytes(src[0..4].try_into().unwrap());
                            if (modrm >> 6) == 3 {
                                self.gpr[rm] = v as u64;
                            } else {
                                vmm.write_u32(ea, v)?;
                            }
                        }
                    }
                    Ok(ExecOutcome::Next)
                }
                0xC2 => {
                    let imm = code[*cursor];
                    *cursor += 1;
                    match pp {
                        0 => {
                            let lanes = if vex_l { 8 } else { 4 };
                            let a = self.get_ymm(vvvv);
                            let b = if vex_l {
                                self.read_ymm_rm(vmm, modrm, ea, rm)?
                            } else {
                                let x = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                                let mut y = [0u8; 32];
                                y[0..16].copy_from_slice(&x);
                                y
                            };
                            let mut out = [0u8; 32];
                            for i in 0..lanes {
                                let x = f32::from_le_bytes(a[i * 4..i * 4 + 4].try_into().unwrap());
                                let y = f32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
                                let m: u32 = if cmp_f32_pred(x, y, imm) { 0xFFFF_FFFF } else { 0 };
                                out[i * 4..i * 4 + 4].copy_from_slice(&m.to_le_bytes());
                            }
                            self.set_ymm(reg, &out);
                        }
                        2 => {
                            let mut out = self.get_xmm(vvvv);
                            let x = f32::from_le_bytes(out[0..4].try_into().unwrap());
                            let y = self.read_f32_rm(vmm, modrm, ea, rm)?;
                            let m: u32 = if cmp_f32_pred(x, y, imm) { 0xFFFF_FFFF } else { 0 };
                            out[0..4].copy_from_slice(&m.to_le_bytes());
                            self.set_xmm_vex_zero_upper(reg, &out);
                        }
                        _ => {}
                    }
                    Ok(ExecOutcome::Next)
                }
                0xFE | 0xFA | 0xFC | 0xFD | 0xD4 if pp == 1 => {
                    // vpaddd / vpsubd / vpaddb / vpaddw / vpaddq (128-bit or 256-bit AVX2!)
                    let a = self.get_ymm(vvvv);
                    let b = if vex_l {
                        self.read_ymm_rm(vmm, modrm, ea, rm)?
                    } else {
                        let x = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                        let mut y = [0u8; 32];
                        y[0..16].copy_from_slice(&x);
                        y
                    };
                    let bytes = if vex_l { 32 } else { 16 };
                    let mut out = [0u8; 32];
                    match op {
                        0xFE | 0xFA => {
                            for i in 0..(bytes / 4) {
                                let x = u32::from_le_bytes(a[i * 4..i * 4 + 4].try_into().unwrap());
                                let y = u32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
                                let r = if op == 0xFE {
                                    x.wrapping_add(y)
                                } else {
                                    x.wrapping_sub(y)
                                };
                                out[i * 4..i * 4 + 4].copy_from_slice(&r.to_le_bytes());
                            }
                        }
                        0xFC => {
                            for i in 0..bytes {
                                out[i] = a[i].wrapping_add(b[i]);
                            }
                        }
                        0xFD => {
                            for i in 0..(bytes / 2) {
                                let x = u16::from_le_bytes(a[i * 2..i * 2 + 2].try_into().unwrap());
                                let y = u16::from_le_bytes(b[i * 2..i * 2 + 2].try_into().unwrap());
                                out[i * 2..i * 2 + 2].copy_from_slice(&x.wrapping_add(y).to_le_bytes());
                            }
                        }
                        0xD4 => {
                            for i in 0..(bytes / 8) {
                                let x = u64::from_le_bytes(a[i * 8..i * 8 + 8].try_into().unwrap());
                                let y = u64::from_le_bytes(b[i * 8..i * 8 + 8].try_into().unwrap());
                                out[i * 8..i * 8 + 8].copy_from_slice(&x.wrapping_add(y).to_le_bytes());
                            }
                        }
                        _ => unreachable!(),
                    }
                    self.set_ymm(reg, &out);
                    Ok(ExecOutcome::Next)
                }
                _ => Ok(ExecOutcome::Fault(format!("Unimplemented VEX.0F op 0x{op:02x} pp={pp}"))),
            }
        } else if mmmmm == 2 {
            // 0F 38 map: vbroadcastss (18), vpbroadcastd (58), vpmulld (40), shlx/sarx/shrx (F7), andn (F2)
            let (modrm, reg, rm, ea) = self.decode_modrm_ea(&pfx, code, cursor, insn_rip)?;
            match op {
                0x18 | 0x58 => {
                    let v = if (modrm >> 6) == 3 {
                        u32::from_le_bytes(self.get_xmm(rm)[0..4].try_into().unwrap())
                    } else {
                        vmm.read_u32(ea)?
                    };
                    let lanes = if vex_l { 8 } else { 4 };
                    let mut out = [0u8; 32];
                    for i in 0..lanes {
                        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
                    }
                    self.set_ymm(reg, &out);
                    Ok(ExecOutcome::Next)
                }
                0x40 => {
                    // vpmulld
                    let a = self.get_ymm(vvvv);
                    let b = if vex_l {
                        self.read_ymm_rm(vmm, modrm, ea, rm)?
                    } else {
                        let x = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                        let mut y = [0u8; 32];
                        y[0..16].copy_from_slice(&x);
                        y
                    };
                    let lanes = if vex_l { 8 } else { 4 };
                    let mut out = [0u8; 32];
                    for i in 0..lanes {
                        let x = i32::from_le_bytes(a[i * 4..i * 4 + 4].try_into().unwrap());
                        let y = i32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
                        out[i * 4..i * 4 + 4].copy_from_slice(&x.wrapping_mul(y).to_le_bytes());
                    }
                    self.set_ymm(reg, &out);
                    Ok(ExecOutcome::Next)
                }
                0xF7 => {
                    // BMI2 shlx (pp=1), sarx (pp=2), shrx (pp=3)
                    let cnt_raw = self.gpr[vvvv];
                    if pfx.rex_w {
                        let val = if (modrm >> 6) == 3 { self.gpr[rm] } else { vmm.read_u64(ea)? };
                        let cnt = (cnt_raw & 63) as u32;
                        self.gpr[reg] = match pp {
                            1 => val << cnt,
                            2 => ((val as i64) >> cnt) as u64,
                            3 => val >> cnt,
                            _ => val,
                        };
                    } else {
                        let val = if (modrm >> 6) == 3 {
                            self.gpr[rm] as u32
                        } else {
                            vmm.read_u32(ea)?
                        };
                        let cnt = (cnt_raw & 31) as u32;
                        let r = match pp {
                            1 => val << cnt,
                            2 => ((val as i32) >> cnt) as u32,
                            3 => val >> cnt,
                            _ => val,
                        };
                        self.gpr[reg] = r as u64;
                    }
                    Ok(ExecOutcome::Next)
                }
                _ => Ok(ExecOutcome::Fault(format!("Unimplemented VEX.0F38 op 0x{op:02x}"))),
            }
        } else if mmmmm == 3 {
            // 0F 3A map: vinsertf128/i128 (18/38), vextractf128/i128 (19/39)
            let (modrm, reg, rm, ea) = self.decode_modrm_ea(&pfx, code, cursor, insn_rip + 1)?;
            let imm = code[*cursor];
            *cursor += 1;
            match op {
                0x18 | 0x38 => {
                    let mut out = self.get_ymm(vvvv);
                    let lane = self.read_xmm_rm(vmm, modrm, ea, rm)?;
                    if (imm & 1) == 0 {
                        out[0..16].copy_from_slice(&lane);
                    } else {
                        out[16..32].copy_from_slice(&lane);
                    }
                    self.set_ymm(reg, &out);
                    Ok(ExecOutcome::Next)
                }
                0x19 | 0x39 => {
                    let src = self.get_ymm(reg);
                    let mut lane = [0u8; 16];
                    if (imm & 1) == 0 {
                        lane.copy_from_slice(&src[0..16]);
                    } else {
                        lane.copy_from_slice(&src[16..32]);
                    }
                    if (modrm >> 6) == 3 {
                        self.set_xmm_vex_zero_upper(rm, &lane);
                    } else {
                        vmm.write_u128(ea, &lane)?;
                    }
                    Ok(ExecOutcome::Next)
                }
                _ => Ok(ExecOutcome::Fault(format!("Unimplemented VEX.0F3A op 0x{op:02x}"))),
            }
        } else {
            Ok(ExecOutcome::Fault(format!("Invalid VEX mmmmm {mmmmm}")))
        }
    }

    #[inline]
    fn x87_idx(&self, i: usize) -> usize {
        (self.fpu_top.wrapping_add(i as u8) & 7) as usize
    }

    #[inline]
    fn x87_push(&mut self, val: f64) {
        self.fpu_top = self.fpu_top.wrapping_sub(1) & 7;
        self.fpu_regs[self.fpu_top as usize] = val;
    }

    #[inline]
    fn x87_pop(&mut self) -> f64 {
        let v = self.fpu_regs[self.fpu_top as usize];
        self.fpu_top = self.fpu_top.wrapping_add(1) & 7;
        v
    }

    /// Executes x87 FPU instructions (`0xD8..=0xDF`).
    pub fn exec_x87(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        pfx: &Prefixes,
        esc: u8,
        code: &[u8],
        cursor: &mut usize,
        insn_rip: u64,
    ) -> Result<ExecOutcome, MemoryTrap> {
        let (modrm, subop_ext, _rm_ext, ea) = self.decode_modrm_ea(pfx, code, cursor, insn_rip)?;
        let subop = subop_ext & 7;
        let st_i = (modrm & 7) as usize;
        let is_reg = (modrm >> 6) == 3;

        match esc {
            0xD8 => {
                let rhs = if is_reg {
                    self.fpu_regs[self.x87_idx(st_i)]
                } else {
                    f32::from_bits(vmm.read_u32(ea)?) as f64
                };
                let st0 = self.fpu_regs[self.x87_idx(0)];
                match subop {
                    0 => self.fpu_regs[self.x87_idx(0)] = st0 + rhs,
                    1 => self.fpu_regs[self.x87_idx(0)] = st0 * rhs,
                    2 => {} // fcom
                    3 => {
                        let _ = self.x87_pop();
                    }
                    4 => self.fpu_regs[self.x87_idx(0)] = st0 - rhs,
                    5 => self.fpu_regs[self.x87_idx(0)] = rhs - st0,
                    6 => self.fpu_regs[self.x87_idx(0)] = st0 / rhs,
                    7 => self.fpu_regs[self.x87_idx(0)] = rhs / st0,
                    _ => {}
                }
            }
            0xD9 => {
                if is_reg {
                    match modrm {
                        0xC0..=0xC7 => {
                            let v = self.fpu_regs[self.x87_idx(st_i)];
                            self.x87_push(v);
                        }
                        0xC8..=0xCF => {
                            let i0 = self.x87_idx(0);
                            let ii = self.x87_idx(st_i);
                            self.fpu_regs.swap(i0, ii);
                        }
                        0xE0 => self.fpu_regs[self.x87_idx(0)] = -self.fpu_regs[self.x87_idx(0)],
                        0xE1 => self.fpu_regs[self.x87_idx(0)] = self.fpu_regs[self.x87_idx(0)].abs(),
                        0xE8 => self.x87_push(1.0),
                        0xEE => self.x87_push(0.0),
                        0xFA => self.fpu_regs[self.x87_idx(0)] = self.fpu_regs[self.x87_idx(0)].sqrt(),
                        0xFC => {
                            let v = self.fpu_regs[self.x87_idx(0)];
                            let rc = (self.fpu_cw >> 10) & 3;
                            self.fpu_regs[self.x87_idx(0)] = match rc {
                                0 => v.round_ties_even(),
                                1 => v.floor(),
                                2 => v.ceil(),
                                _ => v.trunc(),
                            };
                        }
                        0xFD => {
                            // fscale: ST(0) = ST(0) * 2^trunc(ST(1))
                            let st0 = self.fpu_regs[self.x87_idx(0)];
                            let st1 = self.fpu_regs[self.x87_idx(1)].trunc() as i32;
                            self.fpu_regs[self.x87_idx(0)] = st0 * 2.0f64.powi(st1);
                        }
                        _ => {}
                    }
                } else {
                    match subop {
                        0 => {
                            let v = f32::from_bits(vmm.read_u32(ea)?) as f64;
                            self.x87_push(v);
                        }
                        2 => {
                            let v = self.fpu_regs[self.x87_idx(0)] as f32;
                            vmm.write_u32(ea, v.to_bits())?;
                        }
                        3 => {
                            let v = self.x87_pop() as f32;
                            vmm.write_u32(ea, v.to_bits())?;
                        }
                        4 => {
                            // fldenv (28 bytes)
                            self.fpu_cw = vmm.read_u16(ea)?;
                            self.fpu_sw = vmm.read_u16(ea + 4)?;
                            self.fpu_top = ((self.fpu_sw >> 11) & 7) as u8;
                        }
                        5 => {
                            self.fpu_cw = vmm.read_u16(ea)?;
                        }
                        6 => {
                            // fnstenv (28 bytes)
                            let mut env = [0u8; 28];
                            let sw = (self.fpu_sw & !0x3800) | (((self.fpu_top as u16) & 7) << 11);
                            env[0..2].copy_from_slice(&self.fpu_cw.to_le_bytes());
                            env[4..6].copy_from_slice(&sw.to_le_bytes());
                            env[8..10].copy_from_slice(&0xFFFFu16.to_le_bytes());
                            vmm.write_bytes(ea, &env)?;
                        }
                        7 => {
                            vmm.write_u16(ea, self.fpu_cw)?;
                        }
                        _ => {}
                    }
                }
            }
            0xDA => {
                if is_reg {
                    let cond = match subop {
                        0 => (self.rflags & 0x001) != 0, // fcmovb
                        1 => (self.rflags & 0x040) != 0, // fcmove
                        2 => (self.rflags & 0x041) != 0, // fcmovbe
                        3 => (self.rflags & 0x004) != 0, // fcmovu
                        _ => false,
                    };
                    if cond {
                        self.fpu_regs[self.x87_idx(0)] = self.fpu_regs[self.x87_idx(st_i)];
                    }
                } else {
                    let rhs = (vmm.read_u32(ea)? as i32) as f64;
                    let st0 = self.fpu_regs[self.x87_idx(0)];
                    match subop {
                        0 => self.fpu_regs[self.x87_idx(0)] = st0 + rhs,
                        1 => self.fpu_regs[self.x87_idx(0)] = st0 * rhs,
                        4 => self.fpu_regs[self.x87_idx(0)] = st0 - rhs,
                        5 => self.fpu_regs[self.x87_idx(0)] = rhs - st0,
                        6 => self.fpu_regs[self.x87_idx(0)] = st0 / rhs,
                        7 => self.fpu_regs[self.x87_idx(0)] = rhs / st0,
                        _ => {}
                    }
                }
            }
            0xDB => {
                if is_reg {
                    match modrm {
                        0xE3 => {
                            // fninit
                            self.fpu_cw = 0x037F;
                            self.fpu_sw = 0;
                            self.fpu_top = 0;
                            self.fpu_regs = [0.0; 8];
                        }
                        0xE8..=0xF7 => {
                            // fucomi / fcomi
                            let a = self.fpu_regs[self.x87_idx(0)];
                            let b = self.fpu_regs[self.x87_idx(st_i)];
                            self.set_ucomi_flags_f64(a, b);
                        }
                        _ => {
                            let cond = match subop {
                                0 => (self.rflags & 0x001) == 0, // fcmovnb
                                1 => (self.rflags & 0x040) == 0, // fcmovne
                                2 => (self.rflags & 0x041) == 0, // fcmovnbe
                                3 => (self.rflags & 0x004) == 0, // fcmovnu
                                _ => false,
                            };
                            if cond {
                                self.fpu_regs[self.x87_idx(0)] = self.fpu_regs[self.x87_idx(st_i)];
                            }
                        }
                    }
                } else {
                    match subop {
                        0 => {
                            let v = (vmm.read_u32(ea)? as i32) as f64;
                            self.x87_push(v);
                        }
                        2 => {
                            let v = self.fpu_regs[self.x87_idx(0)].round_ties_even() as i32;
                            vmm.write_u32(ea, v as u32)?;
                        }
                        3 => {
                            let v = self.x87_pop().round_ties_even() as i32;
                            vmm.write_u32(ea, v as u32)?;
                        }
                        5 => {
                            let mut b = [0u8; 10];
                            vmm.read_bytes(ea, &mut b)?;
                            self.x87_push(f80_to_f64(&b));
                        }
                        7 => {
                            let v = self.x87_pop();
                            let b = f64_to_f80(v);
                            vmm.write_bytes(ea, &b)?;
                        }
                        _ => {}
                    }
                }
            }
            0xDC => {
                if is_reg {
                    let st0 = self.fpu_regs[self.x87_idx(0)];
                    let sti = self.fpu_regs[self.x87_idx(st_i)];
                    let dst = self.x87_idx(st_i);
                    match subop {
                        0 => self.fpu_regs[dst] = sti + st0,
                        1 => self.fpu_regs[dst] = sti * st0,
                        4 => self.fpu_regs[dst] = st0 - sti, // fsubr st(i), st(0) => st(0) - st(i)
                        5 => self.fpu_regs[dst] = sti - st0, // fsub st(i), st(0) => st(i) - st(0)
                        6 => self.fpu_regs[dst] = st0 / sti, // fdivr st(i), st(0)
                        7 => self.fpu_regs[dst] = sti / st0, // fdiv st(i), st(0)
                        _ => {}
                    }
                } else {
                    let rhs = f64::from_bits(vmm.read_u64(ea)?);
                    let st0 = self.fpu_regs[self.x87_idx(0)];
                    match subop {
                        0 => self.fpu_regs[self.x87_idx(0)] = st0 + rhs,
                        1 => self.fpu_regs[self.x87_idx(0)] = st0 * rhs,
                        4 => self.fpu_regs[self.x87_idx(0)] = st0 - rhs,
                        5 => self.fpu_regs[self.x87_idx(0)] = rhs - st0,
                        6 => self.fpu_regs[self.x87_idx(0)] = st0 / rhs,
                        7 => self.fpu_regs[self.x87_idx(0)] = rhs / st0,
                        _ => {}
                    }
                }
            }
            0xDD => {
                if is_reg {
                    match subop {
                        2 => self.fpu_regs[self.x87_idx(st_i)] = self.fpu_regs[self.x87_idx(0)],
                        3 => {
                            let v = self.fpu_regs[self.x87_idx(0)];
                            self.fpu_regs[self.x87_idx(st_i)] = v;
                            let _ = self.x87_pop();
                        }
                        _ => {}
                    }
                } else {
                    match subop {
                        0 => {
                            let v = f64::from_bits(vmm.read_u64(ea)?);
                            self.x87_push(v);
                        }
                        2 => {
                            let v = self.fpu_regs[self.x87_idx(0)];
                            vmm.write_u64(ea, v.to_bits())?;
                        }
                        3 => {
                            let v = self.x87_pop();
                            vmm.write_u64(ea, v.to_bits())?;
                        }
                        7 => {
                            let sw = (self.fpu_sw & !0x3800) | (((self.fpu_top as u16) & 7) << 11);
                            vmm.write_u16(ea, sw)?;
                        }
                        _ => {}
                    }
                }
            }
            0xDE => {
                if is_reg {
                    let st0 = self.fpu_regs[self.x87_idx(0)];
                    let sti = self.fpu_regs[self.x87_idx(st_i)];
                    let dst = self.x87_idx(st_i);
                    match subop {
                        0 => {
                            self.fpu_regs[dst] = sti + st0;
                            let _ = self.x87_pop();
                        }
                        1 => {
                            self.fpu_regs[dst] = sti * st0;
                            let _ = self.x87_pop();
                        }
                        3 => {
                            let _ = self.x87_pop();
                            let _ = self.x87_pop();
                        }
                        4 => {
                            self.fpu_regs[dst] = st0 - sti;
                            let _ = self.x87_pop();
                        }
                        5 => {
                            self.fpu_regs[dst] = sti - st0;
                            let _ = self.x87_pop();
                        }
                        6 => {
                            self.fpu_regs[dst] = st0 / sti;
                            let _ = self.x87_pop();
                        }
                        7 => {
                            self.fpu_regs[dst] = sti / st0;
                            let _ = self.x87_pop();
                        }
                        _ => {}
                    }
                } else {
                    let rhs = (vmm.read_u16(ea)? as i16) as f64;
                    let st0 = self.fpu_regs[self.x87_idx(0)];
                    if subop == 0 {
                        self.fpu_regs[self.x87_idx(0)] = st0 + rhs;
                    }
                }
            }
            0xDF => {
                if is_reg {
                    match modrm {
                        0xE0 => {
                            let sw = (self.fpu_sw & !0x3800) | (((self.fpu_top as u16) & 7) << 11);
                            self.gpr[0] = (self.gpr[0] & !0xFFFF) | (sw as u64);
                        }
                        0xE8..=0xF7 => {
                            let a = self.fpu_regs[self.x87_idx(0)];
                            let b = self.fpu_regs[self.x87_idx(st_i)];
                            self.set_ucomi_flags_f64(a, b);
                            let _ = self.x87_pop();
                        }
                        _ => {}
                    }
                } else {
                    match subop {
                        0 => {
                            let v = (vmm.read_u16(ea)? as i16) as f64;
                            self.x87_push(v);
                        }
                        2 => {
                            let v = self.fpu_regs[self.x87_idx(0)].round_ties_even() as i16;
                            vmm.write_u16(ea, v as u16)?;
                        }
                        3 => {
                            let v = self.x87_pop().round_ties_even() as i16;
                            vmm.write_u16(ea, v as u16)?;
                        }
                        5 => {
                            let v = (vmm.read_u64(ea)? as i64) as f64;
                            self.x87_push(v);
                        }
                        7 => {
                            let rc = (self.fpu_cw >> 10) & 3;
                            let raw = self.x87_pop();
                            let r = match rc {
                                0 => raw.round_ties_even(),
                                1 => raw.floor(),
                                2 => raw.ceil(),
                                _ => raw.trunc(),
                            };
                            let iv = if !r.is_finite() || r < i64::MIN as f64 || r >= 9223372036854775808.0f64 {
                                i64::MIN
                            } else {
                                r as i64
                            };
                            vmm.write_u64(ea, iv as u64)?;
                        }
                        _ => {}
                    }
                }
            }
            _ => unreachable!(),
        }
        Ok(ExecOutcome::Next)
    }
}
