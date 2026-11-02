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

// Wine winmm.c:571-581: MMDRV_Get(handle,MIDIOUT,TRUE) failing returns
// MMSYSERR_INVALHANDLE; no successful MODM_SETVOLUME is fabricated.
#[win32_derive::dllexport]
pub fn midiOutSetVolume(machine:&mut Machine,hMidiOut:u32,dwVolume:u32)->u32{machine.host.midi_output_set_volume(hMidiOut,dwVolume)}

// Wine winmm/winmm.c:475-503,1357-1414 (LGPL-2.1-or-later, SHA
// 0738d528db522f52d9d75f2aec712688dd31d1d2). This Host profile installs no MIDI
// output driver, so every handle/device request fails with the documented
// no-device error instead of fabricating a successful stream.
const MMSYSERR_BADDEVICEID: u32 = 2;
const MMSYSERR_INVALHANDLE: u32 = 5;
const MMSYSERR_NOTSUPPORTED: u32 = 8;

#[win32_derive::dllexport]
pub fn midiOutPrepareHeader(_machine: &mut Machine, hMidiOut: u32, lpMidiOutHdr: u32, cbMidiOutHdr: u32) -> u32 {
    let _ = (hMidiOut, lpMidiOutHdr, cbMidiOutHdr);
    MMSYSERR_INVALHANDLE
}
#[win32_derive::dllexport]
pub fn midiOutUnprepareHeader(_machine: &mut Machine, hMidiOut: u32, lpMidiOutHdr: u32, cbMidiOutHdr: u32) -> u32 {
    let _ = (hMidiOut, lpMidiOutHdr, cbMidiOutHdr);
    MMSYSERR_INVALHANDLE
}
#[win32_derive::dllexport]
pub fn midiOutReset(_machine: &mut Machine, hMidiOut: u32) -> u32 {
    let _ = hMidiOut;
    MMSYSERR_INVALHANDLE
}
#[win32_derive::dllexport]
pub fn midiStreamOpen(_machine: &mut Machine, lphMidiStrm: u32, lpuDeviceID: u32, cMidi: u32, dwCallback: u32, dwInstance: u32, fdwOpen: u32) -> u32 {
    let _ = (lphMidiStrm, lpuDeviceID, cMidi, dwCallback, dwInstance, fdwOpen);
    MMSYSERR_BADDEVICEID
}
#[win32_derive::dllexport]
pub fn midiStreamClose(_machine: &mut Machine, hMidiStrm: u32) -> u32 { let _ = hMidiStrm; MMSYSERR_INVALHANDLE }
#[win32_derive::dllexport]
pub fn midiStreamOut(_machine: &mut Machine, hMidiStrm: u32, lpMidiHdr: u32, cbMidiHdr: u32) -> u32 { let _ = (hMidiStrm, lpMidiHdr, cbMidiHdr); MMSYSERR_INVALHANDLE }
#[win32_derive::dllexport]
pub fn midiStreamPause(_machine: &mut Machine, hMidiStrm: u32) -> u32 { let _ = hMidiStrm; MMSYSERR_INVALHANDLE }
#[win32_derive::dllexport]
pub fn midiStreamRestart(_machine: &mut Machine, hMidiStrm: u32) -> u32 { let _ = hMidiStrm; MMSYSERR_INVALHANDLE }
#[win32_derive::dllexport]
pub fn midiStreamProperty(_machine: &mut Machine, hMidiStrm: u32, lppropdata: u32, dwProperty: u32) -> u32 { let _ = (hMidiStrm, lppropdata, dwProperty); MMSYSERR_NOTSUPPORTED }
