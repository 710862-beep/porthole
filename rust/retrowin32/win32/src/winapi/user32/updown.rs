/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Subset adapted from Wine dlls/comctl32/updown.c:275-359,571-635,
 * 797-840,980-1257; wine-mirror/wine@0738d528db522f52d9d75f2aec712688dd31d1d2
 * Copyright 1997, 2002 Dimitrie O. Paun
 * Local HWND/buddy state; guest NM_UPDOWN buffers replace C stack pointers.
 * No themes, acceleration timers, subclassing, listbox buddies or locale grouping.
 * See LICENSE.Wine. This is not a full UpDownWindowProc port.
 */
use super::*;
use crate::{Machine,winapi::{kernel32,types::*}};
use memory::{Extensions,ExtensionsMut};
#[derive(Clone)]pub struct State{pub min:i32,pub max:i32,pub pos:i32,pub base:u32,pub buddy:HWND}
impl Default for State{fn default()->Self{Self{min:100,max:0,pos:0,base:10,buddy:HWND::null()}}}
fn clamp(s:&State,p:i32)->i32{p.clamp(s.min.min(s.max),s.min.max(s.max))}
fn put(machine:&mut Machine,p:u32,v:i32)->bool{if p==0{return true}let mem=machine.mem();if (p as usize).checked_add(4).map_or(true,|e|e>mem.as_slice().len()){kernel32::teb_mut(machine).LastErrorValue=87;return false}mem.sub32_mut(p,4).copy_from_slice(&v.to_le_bytes());true}
fn get(machine:&Machine,h:HWND)->Option<(State,u32,HWND,u32,u32)>{let w=machine.state.user32.windows.get(h)?;let c=w.control.as_ref()?;Some((c.updown.clone()?,c.style,w.parent,w.id,w.height))}
fn save(machine:&mut Machine,h:HWND,s:&State){if let Some(c)=machine.state.user32.windows.get_mut(h).and_then(|w|w.control.as_mut()){c.updown=Some(s.clone());}}
async fn buddy_text(machine:&mut Machine,s:&State,style:u32){
 if style&2==0||s.buddy.is_null(){return}
 let text=if s.base==16{format!("0x{:04X}",s.pos)}else{s.pos.to_string()};
 let heap=kernel32::GetProcessHeap(machine);let ptr=kernel32::HeapAlloc(machine,heap,Ok(kernel32::HeapAllocFlags::empty()),text.len()as u32+1);if ptr==0{return}
 machine.mem().sub32_mut(ptr,text.len()as u32).copy_from_slice(text.as_bytes());machine.mem().sub32_mut(ptr+text.len()as u32,1)[0]=0;
 Box::pin(SendMessageA(machine,s.buddy,Err(0xc),0,ptr)).await;kernel32::HeapFree(machine,heap,0,ptr);
}
pub async fn dispatch(machine:&mut Machine,m:&MSG)->u32{
 let h=m.hwnd;let Some((mut s,style,parent,id,height))=get(machine,h)else{return 0};let mut result=0;let mut sync=false;
 match m.message{
  1=>{if style&0x10!=0{s.buddy=machine.state.user32.windows.iter().filter(|w|w.parent==parent&&w.hwnd.to_raw()<h.to_raw()).max_by_key(|w|w.hwnd.to_raw()).map_or(HWND::null(),|w|w.hwnd);}sync=true},
  0x465=>{s.max=m.lParam as u16 as i16 as i32;s.min=(m.lParam>>16)as u16 as i16 as i32},
  0x466=>result=(s.max as u32&0xffff)|((s.min as u32)<<16),
  0x46f=>{s.min=m.wParam as i32;s.max=m.lParam as i32},
  0x470=>{if !put(machine,m.wParam,s.min)||!put(machine,m.lParam,s.max){return 0}},
  0x467|0x471=>{result=clamp(&s,s.pos)as u32;s.pos=clamp(&s,if m.message==0x467{m.lParam as u16 as i16 as i32}else{m.lParam as i32});sync=true},
  0x468|0x472=>{
   let mut invalid=true;
   if style&2!=0{if let Some(c)=machine.state.user32.windows.get(s.buddy).and_then(|w|w.control.as_ref()){
    let text=String::from_utf8_lossy(&c.text);let text=text.trim();let parsed=if text.is_empty(){Ok(0)}else{i32::from_str_radix(if s.base==16{text.trim_start_matches("0x")}else{text},s.base)};
    if let Ok(v)=parsed{if clamp(&s,v)==v{s.pos=v;invalid=false}}
   }}
   let v=clamp(&s,s.pos);if m.message==0x468{result=(v as u32&0xffff)|if invalid{0x10000}else{0}}else{if !put(machine,m.lParam,if invalid{1}else{0}){return 0}result=v as u32}
  },
  0x469=>{result=s.buddy.to_raw();let b=HWND::from_raw(m.wParam);if !b.is_null()&&machine.state.user32.windows.get(b).is_none(){return result}s.buddy=b;sync=true},
  0x46a=>result=s.buddy.to_raw(),
  0x46d=>{if m.wParam!=10&&m.wParam!=16{return 0}result=s.base;s.base=m.wParam;sync=true},
  0x46e=>result=s.base,
  0x201|0x100 if m.message==0x201||(style&0x20!=0&&(m.wParam==0x26||m.wParam==0x28))=>{
   let up=if m.message==0x201{(m.lParam>>16)<height/2}else{m.wParam==0x26};
   let delta=(if up{1}else{-1})*(if s.max<s.min{-1}else{1});
   let heap=kernel32::GetProcessHeap(machine);let ptr=kernel32::HeapAlloc(machine,heap,Ok(kernel32::HeapAllocFlags::empty()),20);if ptr==0{return 0}
   for (i,v) in [h.to_raw(),id,(-722i32)as u32,s.pos as u32,delta as u32].iter().enumerate(){machine.mem().sub32_mut(ptr+i as u32*4,4).copy_from_slice(&v.to_le_bytes());}
   save(machine,h,&s);
   let deny=Box::pin(SendMessageA(machine,parent,Err(0x4e),id,ptr)).await;
   let delta=machine.mem().get_pod::<i32>(ptr+16);kernel32::HeapFree(machine,heap,0,ptr);
   let Some((current,_,_,_,_))=get(machine,h)else{return 0};s=current;
   if deny==0{let p=s.pos as i64+delta as i64;let low=s.min.min(s.max)as i64;let high=s.min.max(s.max)as i64;s.pos=if style&1!=0&&p<low{high as i32}else if style&1!=0&&p>high{low as i32}else{p.clamp(low,high)as i32};sync=true;}
   save(machine,h,&s);if sync{Box::pin(buddy_text(machine,&s,style)).await;sync=false;}
   Box::pin(SendMessageA(machine,parent,Err(if style&0x40!=0{0x114}else{0x115}),4|((s.pos as u32&0xffff)<<16),h.to_raw())).await;
  },
  0xf=>{},_=>return 0,
 }
 save(machine,h,&s);if sync{Box::pin(buddy_text(machine,&s,style)).await;}controls::paint(machine,h);result
}
