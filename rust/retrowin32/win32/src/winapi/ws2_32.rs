//! Guest WinSock2 TCP/IPv4 subset, backed by a real authorized host transport.
//! No JS Promise crosses the DWORD ABI: pending jobs yield through guest Sleep.
#![allow(non_snake_case)]
use crate::Machine;
use memory::{Extensions,ExtensionsMut};
use serde_json::{json,Value};
use std::collections::HashSet;
const TRACE_CONTEXT: &str="ws2_32";
#[derive(Default)]
pub struct State {started:u32,sockets:HashSet<u32>,allocations:HashSet<u32>,last_error:i32}
fn fail(machine:&mut Machine,code:i32)->u32 {machine.state.ws2_32.last_error=code;u32::MAX}
fn valid(machine:&Machine,ptr:u32,len:u32)->bool {ptr!=0 && ptr.checked_add(len).map_or(false,|end|end as usize<=machine.mem().as_slice().len())}
fn host(machine:&Machine,value:Value)->Value {serde_json::from_str(&machine.host.network_call(&value.to_string())).unwrap_or(json!({"error":10022}))}
async fn exchange(machine:&mut Machine,value:Value)->Value {
    let mut response=host(machine,value);let start=machine.host.ticks();
    while response["pending"].as_bool()==Some(true) {
        if machine.host.ticks().wrapping_sub(start)>10000 {return json!({"error":10060});}
        let id=response["job"].clone();
        crate::winapi::kernel32::Sleep(machine,1).await;
        response=host(machine,json!({"op":"poll","job":id}));
    }
    response
}
fn result(machine:&mut Machine,response:&Value)->u32 {
    if let Some(code)=response["error"].as_i64() {return fail(machine,code as i32);}
    response["result"].as_u64().map(|v|v as u32).unwrap_or_else(||fail(machine,10022))
}
#[win32_derive::dllexport]
pub fn WSAStartup(machine:&mut Machine,version:u32,data:u32)->u32 {
    if version&0xffff!=0x202 {return 10092;}
    if !valid(machine,data,400) {return 10014;}
    let mem=machine.mem();mem.sub32_mut(data,400).fill(0);mem.put_pod::<u16>(data,0x202);mem.put_pod::<u16>(data+2,0x202);
    machine.state.ws2_32.started+=1;0
}
#[win32_derive::dllexport]
pub fn WSAGetLastError(machine:&mut Machine)->u32 {machine.state.ws2_32.last_error as u32}
#[win32_derive::dllexport]
pub fn WSACleanup(machine:&mut Machine)->u32 {
    if machine.state.ws2_32.started==0 {return fail(machine,10093);}
    machine.state.ws2_32.started-=1;
    if machine.state.ws2_32.started==0 {for socket in std::mem::take(&mut machine.state.ws2_32.sockets) {host(machine,json!({"op":"close","socket":socket}));}}
    0
}
#[win32_derive::dllexport]
pub fn socket(machine:&mut Machine,af:u32,ty:u32,protocol:u32)->u32 {
    if machine.state.ws2_32.started==0 {return fail(machine,10093);}
    if af!=2 || ty!=1 || (protocol!=0 && protocol!=6) {return fail(machine,10043);}
    let response=host(machine,json!({"op":"socket"}));let handle=result(machine,&response);
    if handle!=u32::MAX {machine.state.ws2_32.sockets.insert(handle);}handle
}
#[win32_derive::dllexport]
pub async fn connect(machine:&mut Machine,s:u32,name:u32,len:u32)->u32 {
    if !machine.state.ws2_32.sockets.contains(&s) {return fail(machine,10038);}
    if len!=16 || !valid(machine,name,16) {return fail(machine,10014);}
    let mem=machine.mem();if mem.get_pod::<u16>(name)!=2 {return fail(machine,10047);}
    let bytes=mem.sub32(name+2,6).to_vec();let port=u16::from_be_bytes([bytes[0],bytes[1]]);
    let ip=format!("{}.{}.{}.{}",bytes[2],bytes[3],bytes[4],bytes[5]);
    let response=exchange(machine,json!({"op":"connect","socket":s,"host":ip,"port":port})).await;result(machine,&response)
}
#[win32_derive::dllexport]
pub async fn send(machine:&mut Machine,s:u32,buf:u32,len:i32,flags:u32)->u32 {
    if !machine.state.ws2_32.sockets.contains(&s) {return fail(machine,10038);}
    if flags!=0 {return fail(machine,10045);}
    if len<0 || len>1048576 || !valid(machine,buf,len as u32) {return fail(machine,10014);}
    let bytes=machine.mem().sub32(buf,len as u32).to_vec();
    let response=exchange(machine,json!({"op":"send","socket":s,"data":bytes})).await;result(machine,&response)
}
#[win32_derive::dllexport]
pub async fn recv(machine:&mut Machine,s:u32,buf:u32,len:i32,flags:u32)->u32 {
    if !machine.state.ws2_32.sockets.contains(&s) {return fail(machine,10038);}
    if flags!=0 {return fail(machine,10045);}
    if len<=0 || len>1048576 || !valid(machine,buf,len as u32) {return fail(machine,10014);}
    let response=exchange(machine,json!({"op":"recv","socket":s,"length":len})).await;
    if response["error"].is_number() {return result(machine,&response);}
    let bytes:Vec<u8>=match serde_json::from_value(response["data"].clone()) {Ok(v)=>v,Err(_)=>return fail(machine,10022)};
    if bytes.len()>len as usize {return fail(machine,10014);}
    machine.mem().sub32_mut(buf,bytes.len() as u32).copy_from_slice(&bytes);bytes.len() as u32
}
#[win32_derive::dllexport]
pub fn closesocket(machine:&mut Machine,s:u32)->u32 {
    if !machine.state.ws2_32.sockets.remove(&s) {return fail(machine,10038);}
    let response=host(machine,json!({"op":"close","socket":s}));result(machine,&response)
}
#[win32_derive::dllexport]
pub async fn getaddrinfo(machine:&mut Machine,node:Option<&str>,service:Option<&str>,hints:u32,out:Option<&mut u32>)->u32 {
    if machine.state.ws2_32.started==0 {return 10093;}
    let out=match out {Some(v)=>v,None=>return 10014};*out=0;
    let port=match service.unwrap_or("0").parse::<u16>() {Ok(v)=>v,Err(_)=>return 10109};
    if hints!=0 {
        if !valid(machine,hints,32) {return 10014;}
        let mem=machine.mem();
        if mem.get_pod::<u32>(hints)!=0 || ![0,2].contains(&mem.get_pod::<u32>(hints+4)) || ![0,1].contains(&mem.get_pod::<u32>(hints+8)) || ![0,6].contains(&mem.get_pod::<u32>(hints+12)) {return 10047;}
    }
    let response=exchange(machine,json!({"op":"lookup","host":node.unwrap_or("localhost")})).await;
    if let Some(code)=response["error"].as_u64() {return code as u32;}
    let ip:Vec<u8>=match serde_json::from_value(response["address"].clone()) {Ok(v)=>v,Err(_)=>return 11001};if ip.len()!=4 {return 11001;}
    let mem=machine.mem();let ptr=machine.state.scratch.alloc(mem,48);
    mem.sub32_mut(ptr,48).fill(0);
    for (offset,value) in [(4,2),(8,1),(12,6),(16,16),(24,ptr+32)] {mem.put_pod::<u32>(ptr+offset,value);}
    mem.put_pod::<u16>(ptr+32,2);mem.sub32_mut(ptr+34,2).copy_from_slice(&port.to_be_bytes());mem.sub32_mut(ptr+36,4).copy_from_slice(&ip);
    machine.state.ws2_32.allocations.insert(ptr);*out=ptr;0
}
#[win32_derive::dllexport]
pub fn freeaddrinfo(machine:&mut Machine,ptr:u32) {if machine.state.ws2_32.allocations.remove(&ptr) {let mem=machine.mem();machine.state.scratch.free(mem,ptr);}}
#[win32_derive::dllexport]
pub fn htons(_machine:&mut Machine,value:u32)->u32 {(value as u16).to_be() as u32}
#[win32_derive::dllexport]
pub fn inet_addr(_machine:&mut Machine,value:Option<&str>)->u32 {value.and_then(|v|v.parse::<std::net::Ipv4Addr>().ok()).map(|v|u32::from_le_bytes(v.octets())).unwrap_or(u32::MAX)}
