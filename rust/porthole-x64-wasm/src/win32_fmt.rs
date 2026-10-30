use crate::vmm::VirtualMemoryManager;

/// Windows-1252 high table (0x80..=0x9F) for exact CP_ACP byte <-> UTF-16 mapping.
const CP1252_80_9F: [u16; 32] = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039,
    0x0152, 0x008D, 0x017D, 0x008F, 0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];

#[inline]
pub fn cp1252_byte_to_wchar(b: u8) -> u16 {
    if (0x80..=0x9F).contains(&b) {
        CP1252_80_9F[(b - 0x80) as usize]
    } else {
        b as u16
    }
}

#[inline]
pub fn wchar_to_cp1252_byte(wc: u16) -> (u8, bool) {
    if wc < 0x80 || (0xA0..=0xFF).contains(&wc) {
        return (wc as u8, false);
    }
    for (i, &u) in CP1252_80_9F.iter().enumerate() {
        if u == wc {
            return ((0x80 + i) as u8, false);
        }
    }
    (b'?', true)
}

pub fn mb_to_wide(codepage: u32, src: &[u8]) -> Vec<u16> {
    if codepage == 65001 {
        // CP_UTF8
        let s = String::from_utf8_lossy(src);
        s.encode_utf16().collect()
    } else {
        src.iter().map(|&b| cp1252_byte_to_wchar(b)).collect()
    }
}

pub fn wide_to_mb(codepage: u32, src: &[u16]) -> (Vec<u8>, bool) {
    if codepage == 65001 {
        let s = String::from_utf16_lossy(src);
        (s.into_bytes(), false)
    } else {
        let mut out = Vec::with_capacity(src.len());
        let mut used_default = false;
        for &w in src {
            let (b, def) = wchar_to_cp1252_byte(w);
            if def {
                used_default = true;
            }
            out.push(b);
        }
        (out, used_default)
    }
}

pub struct VaSlotReader {
    slots: Vec<u64>,
    idx: usize,
}

impl VaSlotReader {
    pub fn from_va_list_ptr(vmm: &mut VirtualMemoryManager, va_list_ptr: u64, max_args: usize) -> Self {
        let mut slots = Vec::with_capacity(max_args);
        if va_list_ptr != 0 {
            for i in 0..max_args {
                slots.push(vmm.read_u64(va_list_ptr + (i as u64) * 8).unwrap_or(0));
            }
        }
        Self { slots, idx: 0 }
    }

