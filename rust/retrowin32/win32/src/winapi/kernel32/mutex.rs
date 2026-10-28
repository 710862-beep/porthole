//! Wine-derived cooperative mutex objects. LGPL-2.1-or-later.
//! wine-mirror/wine@0738d528db522f52d9d75f2aec712688dd31d1d2:
//! kernelbase/sync.c:702-760,782-785; server/mutex.c:85-140,185-198.
//! Copyright 1998 Alexandre Julliard. NT/server objects -> per-Machine registry;
//! ownership is a real emulated CPU/thread ID, not a host JS boolean/promise.
//! Object names are process-isolated; security descriptors/cross-process IPC
//! are not supported. Current scheduler polls waits cooperatively.
const TRACE_CONTEXT: &str = "kernel32/mutex";
use crate::{Machine,winapi::types::{AnsiString,Str16}};
use std::{cell::RefCell,collections::{HashMap,HashSet},rc::{Rc,Weak}};
#[derive(Default)]struct MutexObject{owner:Option<u32>,count:u64,abandoned:bool}
#[derive(Default)]pub struct MutexRegistry{
 handles:HashMap<u32,Rc<RefCell<MutexObject>>>,names:HashMap<String,Weak<RefCell<MutexObject>>>,
 // Owned objects stay alive even after their last user handle is closed.
 owned:Vec<Rc<RefCell<MutexObject>>>,next:u32,
}
impl MutexRegistry{
 fn create(&mut self,name:Option<String>,owner:bool,tid:u32)->Result<(u32,bool),u32>{
  if self.handles.len()>=65536||self.next>=0x0ffffffe{return Err(8)}
  self.names.retain(|_,w|w.strong_count()>0);
  if name.as_ref().map_or(false,|s|s.encode_utf16().count()>260){return Err(206)}
  let existing=name.as_ref().and_then(|n|self.names.get(n)).and_then(Weak::upgrade);
  let exists=existing.is_some();let object=existing.unwrap_or_else(||Rc::new(RefCell::new(MutexObject::default())));
  if !exists {if owner{let mut m=object.borrow_mut();m.owner=Some(tid);m.count=1;self.owned.push(object.clone());}if let Some(n)=name{self.names.insert(n,Rc::downgrade(&object));}}
  self.next+=1;let h=0x30000000|self.next;self.handles.insert(h,object);Ok((h,exists))
 }
 pub fn close(&mut self,h:u32)->bool{self.handles.remove(&h).is_some()}
 pub fn ready(&self,h:u32,tid:u32)->Option<bool>{self.handles.get(&h).map(|r|{let m=r.borrow();m.owner.is_none()||m.owner==Some(tid)})}
 pub fn acquire(&mut self,h:u32,tid:u32)->bool{
  let Some(r)=self.handles.get(&h).cloned()else{return false};let mut m=r.borrow_mut();
  if m.owner.is_some()&&m.owner!=Some(tid){return false}
  if m.owner.is_none(){self.owned.push(r.clone());}m.owner=Some(tid);m.count=m.count.saturating_add(1);let abandoned=m.abandoned;m.abandoned=false;abandoned
 }
 fn release(&mut self,h:u32,tid:u32)->Result<(),u32>{
  let r=self.handles.get(&h).cloned().ok_or(6u32)?;
  {let mut m=r.borrow_mut();if m.owner!=Some(tid)||m.count==0{return Err(288)}m.count-=1;if m.count>0{return Ok(())}m.owner=None;}
  self.owned.retain(|p|!Rc::ptr_eq(p,&r));Ok(())
 }
 pub fn abandon(&mut self,dead:&HashSet<u32>){self.owned.retain(|r|{let mut m=r.borrow_mut();if m.owner.map_or(false,|t|dead.contains(&t)){m.owner=None;m.count=0;m.abandoned=true;false}else{true}});}
}
pub fn refresh_mutexes(machine:&mut Machine){
 #[cfg(feature="x86-emu")]{let dead=machine.emu.x86.cpus.iter().enumerate().filter_map(|(i,c)|if matches!(c.state,x86::CPUState::Terminated(_)){Some(i as u32+1)}else{None}).collect();machine.state.kernel32.mutexes.abandon(&dead);}
}
pub fn mutex_tid(machine:&Machine)->u32{
 #[cfg(feature="x86-emu")]{machine.emu.x86.cur_cpu as u32+1}
 #[cfg(not(feature="x86-emu"))]{let _=machine;1}
}
fn create(machine:&mut Machine,attributes:u32,owner:bool,name:Option<String>)->u32{
 if attributes!=0{super::teb_mut(machine).LastErrorValue=50;return 0}
 refresh_mutexes(machine);let tid=mutex_tid(machine);
 match machine.state.kernel32.mutexes.create(name,owner,tid){Ok((h,exists))=>{super::teb_mut(machine).LastErrorValue=if exists{183}else{0};h},Err(e)=>{super::teb_mut(machine).LastErrorValue=e;0}}
}
#[win32_derive::dllexport]
pub fn CreateMutexA(machine:&mut Machine,lpMutexAttributes:u32,bInitialOwner:bool,lpName:AnsiString)->u32{create(machine,lpMutexAttributes,bInitialOwner,lpName.0)}
#[win32_derive::dllexport]
pub fn CreateMutexW(machine:&mut Machine,lpMutexAttributes:u32,bInitialOwner:bool,lpName:Option<&Str16>)->u32{create(machine,lpMutexAttributes,bInitialOwner,lpName.map(|s|s.to_string()))}
#[win32_derive::dllexport]
pub fn ReleaseMutex(machine:&mut Machine,hMutex:u32)->bool{let tid=mutex_tid(machine);match machine.state.kernel32.mutexes.release(hMutex,tid){Ok(())=>true,Err(e)=>{super::teb_mut(machine).LastErrorValue=e;false}}}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn named_recursion_owner_and_lifetime(){let mut r=MutexRegistry::default();let(a,e)=r.create(Some("x".into()),true,1).unwrap();assert!(!e);let(b,e)=r.create(Some("x".into()),true,2).unwrap();assert!(e);assert_eq!(r.ready(b,2),Some(false));assert_eq!(r.release(b,2),Err(288));assert!(!r.acquire(a,1));r.release(a,1).unwrap();assert_eq!(r.ready(b,2),Some(false));r.release(a,1).unwrap();assert_eq!(r.ready(b,2),Some(true));r.close(a);r.close(b);assert!(!r.create(Some("x".into()),false,2).unwrap().1);}
 #[test]fn abandoned_and_closed_owned_reference(){let mut r=MutexRegistry::default();let(a,_)=r.create(Some("owned".into()),true,1).unwrap();r.close(a);let(b,e)=r.create(Some("owned".into()),false,2).unwrap();assert!(e);r.abandon(&[1].into_iter().collect());assert_eq!(r.ready(b,2),Some(true));assert!(r.acquire(b,2));assert!(!r.acquire(b,2));}
}
