/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Modeless dialog subset adapted from Wine dlls/user32/dialog.c:191-301,
 * 443-713,719-774. wine-mirror/wine@0738d528db522f52d9d75f2aec712688dd31d1d2
 * Copyright 1993, 1994, 1996 Alexandre Julliard
 * Porthole adaptations: local HWND storage/Canvas, guest callback via call_x86,
 * checked owned templates. NOT a full Wine user32 port. See LICENSE.Wine.
 */
use super::{dialog_template::{self,Name,Template},*};
use crate::{Machine,winapi::{kernel32,types::*}};
use memory::Extensions;
use std::rc::Rc;
const TRACE_CONTEXT:&str="user32/dialog_helpers";
pub const DIALOG_PROC:u32=0xffff0020;
pub struct DialogInfo {pub proc:u32,pub result:u32,pub default_id:u32}
fn fail(machine:&mut Machine,code:u32)->HWND{kernel32::teb_mut(machine).LastErrorValue=code;HWND::null()}
fn text(n:&Name)->Result<String,u32>{match n{Name::None=>Ok(String::new()),Name::Text(s)=>Ok(s.clone()),_=>Err(50)}}
fn units(n:i16,base:i32,div:i32)->u32{let v=n as i32*base;((v+if v>=0{div/2}else{-div/2})/div)as u32}
fn send_msg(h:HWND,m:u32,w:u32,l:u32)->MSG{MSG{hwnd:h,message:m,wParam:w,lParam:l,time:0,pt_x:0,pt_y:0}}
fn tab_items(machine:&Machine,parent:HWND)->Vec<HWND>{let mut v:Vec<_>=machine.state.user32.windows.iter().filter(|w|w.parent==parent&&w.style.contains(WindowStyle::VISIBLE)&&!w.style.contains(WindowStyle::DISABLED)&&w.style.bits()&0x10000!=0).map(|w|w.hwnd).collect();v.sort_by_key(|h|h.to_raw());v}
pub async fn dispatch(machine:&mut Machine,msg:&MSG)->u32{
 let proc=machine.state.user32.windows.get(msg.hwnd).and_then(|w|w.dialog.as_ref()).map_or(0,|d|d.proc);
 if proc!=0{let handled=machine.call_x86(proc,vec![msg.hwnd.to_raw(),msg.message,msg.wParam,msg.lParam]).await;if handled!=0{return if msg.message==0x110{handled}else{machine.state.user32.windows.get(msg.hwnd).and_then(|w|w.dialog.as_ref()).map_or(0,|d|d.result)}}}
 if machine.state.user32.windows.get(msg.hwnd).is_none(){return 0}
 match msg.message{
  0x400=>machine.state.user32.windows.get(msg.hwnd).and_then(|w|w.dialog.as_ref()).map_or(0,|d|if d.default_id==0{0}else{0x534b0000|d.default_id}),
  0x401=>{if let Some(d)=machine.state.user32.windows.get_mut(msg.hwnd).and_then(|w|w.dialog.as_mut()){d.default_id=msg.wParam;}1},
  0x28=>{let h=if msg.lParam!=0{HWND::from_raw(msg.wParam)}else{{let focus=GetFocus(machine);GetNextDlgTabItem(machine,msg.hwnd,focus,msg.wParam!=0)}};if !h.is_null(){SetFocus(machine,h);}0},
  // Default close hides/destroys a modeless dialog; no fake modal result.
  0x10=>{DestroyWindow(machine,msg.hwnd);0},
  _=>Box::pin(DefWindowProcA(machine,msg.hwnd,WM::try_from(msg.message),msg.wParam,msg.lParam)).await,
 }
}
async fn create(machine:&mut Machine,inst:u32,parent:HWND,proc:u32,param:u32,t:Template)->HWND{
 // Menus, custom dialog classes and resource image captions need unported APIs.
 if t.menu!=Name::None||!matches!(&t.class,Name::None|Name::Id(32770)){return fail(machine,50)}
 let title=match text(&t.title){Ok(t)=>t,Err(e)=>return fail(machine,e)};
 if !machine.state.user32.wndclasses.iter().any(|c|c.name=="#32770") {machine.state.user32.wndclasses.push(Rc::new(WndClass{name:"#32770".into(),wndproc:DIALOG_PROC,background:HBRUSH::null()}));}
 // Base units match the existing fixed 8x8 raster font, not Wine's GDI fonts.
 if let Some(font)=&t.font{log::warn!("DIALOG_FONT_FALLBACK requested={font:?}, fixed 8x8 raster");}
 let title=String16::from(title.as_str());let class=String16::from("#32770");
 let width=units(t.cx,8,4);let height=units(t.cy,8,8);
 let mut rect=RECT{left:0,top:0,right:width as i32,bottom:height as i32};
 AdjustWindowRectEx(machine,Some(&mut rect),Ok(WindowStyle::from_bits_truncate(t.style)),false,Ok(WindowStyleEx::from_bits_truncate(t.ex)));
 let hwnd=Box::pin(CreateWindowExW(machine,Err(t.ex),CreateWindowClassName::Name(class.as_str16()),Some(title.as_str16()),Err(t.style&!0x10000000),units(t.x,8,4),units(t.y,8,8),(rect.right-rect.left)as u32,(rect.bottom-rect.top)as u32,parent,0,inst,0)).await;
 if hwnd.is_null(){return hwnd}
 machine.state.user32.windows.get_mut(hwnd).unwrap().dialog=Some(DialogInfo{proc,result:0,default_id:0});
 for item in t.items{
  let cls=match dialog_template::class_name(&item.class){Ok(c)=>c,Err(e)=>{DestroyWindow(machine,hwnd);return fail(machine,e)}};
  let caption=match text(&item.title){Ok(t)=>t,Err(e)=>{DestroyWindow(machine,hwnd);return fail(machine,e)}};
  if !item.data.is_empty(){DestroyWindow(machine,hwnd);return fail(machine,50)}
  let cls=String16::from(cls.as_str());let caption=String16::from(caption.as_str());
  let child=Box::pin(CreateWindowExW(machine,Err(item.ex|4),CreateWindowClassName::Name(cls.as_str16()),Some(caption.as_str16()),Err((item.style&!0x80000000)|0x40000000),units(item.x,8,4),units(item.y,8,8),units(item.cx,8,4),units(item.cy,8,8),hwnd,item.id,inst,0)).await;
  if child.is_null(){if t.style&0x10!=0{continue}DestroyWindow(machine,hwnd);return HWND::null()}
  if item.style&0xf==1 {machine.state.user32.windows.get_mut(hwnd).unwrap().dialog.as_mut().unwrap().default_id=item.id;}
 }
 let focus=GetNextDlgTabItem(machine,hwnd,HWND::null(),false);
 let handled=Box::pin(dispatch(machine,&send_msg(hwnd,0x110,focus.to_raw(),param))).await;
 if machine.state.user32.windows.get(hwnd).is_some(){
  if handled!=0{let focus=GetNextDlgTabItem(machine,hwnd,HWND::null(),false);if !focus.is_null(){SetFocus(machine,focus);}}
  if t.style&0x10000000!=0{Box::pin(ShowWindow(machine,hwnd,Ok(SW::NORMAL))).await;}
 }
 hwnd
}
pub async fn indirect(machine:&mut Machine,inst:u32,ptr:u32,len:Option<usize>,parent:HWND,proc:u32,param:u32)->HWND{
 if ptr==0{return fail(machine,87)}
 let parsed={let mem=machine.mem();let b=mem.as_slice();match b.get(ptr as usize..){Some(b)=>dialog_template::parse(&b[..len.unwrap_or(b.len()).min(b.len()).min(1048576)]),None=>Err(87)}};
 match parsed{Ok(t)=>Box::pin(create(machine,inst,parent,proc,param,t)).await,Err(e)=>fail(machine,e)}
}
#[win32_derive::dllexport]
pub async fn CreateDialogParamA(machine:&mut Machine,hInstance:u32,lpTemplateName:u32,hWndParent:HWND,lpDialogFunc:u32,dwInitParam:u32)->HWND{
 let instance=if hInstance==0{machine.state.kernel32.image_base}else{hInstance};
 let name=if lpTemplateName>>16==0{ResourceKey::Id(lpTemplateName)}else{
  let name={let mem=machine.mem();let Some(bytes)=mem.as_slice().get(lpTemplateName as usize..)else{return fail(machine,87)};let Some(n)=bytes.iter().take(65536).position(|&b|b==0)else{return fail(machine,87)};crate::str16::decode_cp1252(&bytes[..n])};ResourceKey::Name(String16::from(name.as_str()))
 };
 // Use range directly: retrowin32 LoadResource returns a handle, not Wine's pointer.
 let range=kernel32::find_resource(&machine.state.kernel32,machine.mem(),instance,ResourceKey::Id(5),name.as_ref());
 let Some(range)=range else{return fail(machine,1814)};
 log::debug!("Wine-derived CreateDialogParamA template={range:?}");
 indirect(machine,instance,range.start,Some(range.len()),hWndParent,lpDialogFunc,dwInitParam).await
}
#[win32_derive::dllexport]
pub async fn CreateDialogIndirectParamA(machine:&mut Machine,hInstance:u32,lpTemplate:u32,hWndParent:HWND,lpDialogFunc:u32,dwInitParam:u32)->HWND{indirect(machine,hInstance,lpTemplate,None,hWndParent,lpDialogFunc,dwInitParam).await}
#[win32_derive::dllexport]
pub fn GetDialogBaseUnits(_machine:&mut Machine)->u32{8|(8<<16)}
#[win32_derive::dllexport]
pub fn MapDialogRect(machine:&mut Machine,hDlg:HWND,lpRect:Option<&mut RECT>)->bool{if machine.state.user32.windows.get(hDlg).and_then(|w|w.dialog.as_ref()).is_none(){fail(machine,1400);return false}let Some(r)=lpRect else{fail(machine,87);return false};r.left=r.left*2;r.right=r.right*2;true}
#[win32_derive::dllexport]
pub fn GetNextDlgTabItem(machine:&mut Machine,hDlg:HWND,hCtl:HWND,bPrevious:bool)->HWND{
 let v=tab_items(machine,hDlg);if v.is_empty(){return HWND::null()}let pos=v.iter().position(|&h|h==hCtl);let i=match pos{Some(i)=>if bPrevious{(i+v.len()-1)%v.len()}else{(i+1)%v.len()},None=>if bPrevious{v.len()-1}else{0}};v[i]
}
#[win32_derive::dllexport]
pub async fn IsDialogMessageA(machine:&mut Machine,hDlg:HWND,lpMsg:Option<&MSG>)->bool{
 let Some(m)=lpMsg else{return false};let mut h=m.hwnd;let mut found=false;
 for _ in 0..64{if h==hDlg{found=true;break}let Some(w)=machine.state.user32.windows.get(h)else{break};if w.parent.is_null(){break}h=w.parent;}
 if !found{return false}
 if m.message==0x100&&m.wParam==9{let next=GetNextDlgTabItem(machine,hDlg,m.hwnd,false);SetFocus(machine,next);return true}
 if m.message==0x100&&(m.wParam==13||m.wParam==27){let id=if m.wParam==27{2}else{machine.state.user32.windows.get(hDlg).and_then(|w|w.dialog.as_ref()).map_or(1,|d|if d.default_id==0{1}else{d.default_id})};let child=GetDlgItem(machine,hDlg,id as i32);Box::pin(dispatch(machine,&send_msg(hDlg,0x111,id,child.to_raw()))).await;return true}
 false
}
#[win32_derive::dllexport]
pub async fn SendDlgItemMessageA(machine:&mut Machine,hDlg:HWND,nIDDlgItem:i32,Msg:u32,wParam:u32,lParam:u32)->u32{let child=GetDlgItem(machine,hDlg,nIDDlgItem);if child.is_null(){return 0}Box::pin(dispatch_message(machine,&send_msg(child,Msg,wParam,lParam))).await}
// Wine dialog.c:1310-1380,1434-1492; local HWND lookup replaces server traversal.
#[win32_derive::dllexport]
pub fn GetDlgItem(machine:&mut Machine,hDlg:HWND,nIDDlgItem:i32)->HWND{machine.state.user32.windows.iter().filter(|w|w.parent==hDlg&&w.id==nIDDlgItem as u32).min_by_key(|w|w.hwnd.to_raw()).map_or(HWND::null(),|w|w.hwnd)}
#[win32_derive::dllexport]
pub async fn SetDlgItemTextA(machine:&mut Machine,hDlg:HWND,nIDDlgItem:i32,lpString:u32)->bool{SendDlgItemMessageA(machine,hDlg,nIDDlgItem,0xc,0,lpString).await!=0}
#[win32_derive::dllexport]
pub async fn GetDlgItemTextA(machine:&mut Machine,hDlg:HWND,nIDDlgItem:i32,lpString:u32,cchMax:i32)->u32{
 if cchMax<=0{return 0}let valid={let mem=machine.mem();lpString!=0&&(lpString as usize).checked_add(cchMax as usize).map_or(false,|end|end<=mem.as_slice().len())};
 if !valid{fail(machine,87);return 0}use memory::ExtensionsMut;machine.mem().sub32_mut(lpString,1)[0]=0;
 SendDlgItemMessageA(machine,hDlg,nIDDlgItem,0xd,cchMax as u32,lpString).await
}
#[win32_derive::dllexport]
pub async fn CheckDlgButton(machine:&mut Machine,hDlg:HWND,nIDButton:i32,uCheck:u32)->bool{SendDlgItemMessageA(machine,hDlg,nIDButton,0xf1,uCheck,0).await;true}
#[win32_derive::dllexport]
pub async fn IsDlgButtonChecked(machine:&mut Machine,hDlg:HWND,nIDButton:i32)->u32{SendDlgItemMessageA(machine,hDlg,nIDButton,0xf0,0,0).await}
#[win32_derive::dllexport]
pub async fn CheckRadioButton(machine:&mut Machine,hDlg:HWND,nIDFirstButton:i32,nIDLastButton:i32,nIDCheckButton:i32)->bool{
 let children:Vec<_>=machine.state.user32.windows.iter().filter(|w|w.parent==hDlg&&(w.id as i32)>=nIDFirstButton&&(w.id as i32)<=nIDLastButton).map(|w|(w.hwnd,w.id)).collect();
 for (h,id) in children{Box::pin(dispatch_message(machine,&send_msg(h,0xf1,if id==nIDCheckButton as u32{1}else{0},0))).await;}true
}
