//! Wine winmm/joystick.c:408-470 (LGPL-2.1-or-later, SHA
//! 0738d528db522f52d9d75f2aec712688dd31d1d2). No DirectInput joystick is
//! installed in this Host profile; report zero devices and JOYERR_PARMS.
#![allow(non_snake_case)]
use crate::Machine;
const TRACE_CONTEXT: &str = "winmm/joystick";
const JOYERR_PARMS: u32 = 165;
#[win32_derive::dllexport]
pub fn joyGetNumDevs(_machine: &mut Machine) -> u32 { 0 }
#[win32_derive::dllexport]
pub fn joyGetDevCapsA(_machine: &mut Machine, uJoyID: u32, pjc: u32, cbjc: u32) -> u32 { let _ = (uJoyID, pjc, cbjc); JOYERR_PARMS }
#[win32_derive::dllexport]
pub fn joyGetPosEx(_machine: &mut Machine, uJoyID: u32, pji: u32) -> u32 { let _ = (uJoyID, pji); JOYERR_PARMS }
