use crate::{
    str16::Str16,
    winapi::{stack_args::VarArgs, types::HWND},
    Machine,
};
use memory::{Extensions, ExtensionsMut};
use std::io::{Cursor, Write};

const TRACE_CONTEXT: &'static str = "user32/misc";

pub type HINSTANCE = u32;

#[derive(Debug, win32_derive::TryFromEnum)]
pub enum SystemMetric {
    CXSCREEN = 0,
    CYSCREEN = 1,
    CYCAPTION = 4,
    CXBORDER = 5,
    CYBORDER = 6,
    CYMENU = 15,
    CXFRAME = 32,
    CYFRAME = 33,
    CXVIRTUALSCREEN = 78,
    CYVIRTUALSCREEN = 79,
}

#[win32_derive::dllexport]
pub fn GetSystemMetrics(_machine: &mut Machine, nIndex: Result<SystemMetric, u32>) -> u32 {
    let metric = match nIndex {
        Ok(metric) => metric,
        Err(val) => {
            log::error!("GetSystemMetrics({val}) => 0");
            return 0;
        }
    };
    match metric {
        SystemMetric::CXSCREEN => 640,
        SystemMetric::CYSCREEN => 480,
        SystemMetric::CYCAPTION => 19,
        SystemMetric::CXBORDER => 1,
        SystemMetric::CYBORDER => 1,
        SystemMetric::CYMENU => 19,
        SystemMetric::CXFRAME => 4,
        SystemMetric::CYFRAME => 4,
        SystemMetric::CXVIRTUALSCREEN => 640,
        SystemMetric::CYVIRTUALSCREEN => 480,
    }
}

#[win32_derive::dllexport]
pub fn GetSysColor(_machine: &mut Machine, nIndex: i32) -> u32 {
    // Windows default 3D Objects / Window / Button face palette (BGR).
    match nIndex {
        0 => 0x00C8C8C8, // COLOR_SCROLLBAR
        1 => 0x00C0C0C0, // COLOR_BACKGROUND
        2 => 0x00800000, // COLOR_ACTIVECAPTION
        3 => 0x00C0C0C0, // COLOR_INACTIVECAPTION
        4 => 0x00C0C0C0, // COLOR_MENU
        5 => 0x00FFFFFF, // COLOR_WINDOW
        6 => 0x00000000, // COLOR_WINDOWFRAME
        7 => 0x00000000, // COLOR_MENUTEXT
        8 => 0x00000000, // COLOR_WINDOWTEXT
        9 => 0x00000000, // COLOR_CAPTIONTEXT
        10 => 0x00C0C0C0, // COLOR_ACTIVEBORDER
        11 => 0x00C0C0C0, // COLOR_INACTIVEBORDER
        12 => 0x00808080, // COLOR_APPWORKSPACE
        13 => 0x00800000, // COLOR_HIGHLIGHT
        14 => 0x00FFFFFF, // COLOR_HIGHLIGHTTEXT
        15 => 0x00C0C0C0, // COLOR_BTNFACE
        16 => 0x00808080, // COLOR_BTNSHADOW
        17 => 0x00808080, // COLOR_GRAYTEXT
        18 => 0x00000000, // COLOR_BTNTEXT
        19 => 0x00C0C0C0, // COLOR_INACTIVECAPTIONTEXT
        20 => 0x00FFFFFF, // COLOR_BTNHIGHLIGHT
        _ => 0,
    }
}

#[win32_derive::dllexport(cdecl)]
pub fn wsprintfA(machine: &mut Machine, buf: u32, fmt: Option<&str>, mut args: VarArgs) -> u32 {
    const BUF_LEN: u32 = 1024;
    let mem = machine.mem();
    let buf = mem.sub32_mut(buf, BUF_LEN);
    let mut out = Cursor::new(buf);

    fn read_number(c: u8) -> usize {
        // TODO: multiple digits, error handling, etc.
        assert!(c >= b'0' && c <= b'9');
        (c - b'0') as usize
    }

    let mut i = fmt.unwrap().bytes();
    while let Some(c) = i.next() {
        if c == b'%' {
            let mut c = i.next().unwrap();
            let mut width = 0;
            if c >= b'0' && c <= b'9' {
                width = read_number(c);
                c = i.next().unwrap();
            }
            let mut precision = 0;
            if c == b'.' {
                c = i.next().unwrap();
                precision = read_number(c);
                c = i.next().unwrap();
            }

            let mut long = false;
            if c == b'l' {
                long = true;
                c = i.next().unwrap();
            }
            _ = long; // currently ignored

            match c {
                b'u' => write!(
                    out,
                    "{:width$.precision$}",
                    args.pop::<u32>(mem),
                    width = width,
                    precision = precision
                )
                .unwrap(),
                b'd' => write!(
                    out,
                    "{:width$.precision$}",
                    args.pop::<i32>(mem),
                    width = width,
                    precision = precision
                )
                .unwrap(),
                b's' => {
                    let addr = args.pop::<u32>(mem);
                    let str = mem.slicez(addr);
                    write!(out, "{}", std::str::from_utf8(str).unwrap()).unwrap();
                }
                _ => todo!("format string character {:?}", c as char),
            }
        } else {
            out.write(&[c]).unwrap();
        }
    }
    out.write(&[0]).unwrap();
    // let len = out.position() as usize;
    // let buf = &out.into_inner()[..len];
    // log::info!("=> {}", std::str::from_utf8(buf).unwrap());
    // len as u32 - 1
    out.position() as u32 - 1
}

