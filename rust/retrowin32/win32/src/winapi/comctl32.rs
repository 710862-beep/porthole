//! Common controls registered through the actual PE DLL/ordinal ABI.
#![allow(non_snake_case)]
use crate::{Machine,winapi::{user32::controls,kernel32}};
use memory::Extensions;
#[win32_derive::dllexport(ordinal = 17)]
pub fn InitCommonControls(machine:&mut Machine) {
    controls::standard(machine);
    controls::register(machine,"msctls_progress32",controls::Kind::Progress);
    // Legacy API has no return value. Do not claim unsupported Win95 classes exist.
    log::warn!("COMMON_CONTROLS_PARTIAL: progress and standard controls registered; other ICC_WIN95 classes unavailable");
}
#[win32_derive::dllexport]
pub fn InitCommonControlsEx(machine:&mut Machine,icex:u32)->bool {
    let mem=machine.mem();let Some(end)=icex.checked_add(8)else{kernel32::teb_mut(machine).LastErrorValue=87;return false};
    if icex==0 || end as usize>mem.as_slice().len(){kernel32::teb_mut(machine).LastErrorValue=87;return false}
    let bytes=&mem.as_slice()[icex as usize..end as usize];
    let size=u32::from_le_bytes(bytes[..4].try_into().unwrap());let flags=u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    // ICC_PROGRESS_CLASS=0x20, ICC_STANDARD_CLASSES=0x4000. Reject unsupported flags atomically.
    if size!=8 || flags & !0x4020 !=0 {kernel32::teb_mut(machine).LastErrorValue=87;return false}
    if flags&0x4000!=0 {controls::standard(machine)}
    if flags&0x20!=0 {controls::register(machine,"msctls_progress32",controls::Kind::Progress)}
    true
}
