//! Wine-derived DirectPlay provider enumeration, LGPL-2.1-or-later.
//! wine-mirror/wine@0738d528db522f52d9d75f2aec712688dd31d1d2
//! dlls/dplayx/dplay.c:4950-5131,6540-6601.
//! Copyright 1998,1999,2000,2001 Peter Hunnisett.
//! Registry/heap/callback boundaries -> existing Host registry and guest heap.
//! Enumerates registry metadata, NOT functioning network transports. No session
//! object is fabricated: DirectPlayCreate explicitly reports unavailable.
use crate::{Machine,winapi::kernel32};
use memory::ExtensionsMut;
use serde_json::{Value,json};
const TRACE_CONTEXT:&str="dplay";
const INVALID:u32=0x80070057;const UNAVAILABLE:u32=0x887700fa;
fn reg(machine:&Machine,op:&str,key:u32,name:&str)->Value{serde_json::from_str(&machine.host.registry_call(op,key,name,0,&[])).unwrap_or(json!({"status":13}))}
fn status(v:&Value)->u64{v["status"].as_u64().unwrap_or(13)}
fn text(machine:&Machine,key:u32,name:&str)->Option<String>{let v=reg(machine,"query",key,name);if status(&v)!=0||!matches!(v["type"].as_u64(),Some(1)|Some(2)){return None}let b:Option<Vec<u8>>=v["data"].as_array()?.iter().map(|x|x.as_u64().filter(|x|*x<=127).map(|x|x as u8)).collect();Some(String::from_utf8(b?).ok()?.trim_end_matches('\0').to_string())}
fn guid(value:&str)->Option<[u8;16]>{let s=value.strip_prefix('{').and_then(|s|s.strip_suffix('}')).unwrap_or(value);if s.len()!=36||[8,13,18,23].iter().any(|&i|s.as_bytes()[i]!=b'-'){return None}let h:String=s.chars().filter(|c|*c!='-').collect();if h.len()!=32||!h.is_ascii(){return None}let mut b=[0;16];for i in 0..16{b[i]=u8::from_str_radix(&h[i*2..i*2+2],16).ok()?}b[0..4].reverse();b[4..6].reverse();b[6..8].reverse();Some(b)}
struct Provider{guid:[u8;16],name_a:String,name_w:String}
fn providers(machine:&Machine)->Result<Vec<Provider>,u32>{
 let root=reg(machine,"open",0x80000002,"SOFTWARE\\Microsoft\\DirectPlay\\Service Providers");
 if status(&root)==2{return Ok(vec![])}if status(&root)!=0{return Err(UNAVAILABLE)}
 let handle=root["handle"].as_u64().ok_or(UNAVAILABLE)?as u32;
 let listed=reg(machine,"enumKeys",handle,"");reg(machine,"close",handle,"");if status(&listed)!=0{return Err(UNAVAILABLE)}
 let names=listed["names"].as_array().ok_or(UNAVAILABLE)?;if names.len()>4096{return Err(UNAVAILABLE)}
 let mut result=vec![];
 for n in names{let Some(name)=n.as_str()else{return Err(UNAVAILABLE)};let opened=reg(machine,"open",0x80000002,&format!("SOFTWARE\\Microsoft\\DirectPlay\\Service Providers\\{name}"));if status(&opened)!=0{continue}let Some(key)=opened["handle"].as_u64()else{continue};let key=key as u32;
  let g=text(machine,key,"Guid").and_then(|v|guid(&v));let desc=text(machine,key,"DescriptionA").unwrap_or_else(||name.to_string());
  let desc_w=text(machine,key,"DescriptionW").unwrap_or_else(||name.to_string());let path=text(machine,key,"Path");let valid=["dwReserved1","dwReserved2"].iter().all(|n|{let v=reg(machine,"query",key,n);status(&v)==0&&v["type"].as_u64()==Some(4)&&v["data"].as_array().map_or(false,|a|a.len()==4)});
  reg(machine,"close",key,"");if !desc.is_ascii()||!desc_w.is_ascii()||desc.len()>4096||desc_w.len()>4096{return Err(UNAVAILABLE)}if let(Some(g),Some(_))=(g,path){if valid{result.push(Provider{guid:g,name_a:desc,name_w:desc_w})}}
 }Ok(result)
}
async fn enumerate(machine:&mut Machine,callback:u32,context:u32,wide:bool)->u32{
 if callback==0{return INVALID}let list=match providers(machine){Ok(v)=>v,Err(e)=>return e};
 log::debug!("DIRECTPLAY_ENUM registered={} transports=unavailable",list.len());
 for p in list{let mut bytes=p.guid.to_vec();if wide{for c in p.name_w.encode_utf16().chain(Some(0)){bytes.extend(c.to_le_bytes());}}else{bytes.extend(p.name_a.bytes());bytes.push(0);}
  let heap=kernel32::GetProcessHeap(machine);let ptr=kernel32::HeapAlloc(machine,heap,0,bytes.len()as u32);if ptr==0{return 0x8007000e}
  machine.mem().sub32_mut(ptr,bytes.len()as u32).copy_from_slice(&bytes);
  let keep=machine.call_x86(callback,vec![ptr,ptr+16,6,0,context]).await;
  kernel32::HeapFree(machine,heap,0,ptr);if keep==0{break}
 }0
}
#[win32_derive::dllexport(ordinal=2)]
pub async fn DirectPlayEnumerateA(machine:&mut Machine,lpEnumCallback:u32,lpContext:u32)->u32{enumerate(machine,lpEnumCallback,lpContext,false).await}
#[win32_derive::dllexport(ordinal=3)]
pub async fn DirectPlayEnumerateW(machine:&mut Machine,lpEnumCallback:u32,lpContext:u32)->u32{enumerate(machine,lpEnumCallback,lpContext,true).await}
#[win32_derive::dllexport(ordinal=9)]
pub async fn DirectPlayEnumerate(machine:&mut Machine,lpEnumCallback:u32,lpContext:u32)->u32{enumerate(machine,lpEnumCallback,lpContext,false).await}
#[win32_derive::dllexport(ordinal=1)]
pub fn DirectPlayCreate(machine:&mut Machine,lpGuid:u32,lplpDP:u32,pUnk:u32)->u32{
 let _=(lpGuid,pUnk);if lplpDP==0||(lplpDP as usize).checked_add(4).map_or(true,|e|e>machine.mem().as_slice().len()){return INVALID}
 machine.mem().put_pod::<u32>(lplpDP,0);log::warn!("DIRECTPLAY_SESSION_UNAVAILABLE: no transport implementation");UNAVAILABLE
}
#[cfg(test)]mod tests{use super::*;#[test]fn guid_guest_layout(){assert_eq!(guid("{00112233-4455-6677-8899-aabbccddeeff}"),Some([0x33,0x22,0x11,0,0x55,0x44,0x77,0x66,0x88,0x99,0xaa,0xbb,0xcc,0xdd,0xee,0xff]));assert!(guid("not-a-guid").is_none());}}
