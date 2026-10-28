/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Adapted from Wine dlls/kernelbase/process.c:1565-1780, in particular
 * GetEnvironmentVariableA/W and SetEnvironmentVariableA/W at 1656-1780.
 * wine-mirror/wine@0738d528db522f52d9d75f2aec712688dd31d1d2
 * Copyright 1996, 1998 Alexandre Julliard. See LICENSE.Wine.
 * RtlQuery/SetEnvironmentVariable and PEB lock become a per-emulated-process map.
 * ANSI entry points use existing ASCII argument adapter; not complete CP_ACP.
 * No host process environment or real user identity is queried.
 */
use crate::{str16::Str16, Machine};
use memory::{Extensions,ExtensionsMut};
const TRACE_CONTEXT:&str="kernel32/env";
fn error(machine:&mut Machine,e:u32)->u32{super::teb_mut(machine).LastErrorValue=e;0}
fn encode(s:&str,wide:bool)->Vec<u8>{if wide{s.encode_utf16().flat_map(|c|c.to_le_bytes()).collect()}else{s.chars().map(|c|if c as u32<=255{c as u8}else{b'?'}).collect()}}
fn block(machine:&mut Machine,wide:bool)->u32{
 let mut values:Vec<_>=machine.state.kernel32.env_vars.iter().map(|(k,v)|format!("{k}={v}")).collect();values.sort();
 let mut text=values.join("\0");text.push('\0');text.push('\0');let bytes=encode(&text,wide);
 let heap=super::GetProcessHeap(machine);let p=super::HeapAlloc(machine,heap,Ok(super::HeapAllocFlags::empty()),bytes.len()as u32);
 if p!=0{machine.mem().sub32_mut(p,bytes.len()as u32).copy_from_slice(&bytes);machine.state.kernel32.env_blocks.insert(p);}p
}
#[win32_derive::dllexport]
pub fn GetEnvironmentStrings(machine:&mut Machine)->u32{block(machine,false)}
#[win32_derive::dllexport]
pub fn GetEnvironmentStringsA(machine:&mut Machine)->u32{block(machine,false)}
#[win32_derive::dllexport]
pub fn GetEnvironmentStringsW(machine:&mut Machine)->u32{block(machine,true)}
#[win32_derive::dllexport]
pub fn FreeEnvironmentStringsA(machine:&mut Machine,penv:u32)->bool{if !machine.state.kernel32.env_blocks.remove(&penv){error(machine,87);return false}let heap=super::GetProcessHeap(machine);super::HeapFree(machine,heap,0,penv)}
#[win32_derive::dllexport]
pub fn FreeEnvironmentStringsW(machine:&mut Machine,penv:u32)->bool{FreeEnvironmentStringsA(machine,penv)}
pub fn query_environment(machine:&mut Machine,name:Option<String>,buf:u32,size:u32,wide:bool)->u32{
 let Some(name)=name else{return error(machine,203)};
 let Some(value)=machine.state.kernel32.env_vars.get(&name.to_ascii_uppercase()).cloned()else{return error(machine,203)};
 let bytes=encode(&value,wide);let unit=if wide{2}else{1};let len=bytes.len()/unit;let size=size.min(32767);
 if size as usize<=len{return len as u32+1}
 let count=bytes.len()+unit;
 let valid={let mem=machine.mem();buf!=0&&(buf as usize).checked_add(count).map_or(false,|e|e<=mem.as_slice().len())};
 if !valid{return error(machine,87)}
 let out=machine.mem().sub32_mut(buf,count as u32);out[..bytes.len()].copy_from_slice(&bytes);out[bytes.len()..].fill(0);len as u32
}
#[win32_derive::dllexport]
pub fn GetEnvironmentVariableA(machine:&mut Machine,name:Option<&str>,buf:u32,size:u32)->u32{query_environment(machine,name.map(str::to_string),buf,size,false)}
#[win32_derive::dllexport]
pub fn GetEnvironmentVariableW(machine:&mut Machine,name:Option<&Str16>,buf:u32,size:u32)->u32{query_environment(machine,name.map(|s|s.to_string()),buf,size,true)}
fn set(machine:&mut Machine,name:Option<String>,value:Option<String>)->bool{
 let Some(name)=name else{error(machine,203);return false};if name.is_empty()||name.contains('='){error(machine,87);return false}
 let key=name.to_ascii_uppercase();if let Some(v)=value{machine.state.kernel32.env_vars.insert(key,v);}else if machine.state.kernel32.env_vars.remove(&key).is_none(){error(machine,203);return false}true
}
#[win32_derive::dllexport]
pub fn SetEnvironmentVariableA(machine:&mut Machine,name:Option<&str>,value:Option<&str>)->bool{set(machine,name.map(str::to_string),value.map(str::to_string))}
#[win32_derive::dllexport]
pub fn SetEnvironmentVariableW(machine:&mut Machine,name:Option<&Str16>,value:Option<&Str16>)->bool{set(machine,name.map(|s|s.to_string()),value.map(|s|s.to_string()))}
