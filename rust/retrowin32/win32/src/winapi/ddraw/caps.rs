//! Wine-derived capability query/size-preserving copies, LGPL-2.1-or-later.
//! Wine 0738d528db522f52d9d75f2aec712688dd31d1d2, dlls/ddraw/ddraw.c:1524-1639,
//! ddraw_private.h:734-745; include/ddraw.h DDCAPS_DX3/DX5/DX6/DX7.
//! Copyright 1997-2000 Marcus Meissner; 1998-2000 Lionel Ulmer;
//! 2000-2001 TransGaming; 2006 Stefan Dösinger; 2008 Denver Gingerich;
//! 2007-2008,2011,2013 Stefan Dösinger for CodeWeavers.
//! Wined3D queries replaced by existing software surface/palette/heap state.
//! No GPU/3D/overlay/FourCC/stretch/colorfill capabilities are fabricated.
use crate::Machine;
use memory::{Extensions,ExtensionsMut};
pub(super) fn get_caps(machine:&mut Machine,driver:u32,hel:u32)->u32{
 const INVALID:u32=0x80070057;
 if driver==0&&hel==0{return INVALID}
 let mut targets=Vec::new();
 for p in [driver,hel]{
  if p==0{continue}
  if p.checked_add(4).map_or(true,|e|e as usize>machine.mem().as_slice().len()){return INVALID}
  let size=machine.mem().get_pod::<u32>(p);
  if size<4{return INVALID}
  let bytes=size.min(380);
  if p.checked_add(bytes).map_or(true,|e|e as usize>machine.mem().as_slice().len()){return INVALID}
  targets.push((p,size,bytes));
 }
 let mut caps=[0u32;95];
 caps[0]=380;
 caps[1]=0x8000; // DDCAPS_PALETTE: actual 8-bit software palette conversion
 caps[6]=0x14; // DDPCAPS_8BIT | PRIMARYSURFACE
 caps[15]=machine.state.ddraw.heap.size;
 caps[16]=machine.state.ddraw.heap.free_bytes(); // actual shared software heap
 caps[33]=0xa5c; // backbuffer/complex/flip/offscreen/primary/system-memory
 caps[91]=caps[33]; // DX6/7 DDSCAPS2; extra capability words remain zero
 for(p,size,bytes)in targets{
  for i in 0..bytes{let value=caps[(i/4)as usize].to_le_bytes()[(i%4)as usize];machine.mem().put_pod::<u8>(p+i,value)}
  machine.mem().put_pod::<u32>(p,size); // DD_STRUCT_COPY_BYSIZE restores caller size
 }
 0
}
