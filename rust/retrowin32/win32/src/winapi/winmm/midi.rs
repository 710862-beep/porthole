//! Wine winmm/winmm.c:287-290 -> MMDRV_GetNum, lolvldrv.c:75+.
//! SHA 0738d528db522f52d9d75f2aec712688dd31d1d2; LGPL-2.1-or-later.
//! Copyright 1993 Martin Ayotte; 1998-2002 Eric Pouech.
//! Query installed output devices, NOT successful MIDI playback. This Host
//! profile installs no WinMM MIDI driver (as existing wave output is disabled).
//! No physical WebMIDI permission/devices or software synth are fabricated.
use crate::Machine;
const TRACE_CONTEXT:&str="winmm/midi";
#[win32_derive::dllexport]
pub fn midiOutGetNumDevs(machine:&mut Machine)->u32{machine.host.midi_output_count()}
