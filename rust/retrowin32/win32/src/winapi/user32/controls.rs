//! Native, per-HWND controls. Guest pointers are checked offsets, never host pointers.
//! First implementation: basic Latin ANSI text, single-line edit/single-selection lists.
use super::{window::*, message::MSG};
use crate::{Machine, winapi::{kernel32, types::HWND}};
use memory::{Extensions, ExtensionsMut};
use std::rc::Rc;

pub const NATIVE_PROC: u32 = 0xffff0010;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Button, Edit, Static, Listbox, Combo, Scroll, Progress, Tab }
#[derive(Clone)]
pub struct Control {
    pub kind: Kind, pub text: Vec<u8>, pub style: u32,
    pub pressed: bool, pub hover: bool, pub checked: u32,
    pub start: usize, pub end: usize, pub limit: usize,
    pub items: Vec<Vec<u8>>, pub selected: i32,
    pub low: i32, pub high: i32, pub position: i32, pub step: i32,
    pub focus: bool, pub image:u32,
}
impl Control {
    pub fn new(kind:Kind,text:&str,style:u32)->Self {Self {kind,text:text.as_bytes().to_vec(),style,pressed:false,hover:false,checked:0,start:0,end:0,limit:32767,items:vec![],selected:-1,low:0,high:100,position:0,step:10,focus:false,image:0}}
    fn replace(&mut self, bytes:&[u8]) {
        let a=self.start.min(self.end).min(self.text.len());let b=self.start.max(self.end).min(self.text.len());
        let n=bytes.len().min(self.limit.saturating_sub(self.text.len()-(b-a)));
        self.text.splice(a..b,bytes[..n].iter().copied());self.start=a+n;self.end=self.start;
    }
}
pub fn register(machine:&mut Machine,name:&str, _kind:Kind) {
    if !machine.state.user32.wndclasses.iter().any(|c|c.name.eq_ignore_ascii_case(name)) {
        machine.state.user32.wndclasses.push(Rc::new(WndClass{name:name.into(),wndproc:NATIVE_PROC,background:super::HBRUSH::null()}));
    }
}
pub fn standard(machine:&mut Machine) {
    for (name,kind) in [("BUTTON",Kind::Button),("EDIT",Kind::Edit),("STATIC",Kind::Static),("LISTBOX",Kind::Listbox),("COMBOBOX",Kind::Combo),("SCROLLBAR",Kind::Scroll)] {register(machine,name,kind);}
}
pub fn kind(name:&str)->Option<Kind> {Some(match name.to_ascii_uppercase().as_str(){"BUTTON"=>Kind::Button,"EDIT"=>Kind::Edit,"STATIC"=>Kind::Static,"LISTBOX"=>Kind::Listbox,"COMBOBOX"=>Kind::Combo,"SCROLLBAR"=>Kind::Scroll,"MSCTLS_PROGRESS32"=>Kind::Progress,"SYSTABCONTROL32"=>Kind::Tab,_=>return None})}
fn error(machine:&mut Machine,code:u32)->u32{kernel32::teb_mut(machine).LastErrorValue=code;0}
fn string(machine:&Machine,ptr:u32)->Option<Vec<u8>> {
    if ptr==0{return Some(vec![])}
    let mem=machine.mem();let bytes=mem.as_slice().get(ptr as usize..)?;
    let n=bytes.iter().take(65536).position(|&b|b==0)?;Some(bytes[..n].to_vec())
}
fn put(machine:&mut Machine,ptr:u32,bytes:&[u8])->bool {
    if ptr==0{return false}let mem=machine.mem();
    let Some(end)=(ptr as usize).checked_add(bytes.len()) else{return false};
    if end>mem.as_slice().len(){return false}mem.sub32_mut(ptr,bytes.len() as u32).copy_from_slice(bytes);true
}
fn copy_text(machine:&mut Machine,ptr:u32,capacity:u32,text:&[u8])->u32 {
    if capacity==0{return 0}let n=text.len().min(capacity as usize-1);let mut bytes=text[..n].to_vec();bytes.push(0);
    if !put(machine,ptr,&bytes){return error(machine,87)}n as u32
}

