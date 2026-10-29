//! Windows-style strings.

/// UTF-16 string view.
#[derive(PartialEq, Eq)]
#[repr(transparent)]
pub struct Str16([u16]);

impl Str16 {
    pub fn from_bytes(mem: &[u8]) -> &Self {
        Str16::from_buffer(unsafe {
            std::slice::from_raw_parts(mem.as_ptr() as *const _, mem.len() / 2)
        })
    }

    pub fn from_bytes_mut(mem: &mut [u8]) -> &mut Self {
        Str16::from_buffer_mut(unsafe {
            std::slice::from_raw_parts_mut(mem.as_ptr() as *mut _, mem.len() / 2)
        })
    }

    pub fn from_buffer(mem: &[u16]) -> &Self {
        unsafe { std::mem::transmute(mem) }
    }

    pub fn from_buffer_mut(mem: &mut [u16]) -> &mut Self {
        unsafe { std::mem::transmute(mem) }
    }

    pub fn from_nul_term(mem: &[u16]) -> &Self {
        let end = mem.iter().position(|&c| c == 0).unwrap();
        Self::from_buffer(&mem[..end])
    }

    pub unsafe fn from_nul_term_ptr(mem: memory::Mem, addr: u32) -> Option<&Self> {
        if addr == 0 {
            return None;
        }
        let mem16: &[u16] = {
            let mem = mem.slice(addr..);
            let ptr = mem.as_ptr() as *const u16;
            std::slice::from_raw_parts(ptr, mem.len() as usize / 2)
        };
        Some(Self::from_nul_term(mem16))
    }

    pub fn buf(&self) -> &[u16] {
        &self.0
    }

    pub fn to_string(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }
}

impl std::fmt::Debug for Str16 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_fmt(format_args!("{:?}", self.to_string()))
    }
}

impl std::ops::Deref for Str16 {
    type Target = [u16];

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for Str16 {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

#[derive(PartialEq, Eq)]
pub struct String16(pub Vec<u16>);

impl String16 {
    pub fn as_str16(&self) -> &Str16 {
        Str16::from_buffer(&self.0)
    }

    pub fn byte_size(&self) -> usize {
        self.0.len() * 2
    }

    pub fn from(str: &str) -> Self {
        String16(str.encode_utf16().collect())
    }
}

impl std::ops::Deref for String16 {
    type Target = Str16;

    fn deref(&self) -> &Self::Target {
        self.as_str16()
    }
}

pub fn expect_ascii(slice: &[u8]) -> &str {
    match std::str::from_utf8(slice) {
        Ok(str) => str,
        Err(err) => {
            // If we hit one of these, we ought to change the caller to not use to_ascii().
            panic!("failed to ascii convert {:?}: {}", slice, err);
        }
    }
}

/// Owned ANSI argument for APIs that must decode the Win95 western ACP, not UTF-8.
#[derive(Debug)]
pub struct AnsiString(pub Option<String>);
pub fn decode_cp1252(bytes:&[u8])->String {
    const C1:[u16;32]=[0x20ac,0x81,0x201a,0x192,0x201e,0x2026,0x2020,0x2021,0x2c6,0x2030,0x160,0x2039,0x152,0x8d,0x17d,0x8f,0x90,0x2018,0x2019,0x201c,0x201d,0x2022,0x2013,0x2014,0x2dc,0x2122,0x161,0x203a,0x153,0x9d,0x17e,0x178];
    bytes.iter().map(|&b|char::from_u32(if (0x80..0xa0).contains(&b){C1[(b-0x80)as usize]as u32}else{b as u32}).unwrap()).collect()
}
#[cfg(test)] mod encoding_tests {
    use super::*;
    #[test] fn win95_caption_is_cp1252_not_utf8(){assert_eq!(decode_cp1252(b"Windows\xae 95 \x80"),"Windows® 95 €");}
    #[test] fn utf16_round_trip_includes_surrogates(){let text="Windows® € 😀";assert_eq!(String16::from(text).to_string(),text);}
}
