//! Porthole ANSI registry subset routed to the JS registry store overlay.
#![allow(non_snake_case)]
use crate::machine::Machine;
use super::types::Str16;
use memory::{Extensions, ExtensionsMut};
use serde_json::{json, Value};
const TRACE_CONTEXT: &'static str = "advapi32";
pub type HKEY = u32;
fn call(machine: &Machine, op: &str, key: u32, name: &str, ty: u32, data: &[u8]) -> Value {
    serde_json::from_str(&machine.host.registry_call(op, key, name, ty, data)).unwrap_or(json!({"status": 13}))
}
fn status(value: &Value) -> u32 { value["status"].as_u64().unwrap_or(13) as u32 }
#[win32_derive::dllexport]
pub fn RegCreateKeyExA(machine: &mut Machine, hKey: HKEY, lpSubKey: Option<&str>, Reserved: u32, lpClass: Option<&str>, dwOptions: u32, samDesired: u32, lpSecurityAttributes: u32, phkResult: Option<&mut u32>, lpdwDisposition: Option<&mut u32>) -> u32 {
    if Reserved != 0 || dwOptions != 0 || lpSecurityAttributes != 0 || lpClass.is_some() { return 50; }
    let result = match phkResult { Some(p) => p, None => return 87 };
    let value = call(machine, "create", hKey, lpSubKey.unwrap_or(""), 0, &[]);
    let code = status(&value);
    if code == 0 {
        *result = value["handle"].as_u64().unwrap_or(0) as u32;
        if let Some(p) = lpdwDisposition { *p = value["disposition"].as_u64().unwrap_or(2) as u32; }
    }
    code
}
#[win32_derive::dllexport]
pub fn RegCreateKeyA(machine: &mut Machine, hKey: HKEY, lpSubKey: Option<&str>, phkResult: Option<&mut u32>) -> u32 {
    RegCreateKeyExA(machine, hKey, lpSubKey, 0, None, 0, 0, 0, phkResult, None)
}
#[win32_derive::dllexport]
pub fn RegOpenKeyA(machine:&mut Machine,hKey:HKEY,lpSubKey:Option<&str>,phkResult:Option<&mut HKEY>)->u32 {
    RegOpenKeyExA(machine,hKey,lpSubKey,0,0x02000000,phkResult)
}
#[win32_derive::dllexport]
pub fn RegOpenKeyExA(machine: &mut Machine, hKey: HKEY, lpSubKey: Option<&str>, ulOptions: u32, samDesired: u32, phkResult: Option<&mut HKEY>) -> u32 {
    if ulOptions != 0 { return 87; }
    let result = match phkResult { Some(p) => p, None => return 87 };
    let value = call(machine, "open", hKey, lpSubKey.unwrap_or(""), 0, &[]);
    let code = status(&value); if code == 0 { *result = value["handle"].as_u64().unwrap_or(0) as u32; } code
}
#[win32_derive::dllexport]
pub fn RegCloseKey(machine: &mut Machine, hKey: HKEY) -> u32 { status(&call(machine, "close", hKey, "", 0, &[])) }
#[win32_derive::dllexport]
pub fn RegSetValueExA(machine: &mut Machine, hKey: HKEY, lpValueName: Option<&str>, Reserved: u32, dwType: u32, lpData: u32, cbData: u32) -> u32 {
    let mem = machine.mem();
    if Reserved != 0 || cbData > 1048576 || (cbData != 0 && lpData == 0) || lpData.checked_add(cbData).map_or(true, |end| end as usize > mem.as_slice().len()) { return 87; }
    status(&call(machine, "set", hKey, lpValueName.unwrap_or(""), dwType, mem.sub32(lpData, cbData)))
}
#[win32_derive::dllexport]
pub fn RegQueryValueExA(machine: &mut Machine, hKey: HKEY, lpValueName: Option<&str>, lpReserved: u32, lpType: Option<&mut u32>, lpData: u32, lpcbData: Option<&mut u32>) -> u32 {
    if lpReserved != 0 { return 87; }
    let size = match lpcbData { Some(p) => p, None => return 87 };
    let value = call(machine, "query", hKey, lpValueName.unwrap_or(""), 0, &[]);
    let code = status(&value); if code != 0 { return code; }
    let values = match value["data"].as_array() { Some(a) if a.len() <= 1048576 => a, _ => return 13 };
    let bytes: Option<Vec<u8>> = values.iter().map(|v| v.as_u64().filter(|n| *n < 256).map(|n| n as u8)).collect();
    let bytes = match bytes { Some(b) => b, None => return 13 };
    if let Some(ty) = lpType { *ty = value["type"].as_u64().unwrap_or(0) as u32; }
    let capacity = *size; *size = bytes.len() as u32;
    if lpData == 0 { return 0; }
    if capacity < bytes.len() as u32 { return 234; }
    let mem = machine.mem();
    if lpData.checked_add(bytes.len() as u32).map_or(true, |end| end as usize > mem.as_slice().len()) { return 87; }
    mem.sub32_mut(lpData, bytes.len() as u32).copy_from_slice(&bytes); 0
}

