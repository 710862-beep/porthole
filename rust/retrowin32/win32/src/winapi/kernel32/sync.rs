//! Porthole cooperative guest waits. These functions are exported to the PE
//! loader by win32-derive, NOT synchronous JS promises or standalone Wasm exports.
use crate::{winapi::types::HEVENT, Machine};
use memory::Extensions;

const TRACE_CONTEXT: &'static str = "kernel32/sync";
const WAIT_TIMEOUT: u32 = 258;
const WAIT_FAILED: u32 = 0xffff_ffff;

pub struct EventObject {
    state: bool,
    manual: bool,
}

fn fail(machine: &mut Machine, error: u32) -> u32 {
    super::teb_mut(machine).LastErrorValue = error;
    WAIT_FAILED
}

fn ready(machine: &Machine, handle: u32) -> Option<bool> {
    #[cfg(feature = "x86-emu")]
    {
        let index = if handle == 0xffff_fffe {
            Some(machine.emu.x86.cur_cpu)
        } else { machine.state.kernel32.thread_handles.get(&handle).copied() };
        if let Some(index) = index {
            return machine.emu.x86.cpus.get(index)
                .map(|cpu| matches!(cpu.state, x86::CPUState::Terminated(_)));
        }
    }
    if let Some(ready)=machine.state.kernel32.mutexes.ready(handle,super::mutex_tid(machine)){return Some(ready)}
    machine.state.kernel32.event_handles.get(HEVENT::from_raw(handle)).map(|e| e.state)
}

fn consume(machine: &mut Machine, handle: u32)->bool {
    let tid=super::mutex_tid(machine);
    if machine.state.kernel32.mutexes.ready(handle,tid).is_some(){return machine.state.kernel32.mutexes.acquire(handle,tid)}
    if let Some(event) = machine.state.kernel32.event_handles.get_mut(HEVENT::from_raw(handle)) {
        if !event.manual { event.state = false; }
    }
    false
}

async fn wait(machine: &mut Machine, handles: Vec<u32>, all: bool, timeout: u32) -> u32 {
    #[cfg(not(feature = "x86-emu"))]
    { let _ = (handles, all, timeout); return fail(machine, 50); }
    #[cfg(feature = "x86-emu")]
    {
        log::debug!("Porthole wait count={} all={} timeout={}", handles.len(), all, timeout);
        let start = machine.host.ticks();
        loop {
            super::refresh_mutexes(machine);
            let states: Option<Vec<bool>> = handles.iter().map(|h| ready(machine, *h)).collect();
            let states = match states { Some(s) => s, None => return fail(machine, 6) };
            if all && states.iter().all(|s| *s) {
                let mut abandoned=false;for handle in &handles {abandoned|=consume(machine,*handle);}
                return if abandoned{0x80}else{0};
            }
            if !all {
                if let Some(index) = states.iter().position(|s| *s) {
                    let abandoned=consume(machine, handles[index]);
                    return index as u32+if abandoned{0x80}else{0};
                }
            }
            // One deadline for the entire wait, including wait-all. Readiness
            // and consumption happen atomically in this cooperative CPU turn.
            if timeout != 0xffff_ffff && machine.host.ticks().wrapping_sub(start) >= timeout {
                return WAIT_TIMEOUT;
            }
            super::Sleep(machine, 1).await;
        }
    }
}

#[win32_derive::dllexport]
pub async fn WaitForSingleObject(machine: &mut Machine, hHandle: HEVENT, dwMilliseconds: u32) -> u32 {
    wait(machine, vec![hHandle.to_raw()], false, dwMilliseconds).await
}

#[win32_derive::dllexport]
pub async fn WaitForMultipleObjects(machine: &mut Machine, nCount: u32, lpHandles: u32, bWaitAll: bool, dwMilliseconds: u32) -> u32 {
    if nCount == 0 || nCount > 64 || lpHandles == 0 {
        return fail(machine, 87);
    }
    let size = nCount * 4;
    let memory = machine.mem();
    if lpHandles.checked_add(size).map_or(true, |end| end as usize > memory.as_slice().len()) {
        return fail(machine, 87);
    }
    let handles: Vec<u32> = (0..nCount).map(|i| memory.get_pod::<u32>(lpHandles + i * 4)).collect();
    let unique: std::collections::HashSet<u32> = handles.iter().copied().collect();
    if unique.len() != handles.len() { return fail(machine, 87); }
    wait(machine, handles, bWaitAll, dwMilliseconds).await
}

#[win32_derive::dllexport]
pub fn CreateEventA(machine: &mut Machine, lpEventAttributes: u32, bManualReset: bool, bInitialState: bool, lpName: Option<&str>) -> HEVENT {
    if lpEventAttributes != 0 || lpName.is_some() {
        fail(machine, 50);
        return HEVENT::null();
    }
    machine.state.kernel32.event_handles.add(EventObject { state: bInitialState, manual: bManualReset })
}

#[win32_derive::dllexport]
pub fn SetEvent(machine: &mut Machine, hEvent: HEVENT) -> bool {
    match machine.state.kernel32.event_handles.get_mut(hEvent) {
        Some(event) => { event.state = true; true }
        None => { fail(machine, 6); false }
    }
}

#[win32_derive::dllexport]
pub fn ResetEvent(machine: &mut Machine, hEvent: HEVENT) -> bool {
    match machine.state.kernel32.event_handles.get_mut(hEvent) {
        Some(event) => { event.state = false; true }
        None => { fail(machine, 6); false }
    }
}