    pub fn from_varargs_slice(slice: &[u64]) -> Self {
        Self {
            slots: slice.to_vec(),
            idx: 0,
        }
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let v = self.slots.get(self.idx).copied().unwrap_or(0);
        self.idx += 1;
        v
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IntLen {
    Hh,
    H,
    Default32,
    I32,
    I64,
    Ptr64,
}

/// Formats an ANSI or Unicode `printf` / `wsprintf` format string using MS x64 8-byte `va_list` slots.
pub fn format_win64_printf(
    vmm: &mut VirtualMemoryManager,
    fmt_chars: &[u16],
    va: &mut VaSlotReader,
    is_wide_call: bool,
    wsprintf_mode: bool,
) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::with_capacity(fmt_chars.len() + 32);
    let mut i = 0usize;

    while i < fmt_chars.len() {
        let ch = fmt_chars[i];
        if ch != b'%' as u16 {
            out.push(ch);
            i += 1;
            continue;
        }
        i += 1;
        if i >= fmt_chars.len() {
            break;
        }
        if fmt_chars[i] == b'%' as u16 {
            out.push(b'%' as u16);
            i += 1;
            continue;
        }

        // Flags
        let mut flag_left = false;
        let mut flag_plus = false;
        let mut flag_space = false;
        let mut flag_zero = false;
        let mut flag_alt = false;
        while i < fmt_chars.len() {
            match fmt_chars[i] as u8 {
                b'-' if fmt_chars[i] < 128 => flag_left = true,
                b'+' if fmt_chars[i] < 128 => flag_plus = true,
                b' ' if fmt_chars[i] < 128 => flag_space = true,
                b'0' if fmt_chars[i] < 128 => flag_zero = true,
                b'#' if fmt_chars[i] < 128 => flag_alt = true,
                _ => break,
            }
            i += 1;
        }

        // Width
        let mut width: usize = 0;
        if i < fmt_chars.len() && fmt_chars[i] == b'*' as u16 && !wsprintf_mode {
            i += 1;
            let w = va.next_u64() as i32;
            if w < 0 {
                flag_left = true;
                width = (-w) as usize;
            } else {
                width = w as usize;
            }
        } else {
            while i < fmt_chars.len() && (b'0' as u16..=b'9' as u16).contains(&fmt_chars[i]) {
                width = width
                    .saturating_mul(10)
                    .saturating_add((fmt_chars[i] - b'0' as u16) as usize);
                i += 1;
            }
        }

        // Precision
        let mut precision: Option<usize> = None;
        if i < fmt_chars.len() && fmt_chars[i] == b'.' as u16 {
            i += 1;
            if i < fmt_chars.len() && fmt_chars[i] == b'*' as u16 && !wsprintf_mode {
                i += 1;
                let p = va.next_u64() as i32;
                if p >= 0 {
                    precision = Some(p as usize);
                }
            } else {
                let mut p = 0usize;
                while i < fmt_chars.len() && (b'0' as u16..=b'9' as u16).contains(&fmt_chars[i]) {
                    p = p
                        .saturating_mul(10)
                        .saturating_add((fmt_chars[i] - b'0' as u16) as usize);
                    i += 1;
                }
                precision = Some(p);
            }
        }

        // Length modifier
        let mut len_mod = IntLen::Default32;
        let mut force_wide: Option<bool> = None;
        if i < fmt_chars.len() {
            match fmt_chars[i] {
                c if c == b'h' as u16 => {
                    i += 1;
                    if i < fmt_chars.len() && fmt_chars[i] == b'h' as u16 {
                        i += 1;
                        len_mod = IntLen::Hh;
                    } else {
                        len_mod = IntLen::H;
                        force_wide = Some(false);
                    }
                }
                c if c == b'l' as u16 => {
                    i += 1;
                    if i < fmt_chars.len() && fmt_chars[i] == b'l' as u16 {
                        i += 1;
                        len_mod = IntLen::I64;
                    } else {
                        // Note: on LLP64 Windows x64, `long` (%ld/%lx) is 32-bit, whereas `%ls`/`%lc` means wide!
                        len_mod = IntLen::Default32;
                        force_wide = Some(true);
                    }
                }
                c if c == b'w' as u16 => {
                    i += 1;
                    force_wide = Some(true);
                }
                c if c == b'z' as u16 || c == b't' as u16 || c == b'j' as u16 => {
                    i += 1;
                    len_mod = IntLen::I64;
                }
                c if c == b'L' as u16 => {
                    i += 1;
                }
                c if c == b'I' as u16 => {
                    i += 1;
                    if i + 1 < fmt_chars.len()
                        && fmt_chars[i] == b'6' as u16
                        && fmt_chars[i + 1] == b'4' as u16
                    {
                        i += 2;
                        len_mod = IntLen::I64;
                    } else if i + 1 < fmt_chars.len()
                        && fmt_chars[i] == b'3' as u16
                        && fmt_chars[i + 1] == b'2' as u16
                    {
                        i += 2;
                        len_mod = IntLen::I32;
                    } else {
                        len_mod = IntLen::Ptr64;
                    }
                }
                _ => {}
            }
        }

        if i >= fmt_chars.len() {
            break;
        }
        let spec = fmt_chars[i];
        i += 1;

        let pad_field = |out: &mut Vec<u16>, prefix: &[u16], body: &[u16], zero_pad: bool| {
            let total = prefix.len() + body.len();
            if total >= width {
                out.extend_from_slice(prefix);
                out.extend_from_slice(body);
                return;
            }
            let pad_len = width - total;
            if flag_left {
                out.extend_from_slice(prefix);
                out.extend_from_slice(body);
                for _ in 0..pad_len {
                    out.push(b' ' as u16);
                }
            } else if zero_pad {
                out.extend_from_slice(prefix);
                for _ in 0..pad_len {
                    out.push(b'0' as u16);
                }
                out.extend_from_slice(body);
            } else {
                for _ in 0..pad_len {
                    out.push(b' ' as u16);
                }
                out.extend_from_slice(prefix);
                out.extend_from_slice(body);
            }
        };

        match spec {
            c if c == b'd' as u16 || c == b'i' as u16 => {
                let raw = va.next_u64();
                let sval: i64 = match len_mod {
                    IntLen::Hh => raw as u8 as i8 as i64,
                    IntLen::H => raw as u16 as i16 as i64,
                    IntLen::Default32 | IntLen::I32 => raw as u32 as i32 as i64,
                    IntLen::I64 | IntLen::Ptr64 => raw as i64,
                };
                let neg = sval < 0;
                let mag: u64 = if neg {
                    (sval as i128).unsigned_abs() as u64
                } else {
                    sval as u64
                };
                let mut prefix = Vec::new();
                if neg {
                    prefix.push(b'-' as u16);
                } else if flag_plus {
                    prefix.push(b'+' as u16);
                } else if flag_space {
                    prefix.push(b' ' as u16);
                }
                let mut digits: Vec<u16> = if mag == 0 && precision == Some(0) {
                    Vec::new()
                } else {
                    mag.to_string().bytes().map(|b| b as u16).collect()
                };
                if let Some(p) = precision {
                    while digits.len() < p {
                        digits.insert(0, b'0' as u16);
                    }
                }
                let zpad = flag_zero && precision.is_none() && !flag_left;
                pad_field(&mut out, &prefix, &digits, zpad);
            }
            c if c == b'u' as u16
                || c == b'x' as u16
                || c == b'X' as u16
                || c == b'o' as u16
                || c == b'p' as u16 =>
            {
                let raw = va.next_u64();
                let is_ptr = c == b'p' as u16;
                let uval: u64 = if is_ptr {
                    raw
                } else {
                    match len_mod {
                        IntLen::Hh => raw & 0xFF,
                        IntLen::H => raw & 0xFFFF,
                        IntLen::Default32 | IntLen::I32 => raw & 0xFFFF_FFFF,
                        IntLen::I64 | IntLen::Ptr64 => raw,
                    }
                };
                let upper = c == b'X' as u16 || is_ptr;
                let radix = if c == b'u' as u16 {
                    10
                } else if c == b'o' as u16 {
                    8
                } else {
                    16
                };
                let mut prefix = Vec::new();
                if flag_alt && uval != 0 && radix == 16 && !is_ptr {
                    prefix.push(b'0' as u16);
                    prefix.push(if upper { b'X' as u16 } else { b'x' as u16 });
                }
                let s = match (radix, upper) {
                    (10, _) => format!("{uval}"),
                    (8, _) => format!("{uval:o}"),
                    (16, true) => {
                        if is_ptr && !wsprintf_mode {
                            format!("{uval:016X}")
                        } else {
                            format!("{uval:X}")
                        }
                    }
                    _ => format!("{uval:x}"),
                };
                let mut digits: Vec<u16> = if uval == 0 && precision == Some(0) && !is_ptr {
                    Vec::new()
                } else {
                    s.bytes().map(|b| b as u16).collect()
                };
                if let Some(p) = precision {
                    while digits.len() < p {
                        digits.insert(0, b'0' as u16);
                    }
                }
                let zpad = flag_zero && precision.is_none() && !flag_left;
                pad_field(&mut out, &prefix, &digits, zpad);
            }
            c if c == b'f' as u16
                || c == b'F' as u16
                || c == b'e' as u16
                || c == b'E' as u16
                || c == b'g' as u16
                || c == b'G' as u16 =>
            {
                let raw = va.next_u64();
                let fval = f64::from_bits(raw);
                let prec = precision.unwrap_or(6);
                let formatted = match c as u8 {
                    b'e' => format!("{fval:.prec$e}"),
                    b'E' => format!("{fval:.prec$E}"),
                    b'g' | b'G' => {
                        let s = format!("{fval:.prec$}");
                        if s.contains('.') {
                            s.trim_end_matches('0').trim_end_matches('.').to_string()
                        } else {
                            s
                        }
                    }
                    _ => format!("{fval:.prec$}"),
                };
                let chars: Vec<u16> = formatted.bytes().map(|b| b as u16).collect();
                pad_field(&mut out, &[], &chars, flag_zero && !flag_left);
            }
            c if c == b'c' as u16 || c == b'C' as u16 => {
                let raw = va.next_u64();
                let arg_is_wide = force_wide.unwrap_or(if c == b'C' as u16 {
                    !is_wide_call
                } else {
                    is_wide_call
                });
                let ch_out = if arg_is_wide {
                    let wc = (raw & 0xFFFF) as u16;
                    if is_wide_call {
                        wc
                    } else {
                        wchar_to_cp1252_byte(wc).0 as u16
                    }
                } else {
                    let b = (raw & 0xFF) as u8;
                    if is_wide_call {
                        cp1252_byte_to_wchar(b)
                    } else {
                        b as u16
                    }
                };
                pad_field(&mut out, &[], &[ch_out], false);
            }
            c if c == b's' as u16 || c == b'S' as u16 => {
                let ptr = va.next_u64();
                let arg_is_wide = force_wide.unwrap_or(if c == b'S' as u16 {
                    !is_wide_call
                } else {
                    is_wide_call
                });
                let mut str_units: Vec<u16> = if ptr == 0 {
                    "(null)".encode_utf16().collect()
                } else if arg_is_wide {
                    let max_r = precision.unwrap_or(4096);
                    let w = vmm.read_wide_string(ptr, max_r).unwrap_or_default();
                    if is_wide_call {
                        w
                    } else {
                        let (mb, _) = wide_to_mb(1252, &w);
                        mb.into_iter().map(|b| b as u16).collect()
                    }
                } else {
                    let max_r = precision.unwrap_or(4096);
                    let mb = vmm.read_c_string(ptr, max_r).unwrap_or_default();
                    if is_wide_call {
                        mb_to_wide(1252, &mb)
                    } else {
                        mb.into_iter().map(|b| b as u16).collect()
                    }
                };
                if let Some(p) = precision {
                    if str_units.len() > p {
                        str_units.truncate(p);
                    }
                }
                pad_field(&mut out, &[], &str_units, false);
            }
            c if c == b'n' as u16 => {
                let ptr = va.next_u64();
                if ptr != 0 {
                    let _ = vmm.write_u32(ptr, out.len() as u32);
                }
            }
            other => {
                out.push(other);
            }
        }
    }
    out
}