#[win32_derive::dllexport]
pub fn RegCreateKeyExW(
    _machine: &mut Machine,
    hKey: HKEY,
    lpSubKey: Option<&Str16>,
    Reserved: u32,
    lpClass: Option<&Str16>,
    dwOptions: u32,
    samDesired: u32,
    lpSecurityAttributes: u32,
    phkResult: Option<&mut u32>,
    lpdwDisposition: Option<&mut u32>,
) -> u32 {
    50 // Wide value marshaling is not implemented by this candidate.
}

#[win32_derive::dllexport]
pub fn RegQueryValueExW(
    _machine: &mut Machine,
    hKey: HKEY,
    lpValueName: Option<&Str16>,
    lpReserved: u32,
    lpType: Option<&mut u32>,
    lpData: u32,
    lpcbData: Option<&mut u32>,
) -> u32 {
    50 // Wide value marshaling is not implemented by this candidate.
}

#[win32_derive::dllexport]
pub fn RegSetValueExW(
    _machine: &mut Machine,
    hKey: HKEY,
    lpValueName: Option<&Str16>,
    Reserved: u32,
    dwType: u32,
    lpData: u32,
    cbData: u32,
) -> u32 {
    50 // Wide value marshaling is not implemented by this candidate.
}

/* SPDX-License-Identifier: LGPL-2.1-or-later (this Wine-derived section)
 * Wine dlls/advapi32/advapi.c:45-71, GetUserNameA/W
 * wine-mirror/wine@0738d528db522f52d9d75f2aec712688dd31d1d2
 * Copyright 1995 Sven Verdoolaege. See LICENSE.Wine.
 * WINEUSERNAME belongs to the emulated process; not the host OS account.
 * Added checked guest DWORD access instead of native pointer dereference.
 */
fn user_name(machine:&mut Machine,name:u32,size:u32,wide:bool)->bool{
 let cap={let mem=machine.mem();if size==0||(size as usize).checked_add(4).map_or(true,|e|e>mem.as_slice().len()){super::kernel32::teb_mut(machine).LastErrorValue=87;return false}mem.get_pod::<u32>(size)};
 let mut len=super::kernel32::query_environment(machine,Some("WINEUSERNAME".into()),name,cap,wide);
 if len==0{return false}
 let ret=len<cap;if ret{len+=1}else{super::kernel32::teb_mut(machine).LastErrorValue=122;}
 machine.mem().sub32_mut(size,4).copy_from_slice(&len.to_le_bytes());ret
}
#[win32_derive::dllexport]
pub fn GetUserNameA(machine:&mut Machine,lpBuffer:u32,pcbBuffer:u32)->bool{user_name(machine,lpBuffer,pcbBuffer,false)}
#[win32_derive::dllexport]
pub fn GetUserNameW(machine:&mut Machine,lpBuffer:u32,pcbBuffer:u32)->bool{user_name(machine,lpBuffer,pcbBuffer,true)}