#[win32_derive::dllexport(cdecl)]
pub fn wsprintfW(machine: &mut Machine, buf: u32, fmt: Option<&Str16>, args: VarArgs) -> u32 {
    todo!()
}

#[win32_derive::dllexport]
pub fn GetKeyState(machine: &mut Machine, nVirtKey: u32) -> u32 {
    if nVirtKey > 255 { return 0; }
    machine.host.key_state(nVirtKey) & 0x8001
}

#[win32_derive::dllexport]
pub fn IsIconic(_machine: &mut Machine, hwnd: HWND) -> bool {
    false
}

#[win32_derive::dllexport]
pub fn WinHelpW(machine: &mut Machine, hWndMain: HWND, lpszHelp: Option<&Str16>, uCommand: u32, dwData: u32) -> bool {
    let _ = (hWndMain, lpszHelp, uCommand, dwData);
    crate::winapi::kernel32::teb_mut(machine).LastErrorValue = 50;
    false
}
#[win32_derive::dllexport]
pub fn WinHelpA(machine: &mut Machine, hWndMain: HWND, lpszHelp: Option<&str>, uCommand: u32, dwData: u32) -> bool {
    let _ = (hWndMain, lpszHelp, uCommand, dwData);
    crate::winapi::kernel32::teb_mut(machine).LastErrorValue = 50;
    false
}

#[win32_derive::dllexport]
pub fn SetCursorPos(_machine: &mut Machine, x: i32, y: i32) -> bool {
    let _ = (x, y);
    true
}

#[win32_derive::dllexport]
pub fn ClipCursor(machine: &mut Machine, lpRect: Option<&crate::winapi::types::RECT>) -> bool {
    machine.state.user32.clip = lpRect.map(|r| [r.left, r.top, r.right, r.bottom]);
    true
}
#[win32_derive::dllexport]
pub fn GetClipCursor(machine: &mut Machine, lpRect: Option<&mut crate::winapi::types::RECT>) -> bool {
    let Some(out) = lpRect else { crate::winapi::kernel32::teb_mut(machine).LastErrorValue = 87; return false; };
    let c = machine.state.user32.clip.unwrap_or([0, 0, 640, 480]);
    *out = crate::winapi::types::RECT { left: c[0], top: c[1], right: c[2], bottom: c[3] };
    true
}

// MAPVK_VK_TO_VSC. US keyboard scan-code set 1 subset; unknown keys return 0.
#[win32_derive::dllexport]
pub fn MapVirtualKeyA(_machine: &mut Machine, uCode: u32, uMapType: u32) -> u32 {
    if uMapType != 0 { return 0; }
    match uCode {
        0x08 => 0x0E, 0x09 => 0x0F, 0x0D => 0x1C, 0x10 => 0x2A, 0x11 => 0x1D,
        0x12 => 0x38, 0x14 => 0x3A, 0x1B => 0x01, 0x20 => 0x39, 0x21 => 0x49,
        0x22 => 0x51, 0x23 => 0x4F, 0x24 => 0x47, 0x25 => 0x4B, 0x26 => 0x48,
        0x27 => 0x4D, 0x28 => 0x50, 0x2D => 0x52, 0x2E => 0x53,
        0x30..=0x39 => 0x0B + (uCode - 0x30),
        0x41..=0x5A => [0x1E,0x30,0x2E,0x20,0x12,0x21,0x22,0x23,0x17,0x24,0x25,0x26,0x32,0x31,0x18,0x19,0x10,0x13,0x1F,0x14,0x16,0x2F,0x11,0x2D,0x15,0x2C][(uCode-0x41) as usize],
        0x70..=0x7B => 0x3B + (uCode - 0x70),
        _ => 0,
    }
}
#[win32_derive::dllexport]
pub fn MapVirtualKeyW(machine: &mut Machine, uCode: u32, uMapType: u32) -> u32 { MapVirtualKeyA(machine, uCode, uMapType) }

// SHORT result: bit 15 is current down state; bit 0 is pressed since last query.
#[win32_derive::dllexport]
pub fn GetAsyncKeyState(machine: &mut Machine, key: i32) -> u32 {
    if key<0 || key>255 {return 0;}
    machine.host.key_state(key as u32) & 0x8001
}

// Virtual desktop work-area queries. No host OS settings are modified.
#[win32_derive::dllexport]
pub fn SystemParametersInfoA(machine: &mut Machine, action: u32, param: u32, data: u32, flags: u32) -> bool {
    if action!=0x30 {crate::winapi::kernel32::teb_mut(machine).LastErrorValue=50;return false;}
    if data==0 || data.checked_add(16).map_or(true,|end|end as usize>machine.mem().as_slice().len()) {
        crate::winapi::kernel32::teb_mut(machine).LastErrorValue=87;return false;
    }
    let right=GetSystemMetrics(machine,Ok(SystemMetric::CXSCREEN));
    let bottom=GetSystemMetrics(machine,Ok(SystemMetric::CYSCREEN));
    let mem=machine.mem();mem.put_pod::<i32>(data,0);mem.put_pod::<i32>(data+4,0);mem.put_pod::<u32>(data+8,right);mem.put_pod::<u32>(data+12,bottom);true
}
