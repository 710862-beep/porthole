//! "National Language Support", e.g. code page conversions.

use crate::{winapi::stack_args::ArrayWithSizeMut, Machine};
use memory::Extensions;

const TRACE_CONTEXT: &'static str = "kernel32/nls";

/// Code pages
#[derive(Debug, win32_derive::TryFromEnum)]
pub enum CP {
    /// The system default Windows ANSI code page.
    ACP = 0,
    OEMCP = 1,
    WINDOWS_1252 = 1252,
    UTF8 = 65001,
}

#[win32_derive::dllexport]
pub fn GetACP(_machine: &mut Machine) -> u32 {
    1252 // windows-1252
}

#[win32_derive::dllexport]
pub fn GetOEMCP(_machine: &mut Machine) -> u32 {
    todo!()
}

#[win32_derive::dllexport]
pub fn IsValidCodePage(_machine: &mut Machine, CodePage: u32) -> bool {
    CodePage == 1252
}

#[win32_derive::dllexport]
pub fn GetCPInfo(_machine: &mut Machine, _CodePage: u32, _lpCPInfo: u32) -> u32 {
    0 // fail
}

#[win32_derive::dllexport]
pub fn MultiByteToWideChar(
    machine: &mut Machine,
    CodePage: Result<CP, u32>,
    dwFlags: u32,
    lpMultiByteStr: u32,
    cbMultiByte: i32,
    lpWideCharStr: ArrayWithSizeMut<u16>,
) -> u32 {
    match CodePage {
        Err(value) => unimplemented!("MultiByteToWideChar code page {value}"),
        _ => {} // treat all others as ansi for now
    }
    // TODO: dwFlags

    let input_len = match cbMultiByte {
        0 => return 0,                                               // TODO: invalid param
        -1 => machine.mem().slicez(lpMultiByteStr).len() as u32 + 1, // include nul
        len => len as u32,
    };

    let mut lpWideCharStr = lpWideCharStr.to_option();
    match lpWideCharStr {
        Some(buf) if buf.len() == 0 => lpWideCharStr = None,
        _ => (),
    };

    match lpWideCharStr {
        None => input_len,
        Some(buf) => {
            let input = machine.mem().sub32(lpMultiByteStr, input_len);
            let mut len = 0;
            for (&c_in, c_out) in std::iter::zip(input, buf) {
                if c_in > 0x7f {
                    unimplemented!("unicode");
                }
                *c_out = c_in as u16;
                len += 1;
            }
            len
        }
    }
}

/* SPDX-License-Identifier: LGPL-2.1-or-later (this adapted section)
 * Wine dlls/kernelbase/locale.c:2965-3000,7426-7472
 * wine-mirror/wine@0738d528db522f52d9d75f2aec712688dd31d1d2
 * Copyright 1995 Martin von Loewis; 1998 David Lee Lambert;
 * 2000 Julio César Gázquez; 2003 Jon Griffiths; 2005 Dmitry Timoshkov;
 * 2002, 2019 Alexandre Julliard. See LICENSE.Wine.
 * Reviewed subset: parameter/flag validation, CP1252 and UTF8, default char,
 * query/length/terminator/error semantics. Rtl conversion -> checked owned Vecs.
 * No other codepages or Wine's full best-fit/composition tables.
 */
