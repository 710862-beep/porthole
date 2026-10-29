//! Wine-derived SYSTEM_INFO packing, LGPL-2.1-or-later.
//! wine-mirror/wine@0738d528db522f52d9d75f2aec712688dd31d1d2
//! dlls/kernelbase/memory.c:158-203,237-252, Copyright 1997 Alexandre Julliard.
//! Replaces NT queries with the virtual x86/Pentium, one-vCPU Win32 ABI profile,
//! not browser/physical CPU detection. Ranges describe address-space ABI, not
//! committed RAM; VirtualAlloc/protection/granularity enforcement remains partial.
use crate::Machine;
use memory::{Extensions,ExtensionsMut};
const TRACE_CONTEXT:&str="kernel32/sysinfo";
#[win32_derive::dllexport]
pub fn GetSystemInfo(machine:&mut Machine,lpSystemInfo:u32){
 if lpSystemInfo==0||lpSystemInfo.checked_add(36).map_or(true,|e|e as usize>machine.mem().as_slice().len()){
  super::teb_mut(machine).LastErrorValue=998;return
 }
 // Intel architecture/reserved, page size, user range, affinity, vCPUs,
 // Wine's processor-level→legacy processor-type mapping, granularity, level/rev.
 let fields=[0u32,4096,0x10000,0x7ffeffff,1,1,586,65536,5];
 for(i,v)in fields.into_iter().enumerate(){machine.mem().put_pod::<u32>(lpSystemInfo+i as u32*4,v)}
}
