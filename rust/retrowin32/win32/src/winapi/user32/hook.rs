//! Thread-local Win32 message hooks (WH_KEYBOARD/WH_MOUSE subset).
//! Hooks are real guest callbacks; unsupported global/low-level hooks fail.
#![allow(non_snake_case)]
use crate::Machine;
use super::message::MSG;

const TRACE_CONTEXT: &str = "user32/hook";
const WH_KEYBOARD: i32 = 2;
const WH_MOUSE: i32 = 3;
const HC_ACTION: u32 = 0;

#[derive(Clone)]
pub struct Hook {
    pub handle: u32,
    pub id: i32,
    pub proc: u32,
    pub thread: u32,
}

fn thread_id(machine: &Machine) -> u32 {
    #[cfg(feature = "x86-emu")]
    { machine.emu.x86.cur_cpu as u32 + 1 }
    #[cfg(not(feature = "x86-emu"))]
    { let _ = machine; 1 }
}

fn error(machine: &mut Machine, code: u32) -> u32 {
    crate::winapi::kernel32::teb_mut(machine).LastErrorValue = code;
    0
}

#[win32_derive::dllexport]
pub fn SetWindowsHookExA(machine: &mut Machine, idHook: i32, lpfn: u32, hmod: u32, dwThreadId: u32) -> u32 {
    if (idHook != WH_KEYBOARD && idHook != WH_MOUSE) || lpfn == 0 {
        return error(machine, 87);
    }
    let current = thread_id(machine);
    if dwThreadId != current {
        // Global/DLL-injected hooks are not implemented; do not fake success.
        return error(machine, 50);
    }
    let _ = hmod;
    let handle = 0x7000_0000u32 | (machine.state.user32.hooks.len() as u32 + 1);
    machine.state.user32.hooks.push(Hook { handle, id: idHook, proc: lpfn, thread: current });
    handle
}

#[win32_derive::dllexport]
pub fn SetWindowsHookExW(machine: &mut Machine, idHook: i32, lpfn: u32, hmod: u32, dwThreadId: u32) -> u32 {
    SetWindowsHookExA(machine, idHook, lpfn, hmod, dwThreadId)
}

#[win32_derive::dllexport]
pub fn UnhookWindowsHookEx(machine: &mut Machine, hhk: u32) -> bool {
    let before = machine.state.user32.hooks.len();
    machine.state.user32.hooks.retain(|h| h.handle != hhk);
    if machine.state.user32.hooks.len() == before {
        crate::winapi::kernel32::teb_mut(machine).LastErrorValue = 1400;
        return false;
    }
    true
}

fn is_keyboard(msg: u32) -> bool { (0x0100..=0x0108).contains(&msg) }
fn is_mouse(msg: u32) -> bool { (0x0200..=0x020e).contains(&msg) }

/// Invoke the newest matching hook first. A nonzero result swallows the message.
pub async fn filter_message(machine: &mut Machine, msg: &MSG) -> bool {
    let id = if is_keyboard(msg.message) { WH_KEYBOARD }
             else if is_mouse(msg.message) { WH_MOUSE }
             else { return false; };
    let thread = thread_id(machine);
    let first = machine.state.user32.hooks.iter().rev()
        .find(|h| h.id == id && h.thread == thread).map(|h| h.handle);
    let Some(handle) = first else { return false; };
    let result = call_hook(machine, handle, HC_ACTION, msg.wParam, msg.lParam).await;
    result != 0
}

async fn call_hook(machine: &mut Machine, handle: u32, code: u32, wparam: u32, lparam: u32) -> u32 {
    let hook = machine.state.user32.hooks.iter().find(|h| h.handle == handle).cloned();
    let Some(hook) = hook else { return 0; };
    machine.call_x86(hook.proc, vec![code, wparam, lparam]).await
}

#[win32_derive::dllexport]
pub async fn CallNextHookEx(machine: &mut Machine, hhk: u32, nCode: i32, wParam: u32, lParam: u32) -> u32 {
    let hooks = machine.state.user32.hooks.clone();
    let current = hooks.iter().position(|h| h.handle == hhk);
    let next = match current {
        Some(index) => hooks[..index].iter().rev()
            .find(|h| h.id == hooks[index].id && h.thread == hooks[index].thread),
        None => hooks.iter().rev().find(|h| h.thread == thread_id(machine)),
    };
    match next {
        Some(h) => call_hook(machine, h.handle, nCode as u32, wParam, lParam).await,
        None => 0,
    }
}

#[win32_derive::dllexport]
pub async fn CallWindowProcA(machine: &mut Machine, lpPrevWndFunc: u32, hWnd: u32, Msg: u32, wParam: u32, lParam: u32) -> u32 {
    if lpPrevWndFunc == 0 { crate::winapi::kernel32::teb_mut(machine).LastErrorValue = 87; return 0; }
    machine.call_x86(lpPrevWndFunc, vec![hWnd, Msg, wParam, lParam]).await
}

#[win32_derive::dllexport]
pub async fn CallWindowProcW(machine: &mut Machine, lpPrevWndFunc: u32, hWnd: u32, Msg: u32, wParam: u32, lParam: u32) -> u32 {
    CallWindowProcA(machine, lpPrevWndFunc, hWnd, Msg, wParam, lParam).await
}