// Rasterize into the real top-level pixel buffer and present through the existing host.
// Child geometry is clipped both to the control and to its parent's backing surface.
pub fn paint(machine:&mut Machine,hwnd:HWND) {
    let Some(w)=machine.state.user32.windows.get(hwnd) else{return};
    let Some(c)=w.control.clone() else{return};let (width,height)=(w.width.min(4096),w.height.min(4096));
    if width==0||height==0{return}
    let mut root=hwnd;let mut ox=0i32;let mut oy=0i32;
    for _ in 0..64 {let Some(w)=machine.state.user32.windows.get(root) else{return};if matches!(w.typ,WindowType::TopLevel(_)){break}ox=ox.saturating_add(w.x);oy=oy.saturating_add(w.y);root=w.parent;}
    let mut px=vec![[240,240,240,255];(width*height) as usize];
    let black=[20,20,20,255];let blue=[30,80,180,255];let white=[255,255,255,255];
    let mut dot=|x:i32,y:i32,color:[u8;4]|{if x>=0&&y>=0&&(x as u32)<width&&(y as u32)<height {px[(y as u32*width+x as u32) as usize]=color;}};
    let mut texts:Vec<(i32,i32,Vec<u8>,[u8;4])>=vec![];
    if matches!(c.kind,Kind::Edit|Kind::Listbox|Kind::Combo){for y in 0..height as i32 {for x in 0..width as i32 {dot(x,y,white)}}}
    if c.kind!=Kind::Static {
        for x in 0..width as i32 {dot(x,0,black);dot(x,height as i32-1,black)}
        for y in 0..height as i32 {dot(0,y,black);dot(width as i32-1,y,black)}
    }
    match c.kind {
        Kind::Button=>{
            if c.pressed {for y in 1..height as i32-1{for x in 1..width as i32-1{dot(x,y,[180,180,180,255]);}}}
            let ty=c.style&15;
            if matches!(ty,2|3|4|5|6|9) {for y in 4..14 {for x in 3..13 {dot(x,y,if c.checked!=0 {black}else{white});}}}
            texts.push((if matches!(ty,2|3|4|5|6|9){18}else{((width as i32-c.text.len() as i32*8)/2).max(2)},((height as i32-8)/2).max(1),c.text.clone(),black));
        }
        Kind::Edit=>{
            let a=c.start.min(c.end);let b=c.start.max(c.end);
            for i in a..b {for y in 2..12 {for x in i as i32*8+3..i as i32*8+11 {dot(x,y,blue)}}}
            texts.push((3,3,c.text.clone(),black));
            if c.focus {let x=3+c.end as i32*8;for y in 2..12{dot(x,y,black)}}
        }
        Kind::Listbox=>{for (i,text) in c.items.iter().enumerate(){let y=2+i as i32*12;if i as i32==c.selected{for yy in y..y+12{for x in 1..width as i32-1{dot(x,yy,blue)}}}texts.push((3,y+2,text.clone(),if i as i32==c.selected{white}else{black}));}}
        Kind::Combo=>{texts.push((3,3,if c.selected>=0 {c.items.get(c.selected as usize).cloned().unwrap_or_default()}else{c.text.clone()},black));let x=width as i32-12;for yy in 4..10{for xx in x..x+8-(yy-4){dot(xx,yy,black)}}}
        Kind::Scroll|Kind::Progress=>{
            let span=(c.high as i64-c.low as i64).max(1);let p=((c.position as i64-c.low as i64)*(width as i64-4)/span) as i32;
            if c.kind==Kind::Progress {for y in 2..height as i32-2{for x in 2..p+2{dot(x,y,blue)}}}
            else {for y in 2..height as i32-2{for x in p..p+8{dot(x.min(width as i32-2),y,blue)}}}
        }
        Kind::Tab=>{let mut x=2;for (i,text) in c.items.iter().enumerate(){texts.push((x,3,text.clone(),if i as i32==c.selected{blue}else{black}));x+=text.len() as i32*8+12;}}
        Kind::Static=>{
            if c.image==0 {texts.push((2,2,c.text.clone(),black));}
            else if let Some(crate::winapi::gdi32::Object::Bitmap(image))=machine.state.gdi32.objects.get(crate::winapi::gdi32::HGDIOBJ::from_raw(c.image)) {
                match image {
                    crate::winapi::gdi32::BitmapType::RGBA32(b)=>{let pixels=b.pixels.as_slice(machine.mem());for y in 0..b.height.min(height){for x in 0..b.width.min(width){if let Some(color)=pixels.get((y*b.width+x)as usize){let mut color=*color;color[3]=255;dot(x as i32,y as i32,color)}}}},
                    crate::winapi::gdi32::BitmapType::Mono(b)=>{let pixels=b.pixels.as_slice(machine.mem());let stride=crate::winapi::bitmap::BitmapMono::stride(b.width);for y in 0..b.height.min(height){for x in 0..b.width.min(width){if let Some(byte)=pixels.get((y*stride+x/8)as usize){dot(x as i32,y as i32,if byte&(0x80>>(x%8))!=0{white}else{black});}}}}
                }
            }
        },
    }
    for (x,y,text,color) in texts {for (i,ch) in text.iter().enumerate(){let glyph=super::control_font::FONT.get(*ch as usize).unwrap_or(&super::control_font::FONT[63]);for (row,bits) in glyph.iter().enumerate(){for col in 0..8 {if bits&(1<<col)!=0 {dot(x+i as i32*8+col,y+row as i32,color)}}}}}
    drop(dot);
    let Some(w)=machine.state.user32.windows.get_mut(root) else{return};
    if !matches!(w.typ,WindowType::TopLevel(_)){return}
    let (rw,rh)=(w.width,w.height);let dest=w.bitmap_mut().pixels.as_slice_mut();
    for y in 0..height as i32 {for x in 0..width as i32 {let dx=ox+x;let dy=oy+y;if dx>=0&&dy>=0&&(dx as u32)<rw&&(dy as u32)<rh{dest[(dy as u32*rw+dx as u32)as usize]=px[(y as u32*width+x as u32)as usize];}}}
    w.expect_toplevel_mut().flush_pixels(machine.emu.memory.mem());
}
pub fn paint_children(machine:&mut Machine,parent:HWND){let children:Vec<_>=machine.state.user32.windows.iter().filter(|w|w.parent==parent&&w.control.is_some()).map(|w|w.hwnd).collect();for child in children {paint(machine,child)}}

