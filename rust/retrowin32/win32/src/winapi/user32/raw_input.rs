//! x86 RAWINPUT mouse subset. Host injection is synthetic, not physical input.
use crate::{Machine, winapi::types::HWND};
use memory::{Extensions, ExtensionsMut};
use super::MSG;
const TRACE_CONTEXT: &str = "user32/raw_input";
fn error(machine: &mut Machine, code: u32) -> u32 {
    crate::winapi::kernel32::teb_mut(machine).LastErrorValue=code; u32::MAX
}
fn valid(machine: &Machine, ptr: u32, size: u32) -> bool {
    ptr!=0 && ptr.checked_add(size).map_or(false, |end| end as usize<=machine.mem().as_slice().len())
}
#[win32_derive::dllexport]
pub fn RegisterRawInputDevices(machine: &mut Machine, devices: u32, count: u32, size: u32) -> bool {
    if count!=1 || size!=12 || !valid(machine,devices,12) {error(machine,87);return false;}
    let mem=machine.mem();
    let page=mem.get_pod::<u16>(devices);let usage=mem.get_pod::<u16>(devices+2);
    let flags=mem.get_pod::<u32>(devices+4);let hwnd=mem.get_pod::<u32>(devices+8);
    if page!=1 || usage!=2 || (flags!=0 && flags!=1) || hwnd!=0 {error(machine,50);return false;}
    machine.state.user32.raw_registered=flags==0;
    true
}
pub fn pump(machine: &mut Machine) {
    if !machine.state.user32.raw_registered {return;}
    let data=machine.host.raw_input_events();
    let events: Vec<(i32,i32)>=match serde_json::from_str(&data) {Ok(v)=>v,Err(_)=>return};
    for (dx,dy) in events.into_iter().take(256) {
        if machine.state.user32.raw_packets.len()>=1024 {break;}
        machine.state.user32.raw_next=machine.state.user32.raw_next.wrapping_add(1).max(1);
        let handle=machine.state.user32.raw_next;
        machine.state.user32.raw_packets.insert(handle,(dx,dy));
        machine.state.user32.messages.push_back(MSG {hwnd:HWND::null(),message:0xff,wParam:0,lParam:handle,time:machine.host.ticks(),pt_x:0,pt_y:0});
    }
}
#[win32_derive::dllexport]
pub fn GetRawInputData(machine: &mut Machine, handle: u32, command: u32, data: u32, size: u32, header_size: u32) -> u32 {
    if header_size!=16 || !valid(machine,size,4) || (command!=0x10000003 && command!=0x10000005) {return error(machine,87);}
    let (dx,dy)=match machine.state.user32.raw_packets.get(&handle) {Some(v)=>*v,None=>return error(machine,6)};
    let required=if command==0x10000005 {16}else{40};
    let mem=machine.mem();let capacity=mem.get_pod::<u32>(size);mem.put_pod::<u32>(size,required);
    if data==0 {return 0;}
    if capacity<required {return error(machine,122);}
    if !valid(machine,data,required) {return error(machine,87);}
    mem.sub32_mut(data,required).fill(0);mem.put_pod::<u32>(data+4,40);mem.put_pod::<u32>(data+8,1);
    if required==40 {mem.put_pod::<i32>(data+28,dx);mem.put_pod::<i32>(data+32,dy);machine.state.user32.raw_packets.remove(&handle);}
    required
}
