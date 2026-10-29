//! Wine-derived normal placement subset; LGPL-2.1-or-later.
//! wine-mirror/wine@0738d528db522f52d9d75f2aec712688dd31d1d2,
//! dlls/win32u/window.c:3172-3186,3317-3333 and set_window_placement helper.
//! Copyright 1993, 1994 Alexandre Julliard.
//! Single virtual monitor/work-area origin (0,0); normal/hide only. No fake
//! minimized/maximized state, taskbar offsets, async ownership or cross-thread UI.
use crate::{Machine,winapi::{kernel32,types::{HWND,RECT}}};
use super::window::{WindowType,WindowStyle,window_rect};
use memory::{Extensions,ExtensionsMut};
const TRACE_CONTEXT:&str="user32/placement";
fn error(machine:&mut Machine,e:u32)->bool{kernel32::teb_mut(machine).LastErrorValue=e;false}
fn pointer(machine:&Machine,p:u32)->bool{p!=0&&p.checked_add(44).map_or(false,|e|e as usize<=machine.mem().as_slice().len())}
#[win32_derive::dllexport]
pub fn GetWindowPlacement(machine:&mut Machine,hWnd:HWND,lpwndpl:u32)->bool{
 if !pointer(machine,lpwndpl)||machine.mem().get_pod::<u32>(lpwndpl)!=44{return error(machine,87)}
 let Some(w)=machine.state.user32.windows.get(hWnd)else{return error(machine,1400)};
 if !matches!(w.typ,WindowType::TopLevel(_)){return error(machine,50)}
 let show=if w.style.contains(WindowStyle::VISIBLE){1}else{0};
 let mut rect=RECT{left:0,top:0,right:0,bottom:0};if !super::GetWindowRect(machine,hWnd,Some(&mut rect)){return false}
 let words=[44u32,0,show,u32::MAX,u32::MAX,u32::MAX,u32::MAX,rect.left as u32,rect.top as u32,rect.right as u32,rect.bottom as u32];
 for(i,v)in words.into_iter().enumerate(){machine.mem().put_pod::<u32>(lpwndpl+i as u32*4,v)}true
}
#[win32_derive::dllexport]
pub async fn SetWindowPlacement(machine:&mut Machine,hWnd:HWND,lpwndpl:u32)->bool{
 if !pointer(machine,lpwndpl)||machine.mem().get_pod::<u32>(lpwndpl)!=44{return error(machine,87)}
 if machine.state.user32.windows.get(hWnd).is_none(){return error(machine,1400)}
 let flags=machine.mem().get_pod::<u32>(lpwndpl+4);let show=machine.mem().get_pod::<u32>(lpwndpl+8);
 if flags!=0||!matches!(show,0|1|4|5|8|10){return error(machine,50)}
 let x=machine.mem().get_pod::<i32>(lpwndpl+28);let y=machine.mem().get_pod::<i32>(lpwndpl+32);
 let width=machine.mem().get_pod::<i32>(lpwndpl+36).checked_sub(x);let height=machine.mem().get_pod::<i32>(lpwndpl+40).checked_sub(y);
 let(Some(width),Some(height))=(width,height)else{return error(machine,87)};
 if width<=0||height<=0||width>4096||height>4096{return error(machine,87)}
 let w=machine.state.user32.windows.get_mut(hWnd).unwrap();if !matches!(w.typ,WindowType::TopLevel(_)){return error(machine,50)}
 let mut border=RECT{left:0,top:0,right:0,bottom:0};window_rect(&mut border,w.style,true);
 let cw=width-(border.right-border.left);let ch=height-(border.bottom-border.top);if cw<=0||ch<=0{return error(machine,87)}
 let previous=w.style.contains(WindowStyle::VISIBLE);let visible=show!=0;
 let host=w.expect_toplevel_mut();if let Err(e)=host.host.set_position(x,y){kernel32::set_last_error(machine,e);return false}if let Err(e)=host.host.set_visible(visible){kernel32::set_last_error(machine,e);return false}
 let w=machine.state.user32.windows.get_mut(hWnd).unwrap();w.x=x;w.y=y;w.style.set(WindowStyle::VISIBLE,visible);if let Some(c)=w.control.as_mut(){c.style=(c.style&!0x10000000)|if visible{0x10000000}else{0};}w.set_client_size(&mut *machine.host,cw as u32,ch as u32);
 super::controls::paint_children(machine,hWnd);
 // Guest messages are real calls; no references into window/guest memory survive await.
 Box::pin(super::SendMessageA(machine,hWnd,Err(3),0,(x as u32&0xffff)|((y as u32&0xffff)<<16))).await;
 Box::pin(super::SendMessageA(machine,hWnd,Err(5),0,cw as u32|((ch as u32)<<16))).await;
 if visible!=previous{Box::pin(super::SendMessageA(machine,hWnd,Err(0x18),visible as u32,0)).await;}true
}
