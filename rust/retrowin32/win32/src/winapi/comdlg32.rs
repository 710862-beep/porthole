//! Common dialog exports. This Host profile has no interactive file-picker UI;
//! the dialogs fail with CDERR_DIALOGFAILURE instead of fabricating a selection.
#![allow(non_snake_case)]
use crate::Machine;
const TRACE_CONTEXT: &str = "comdlg32";
const CDERR_DIALOGFAILURE: u32 = 0xFFFF;
#[win32_derive::dllexport]
pub fn GetOpenFileNameA(machine: &mut Machine, lpofn: u32) -> bool { let _ = lpofn; crate::winapi::kernel32::teb_mut(machine).LastErrorValue = CDERR_DIALOGFAILURE; false }
#[win32_derive::dllexport]
pub fn GetSaveFileNameA(machine: &mut Machine, lpofn: u32) -> bool { let _ = lpofn; crate::winapi::kernel32::teb_mut(machine).LastErrorValue = CDERR_DIALOGFAILURE; false }
#[win32_derive::dllexport]
pub fn CommDlgExtendedError(machine: &mut Machine) -> u32 { crate::winapi::kernel32::teb_mut(machine).LastErrorValue }
