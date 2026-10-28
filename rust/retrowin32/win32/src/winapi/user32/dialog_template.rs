/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Adapted from Wine dlls/user32/dialog.c:87-181,310-432
 * wine-mirror/wine@0738d528db522f52d9d75f2aec712688dd31d1d2
 * Copyright 1993, 1994, 1996 Alexandre Julliard
 * Rust/Wasm adaptations: checked byte cursor, owned UTF-16 strings, bounded
 * resources instead of unbounded native pointers. See LICENSE.Wine.
 */
#[derive(Debug, Clone, PartialEq)]
pub enum Name { None, Id(u16), Text(String) }
#[derive(Debug)]
pub struct Item { pub style:u32, pub ex:u32, pub id:u32, pub x:i16, pub y:i16, pub cx:i16, pub cy:i16, pub class:Name, pub title:Name, pub data:Vec<u8> }
#[derive(Debug)]
pub struct Template { pub style:u32, pub ex:u32, pub x:i16, pub y:i16, pub cx:i16, pub cy:i16, pub menu:Name, pub class:Name, pub title:Name, pub font:Option<(u16,String)>, pub items:Vec<Item> }
struct Cursor<'a> { b:&'a[u8], p:usize }
impl<'a> Cursor<'a> {
 fn take(&mut self,n:usize)->Result<&'a[u8],u32>{let end=self.p.checked_add(n).ok_or(13u32)?;let s=self.b.get(self.p..end).ok_or(13u32)?;self.p=end;Ok(s)}
 fn w(&mut self)->Result<u16,u32>{let b=self.take(2)?;Ok(u16::from_le_bytes([b[0],b[1]]))}
 fn d(&mut self)->Result<u32,u32>{let b=self.take(4)?;Ok(u32::from_le_bytes([b[0],b[1],b[2],b[3]]))}
 fn align(&mut self)->Result<(),u32>{let n=(4-self.p%4)%4;self.take(n)?;Ok(())}
 fn text(&mut self,first:u16)->Result<String,u32>{let mut chars=vec![first];loop{let c=self.w()?;if c==0{break}chars.push(c);if chars.len()>32767{return Err(13)}}Ok(String::from_utf16_lossy(&chars))}
 fn name(&mut self)->Result<Name,u32>{Ok(match self.w()?{0=>Name::None,0xffff=>Name::Id(self.w()?),c=>Name::Text(self.text(c)?)})}
}
pub fn parse(bytes:&[u8])->Result<Template,u32>{
 let mut c=Cursor{b:bytes,p:0};let a=c.w()?;let b=c.w()?;let extended=a==1&&b==0xffff;
 let (style,ex)=if extended {c.d()?;let ex=c.d()?;let style=c.d()?;(style,ex)}else{((a as u32)|((b as u32)<<16),c.d()?)};
 let count=c.w()?;if count>4096{return Err(13)}
 let (x,y,cx,cy)=(c.w()? as i16,c.w()? as i16,c.w()? as i16,c.w()? as i16);
 let menu=c.name()?;let class=c.name()?;let title=c.name()?;
 let font=if style&0x40!=0{let size=c.w()?;if size==0x7fff{Some((size,String::new()))}else{if extended{c.w()?;c.w()?;}let name=c.name()?;Some((size,match name{Name::Text(t)=>t,Name::None=>String::new(),_=>return Err(13)}))}}else{None};
 let mut items=Vec::new();
 for _ in 0..count{
  c.align()?;
  let (style,ex)=if extended{c.d()?;let ex=c.d()?;(c.d()?,ex)}else{let s=c.d()?;(s,c.d()?)};
  let (x,y,cx,cy)=(c.w()? as i16,c.w()? as i16,c.w()? as i16,c.w()? as i16);
  let id=if extended{c.d()?}else{c.w()? as u32};
  let class=c.name()?;let title=c.name()?;
  // Wine advances past count WORD plus count bytes of creation data.
  let n=c.w()? as usize;let data=c.take(n)?.to_vec();
  if cx<0||cy<0{return Err(13)}
  items.push(Item{style,ex,id,x,y,cx,cy,class,title,data});
 }
 if cx<0||cy<0{return Err(13)}
 Ok(Template{style,ex,x,y,cx,cy,menu,class,title,font,items})
}
pub fn class_name(n:&Name)->Result<String,u32>{match n{Name::Text(s)=>Ok(s.clone()),Name::Id(v)=>{let id=if *v>=0x80{*v-0x80}else{*v};Ok(["BUTTON","EDIT","STATIC","LISTBOX","SCROLLBAR","COMBOBOX"].get(id as usize).ok_or(1407u32)?.to_string())},_=>Err(1407)}}
#[cfg(test)]mod tests{
 use super::*;
 fn normal()->Vec<u8>{let mut b=vec![0u8;18];b.extend_from_slice(&[0,0,0,0,0,0]);b}
 #[test]fn empty_and_truncated(){let b=normal();assert!(parse(&b).is_ok());for n in 0..b.len(){assert!(parse(&b[..n]).is_err());}}
 #[test]fn extended_empty(){let mut b=vec![0u8;26];b[0]=1;b[2]=255;b[3]=255;b.extend_from_slice(&[0;6]);assert!(parse(&b).is_ok());}
 #[test]fn atom_aliases(){assert_eq!(class_name(&Name::Id(0x81)).unwrap(),"EDIT");assert_eq!(class_name(&Name::Id(1)).unwrap(),"EDIT");assert!(class_name(&Name::Id(0x86)).is_err());}
 #[test]fn font_special_case(){let mut b=normal();b[0]=0x40;b.extend_from_slice(&[255,127]);assert_eq!(parse(&b).unwrap().font.unwrap().0,0x7fff);}
}