fn wc_encode(code:u32,flags:u32,units:&[u16],default:u8)->Result<(Vec<u8>,bool),u32>{
    if code==65001{
        if flags & !0x80!=0{return Err(1004)}
        let text=match String::from_utf16(units){Ok(t)=>t,Err(_)if flags&0x80!=0=>return Err(1113),Err(_)=>String::from_utf16_lossy(units)};
        return Ok((text.into_bytes(),false))
    }
    if code!=0&&code!=1252{return Err(87)}
    if flags & !0x400!=0{return Err(1004)}
    let mut used=false;let mut out=Vec::new();
    for &c in units{
        let encoded=(0u16..=255).find(|&b|crate::str16::decode_cp1252(&[b as u8]).chars().next().map_or(false,|ch|ch as u32==c as u32));
        if let Some(b)=encoded{out.push(b as u8)}else{used=true;out.push(default)}
    }
    Ok((out,used))
}
#[win32_derive::dllexport]
pub fn WideCharToMultiByte(machine:&mut Machine,CodePage:u32,dwFlags:u32,lpWideCharStr:u32,cchWideChar:i32,lpMultiByteStr:u32,cbMultiByte:i32,lpDefaultChar:u32,lpUsedDefaultChar:u32)->u32{
    fn fail(m:&mut Machine,e:u32)->u32{super::teb_mut(m).LastErrorValue=e;0}
    if lpWideCharStr==0||cchWideChar==0||cbMultiByte<0||(lpMultiByteStr==0&&cbMultiByte!=0){return fail(machine,87)}
    if CodePage==65001&&(lpDefaultChar!=0||lpUsedDefaultChar!=0){return fail(machine,87)}
    let input={let mem=machine.mem();let Some(b)=mem.as_slice().get(lpWideCharStr as usize..)else{return fail(machine,87)};
        let count=if cchWideChar<0{let Some(n)=b.chunks_exact(2).take(1048576).position(|v|v==[0,0])else{return fail(machine,87)};n+1}else{cchWideChar as usize};
        let Some(n)=count.checked_mul(2)else{return fail(machine,87)};let Some(b)=b.get(..n)else{return fail(machine,87)};
        b.chunks_exact(2).map(|v|u16::from_le_bytes([v[0],v[1]])).collect::<Vec<_>>()};
    let default=if lpDefaultChar==0{b'?'}else{let mem=machine.mem();let Some(&v)=mem.as_slice().get(lpDefaultChar as usize)else{return fail(machine,87)};v};
    let (bytes,used)=match wc_encode(CodePage,dwFlags,&input,default){Ok(v)=>v,Err(e)=>return fail(machine,e)};
    if lpUsedDefaultChar!=0{let mem=machine.mem();if (lpUsedDefaultChar as usize).checked_add(4).map_or(true,|e|e>mem.as_slice().len()){return fail(machine,87)}}
    if cbMultiByte!=0&&bytes.len()>cbMultiByte as usize{return fail(machine,122)}
    use memory::ExtensionsMut;
    if cbMultiByte!=0{let mem=machine.mem();if (lpMultiByteStr as usize).checked_add(bytes.len()).map_or(true,|e|e>mem.as_slice().len()){return fail(machine,87)}mem.sub32_mut(lpMultiByteStr,bytes.len()as u32).copy_from_slice(&bytes);}
    if lpUsedDefaultChar!=0{machine.mem().sub32_mut(lpUsedDefaultChar,4).copy_from_slice(&(if used{1u32}else{0}).to_le_bytes());}
    bytes.len()as u32
}
#[cfg(test)]mod wc_tests{
 use super::*;
 #[test]fn cp1252_euro_and_default(){assert_eq!(wc_encode(1252,0,&[65,0x20ac,0],b'?').unwrap(),(vec![65,128,0],false));assert_eq!(wc_encode(0,0x400,&[0x4e2d],b'_').unwrap(),(vec![b'_'],true));}
 #[test]fn utf8_surrogate_and_errors(){assert_eq!(wc_encode(65001,0,&[0xd83d,0xde00],0).unwrap().0,vec![240,159,152,128]);assert_eq!(wc_encode(65001,0x80,&[0xd800],0),Err(1113));assert_eq!(wc_encode(1252,1,&[65],0),Err(1004));assert_eq!(wc_encode(932,0,&[65],0),Err(87));}
}

#[win32_derive::dllexport]
pub fn IsDBCSLeadByteEx(_machine: &mut Machine, _TestChar: u8, _CodePage: u32) -> bool {
    // TODO
    false
}

#[win32_derive::dllexport]
pub fn IsDBCSLeadByte(_machine: &mut Machine, _TestChar: u8) -> bool {
    false
}

pub type LCID = u32;

#[win32_derive::dllexport]
pub fn LCMapStringA(
    _machine: &mut Machine,
    locale: LCID,
    dwMapFlags: u32,
    lpSrcStr: u32,
    cchSrc: i32,
    lpDestStr: ArrayWithSizeMut<u8>,
) -> i32 {
    todo!();
}

#[win32_derive::dllexport]
pub fn LCMapStringW(
    _machine: &mut Machine,
    locale: LCID,
    dwMapFlags: u32,
    lpSrcStr: u32,
    cchSrc: i32,
    lpDestStr: ArrayWithSizeMut<u16>,
) -> i32 {
    todo!();
}

#[win32_derive::dllexport]
pub fn GetStringTypeA(
    _machine: &mut Machine,
    Locale: LCID,
    dwInfoType: u32,
    lpSrcStr: u32,
    cchSrc: i32,
    lpCharType: Option<&mut u32>,
) -> bool {
    todo!();
}

#[win32_derive::dllexport]
pub fn GetStringTypeW(
    _machine: &mut Machine,
    dwInfoType: u32,
    lpSrcStr: u32,
    cchSrc: i32,
    lpCharType: Option<&mut u32>,
) -> bool {
    todo!();
}