pub async fn dispatch(machine:&mut Machine,msg:&MSG)->u32 {
    let (hwnd,m,wp,lp)=(msg.hwnd,msg.message,msg.wParam,msg.lParam);
    let incoming=if matches!(m,0xc|0xc2|0x180|0x143|0x181|0x14a){match string(machine,lp){Some(v)=>v,None=>return error(machine,87)}}else{vec![]};
    if m==0x172 && (wp!=0 || (lp!=0&&!matches!(machine.state.gdi32.objects.get(crate::winapi::gdi32::HGDIOBJ::from_raw(lp)),Some(crate::winapi::gdi32::Object::Bitmap(_))))){return error(machine,87)}
    let Some(w)=machine.state.user32.windows.get_mut(hwnd) else{return error(machine,1400)};
    let (parent,id)=(w.parent,w.id);let Some(c)=w.control.as_mut() else{return 0};
    let mut notify=None;let mut result=0u32;let mut redraw=true;let mut output=None;
    match m {
        1=>{}, 0xf=>{}, 7=>c.focus=true,8=>c.focus=false,
        0xc=>{c.text=incoming;c.start=c.text.len();c.end=c.start;result=1},
        0xd=>{output=Some((lp,wp,c.text.clone()))},0xe=>{result=c.text.len() as u32;redraw=false},
        0x172 if c.kind==Kind::Static=>{result=c.image;c.image=lp},
        0x173 if c.kind==Kind::Static=>{result=c.image;redraw=false},
        0x30=>{}, // WM_SETFONT: the fixed public-domain bitmap font is the supported profile.
        0x200=>c.hover=true,
        0x201=>{c.pressed=true;c.focus=true;if c.kind==Kind::Edit{c.start=((lp&0xffff) as usize/8).min(c.text.len());c.end=c.start;}if c.kind==Kind::Listbox{let i=((lp>>16) as usize/12)as i32;if i>=0&&(i as usize)<c.items.len(){c.selected=i;notify=Some(1)}}},
        0x202|0xf5=>{if c.kind==Kind::Button&&(c.pressed||m==0xf5){c.pressed=false;let ty=c.style&15;if ty==3 {c.checked^=1}if ty==6 {c.checked=(c.checked+1)%3}if ty==9{c.checked=1}notify=Some(0)}else if c.kind==Kind::Scroll {let old=c.position;c.position=(c.low+((lp&0xffff)as i64*(c.high as i64-c.low as i64)/w.width.max(1)as i64)as i32).clamp(c.low,c.high);if old!=c.position{notify=Some(0xffff)}}},
        0xf0 if c.kind==Kind::Button=>{result=c.checked;redraw=false},
        0xf1 if c.kind==Kind::Button=>c.checked=wp.min(if matches!(c.style&15,5|6){2}else{1}),
        0xf2 if c.kind==Kind::Button=>{result=c.checked|if c.pressed{4}else{0};redraw=false},
        0xf3 if c.kind==Kind::Button=>c.pressed=wp!=0,
        0xf4 if c.kind==Kind::Button=>c.style=(c.style&!15)|(wp&15),
        0xb0 if c.kind==Kind::Edit=>{let a=c.start as u32;let b=c.end as u32;result=(a&0xffff)|(b<<16);if wp!=0&&!put(machine,wp,&a.to_le_bytes()){return error(machine,87)}if lp!=0&&!put(machine,lp,&b.to_le_bytes()){return error(machine,87)}return result},
        0xb1 if c.kind==Kind::Edit=>{if wp==u32::MAX{c.start=c.end}else{c.start=(wp as usize).min(c.text.len());c.end=(lp as usize).min(c.text.len());}},
        0xc5 if c.kind==Kind::Edit=>c.limit=if wp==0{32767}else{wp.min(65535)as usize},
        0xc2 if c.kind==Kind::Edit=>{if c.style&0x800==0{c.replace(&incoming);notify=Some(0x300)}},
        0x102 if c.kind==Kind::Edit=>{if c.style&0x800==0&&wp>=32&&wp<127{c.replace(&[wp as u8]);notify=Some(0x300)}},
        0x100 if c.kind==Kind::Edit=>{
            match wp {8 if c.style&0x800==0=>{if c.start==c.end&&c.start>0{c.start-=1}c.replace(&[]);notify=Some(0x300)},0x2e if c.style&0x800==0=>{if c.start==c.end{c.end=(c.end+1).min(c.text.len())}c.replace(&[]);notify=Some(0x300)},0x25=>{c.end=c.start.min(c.end).saturating_sub(1);c.start=c.end},0x27=>{c.end=(c.start.max(c.end)+1).min(c.text.len());c.start=c.end},0x24=>{c.start=0;c.end=0},0x23=>{c.start=c.text.len();c.end=c.start},_=>{redraw=false}}
        }
        0x180|0x143 if matches!(c.kind,Kind::Listbox|Kind::Combo)=>{let i=if c.style & if c.kind==Kind::Combo{0x100}else{2} !=0{c.items.partition_point(|s|s<&incoming)}else{c.items.len()};c.items.insert(i,incoming);if c.selected>=i as i32{c.selected+=1}result=i as u32},
        0x182|0x144 if matches!(c.kind,Kind::Listbox|Kind::Combo)=>{if (wp as usize)<c.items.len(){c.items.remove(wp as usize);if c.selected==wp as i32{c.selected=-1}else if c.selected>wp as i32{c.selected-=1}result=c.items.len()as u32}else{result=u32::MAX}},
        0x184|0x14b if matches!(c.kind,Kind::Listbox|Kind::Combo)=>{c.items.clear();c.selected=-1},
        0x186|0x14e if matches!(c.kind,Kind::Listbox|Kind::Combo)=>{if wp==u32::MAX{c.selected=-1;result=u32::MAX}else if (wp as usize)<c.items.len(){c.selected=wp as i32;result=wp}else{result=u32::MAX}},
        0x188|0x147 if matches!(c.kind,Kind::Listbox|Kind::Combo)=>{result=c.selected as u32;redraw=false},
        0x18b|0x146 if matches!(c.kind,Kind::Listbox|Kind::Combo)=>{result=c.items.len()as u32;redraw=false},
        0x18a|0x149 if matches!(c.kind,Kind::Listbox|Kind::Combo)=>{result=c.items.get(wp as usize).map_or(u32::MAX,|s|s.len()as u32);redraw=false},
        0x189|0x148 if matches!(c.kind,Kind::Listbox|Kind::Combo)=>{if let Some(s)=c.items.get(wp as usize){output=Some((lp,s.len()as u32+1,s.clone()))}else{result=u32::MAX}},
        0x401 if c.kind==Kind::Progress=>{result=(c.low as u32&0xffff)|((c.high as u32)<<16);let low=(lp as u16)as i16 as i32;let high=((lp>>16)as u16)as i16 as i32;if low>high{return error(machine,87)}c.low=low;c.high=high;c.position=c.position.clamp(low,high)},
        0x402|0x403|0x405 if c.kind==Kind::Progress=>{result=c.position as u32;c.position=match m{0x402=>wp as i32,0x403=>c.position.saturating_add(wp as i32),_=>c.position.saturating_add(c.step)}.clamp(c.low,c.high)},
        0x404 if c.kind==Kind::Progress=>{result=c.step as u32;c.step=wp as i32},
        0x406 if c.kind==Kind::Progress=>{result=c.position as u32;let low=wp as i32;let high=lp as i32;if low>high{return error(machine,87)}c.low=low;c.high=high;c.position=c.position.clamp(low,high)},
        0x408 if c.kind==Kind::Progress=>{result=c.position as u32;redraw=false},
        0xe0 if c.kind==Kind::Scroll=>{result=c.position as u32;c.position=(wp as i32).clamp(c.low,c.high)},
        0xe1 if c.kind==Kind::Scroll=>{result=c.position as u32;redraw=false},
        0xe2|0xe6 if c.kind==Kind::Scroll=>{if wp as i32>lp as i32{return error(machine,87)}c.low=wp as i32;c.high=lp as i32;c.position=c.position.clamp(c.low,c.high)},
        _=>{redraw=false;log::debug!("unsupported control message {:?} {m:x}",c.kind);}
    }
    let scroll_position=c.position as u32;let vertical=c.style&1!=0;
    if let Some((ptr,cap,text))=output {result=copy_text(machine,ptr,cap,&text);}
    if redraw {paint(machine,hwnd)}
    if let Some(code)=notify {if !parent.is_null(){let notification=MSG{hwnd:parent,message:if code==0xffff{if vertical{0x115}else{0x114}}else{0x111},wParam:if code==0xffff{4|((scroll_position&0xffff)<<16)}else{(id&0xffff)|((code as u32)<<16)},lParam:hwnd.to_raw(),time:0,pt_x:0,pt_y:0};Box::pin(super::message::dispatch_message(machine,&notification)).await;}}
    result
}
