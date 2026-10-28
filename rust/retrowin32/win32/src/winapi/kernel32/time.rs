use super::{set_last_error, FILETIME};
use crate::{winapi::ERROR, Machine};
use chrono::{Datelike, Timelike};
use memory::{Extensions, ExtensionsMut, Pod};

const TRACE_CONTEXT: &'static str = "kernel32/time";

#[win32_derive::dllexport]
pub fn GetTickCount(machine: &mut Machine) -> u32 {
    machine.host.ticks()
}

// The number of "counts" per second, where counts are the units returned by
// QueryPerformanceCounter.  On my Windows machine this value was 10m, which
// is to say a count is 0.1us.
const QUERY_PERFORMANCE_FREQ: u32 = 10_000_000;

// In principle we could just use an i64 here, but when Windows passes one of these via
// the stack it may align it on a 4-byte address when Rust requires 8-byte alignment for
// 64-bit addresses.  So instead we more closely match the Windows behavior.
#[repr(C)]
#[derive(Debug)]
pub struct LARGE_INTEGER {
    LowPart: u32,
    HighPart: i32,
}
unsafe impl memory::Pod for LARGE_INTEGER {}

#[win32_derive::dllexport]
pub fn QueryPerformanceCounter(
    machine: &mut Machine,
    lpPerformanceCount: Option<&mut LARGE_INTEGER>,
) -> bool {
    let counter = lpPerformanceCount.unwrap();
    let ms = machine.host.ticks();
    let counts = ms as u64 * (QUERY_PERFORMANCE_FREQ as u64 / 1000);
    counter.LowPart = counts as u32;
    counter.HighPart = (counts >> 32) as u32 as i32;
    true // success
}

#[win32_derive::dllexport]
pub fn QueryPerformanceFrequency(machine: &mut Machine, lpFrequency: u32) -> bool {
    // 64-bit write
    machine
        .mem()
        .put_pod::<u32>(lpFrequency, QUERY_PERFORMANCE_FREQ);
    machine.mem().put_pod::<u32>(lpFrequency + 4, 0);
    true
}

#[win32_derive::dllexport]
pub fn GetSystemTimeAsFileTime(
    machine: &mut Machine,
    lpSystemTimeAsFileTime: Option<&mut FILETIME>,
) -> u32 {
    let date_time = machine.host.system_time().to_utc();
    if let Some(time) = lpSystemTimeAsFileTime {
        let Some(nanos) = date_time.timestamp_nanos_opt() else {
            log::warn!("GetSystemTimeAsFileTime: timestamp_nanos_opt failed");
            *time = FILETIME::zeroed();
            return 0;
        };
        *time = FILETIME::from_unix_nanos(nanos);
    }
    0
}

#[win32_derive::dllexport]
pub fn GetSystemTime(machine: &mut Machine, lpSystemTime: Option<&mut SYSTEMTIME>) -> u32 {
    let date_time = machine.host.system_time().naive_utc();
    if let Some(time) = lpSystemTime {
        *time = SYSTEMTIME::from_chrono(&date_time);
    }
    0
}

#[win32_derive::dllexport]
pub fn GetLocalTime(machine: &mut Machine, lpSystemTime: Option<&mut SYSTEMTIME>) -> u32 {
    let date_time = machine.host.system_time();
    if let Some(time) = lpSystemTime {
        *time = SYSTEMTIME::from_chrono(&date_time);
    }
    0
}

#[win32_derive::dllexport]
pub fn SystemTimeToFileTime(
    machine: &mut Machine,
    lpSystemTime: Option<&SYSTEMTIME>,
    lpFileTime: Option<&mut FILETIME>,
) -> bool {
    let Some(lpSystemTime) = lpSystemTime else {
        log::warn!("SystemTimeToFileTime: lpSystemTime is null");
        set_last_error(machine, ERROR::INVALID_DATA);
        return false;
    };
    let date_time = match chrono::NaiveDate::from_ymd_opt(
        lpSystemTime.wYear as i32,
        lpSystemTime.wMonth as u32,
        lpSystemTime.wDay as u32,
    )
    .and_then(|dt| {
        dt.and_hms_milli_opt(
            lpSystemTime.wHour as u32,
            lpSystemTime.wMinute as u32,
            lpSystemTime.wSecond as u32,
            lpSystemTime.wMilliseconds as u32,
        )
    }) {
        Some(dt) => dt.and_utc(),
        None => {
            log::warn!("SystemTimeToFileTime: invalid SYSTEMTIME");
            set_last_error(machine, ERROR::INVALID_DATA);
            return false;
        }
    };
    if let Some(time) = lpFileTime {
        let Some(nanos) = date_time.timestamp_nanos_opt() else {
            log::warn!("SystemTimeToFileTime: timestamp_nanos_opt failed");
            *time = FILETIME::zeroed();
            return false;
        };
        *time = FILETIME::from_unix_nanos(nanos);
    }
    true
}

#[win32_derive::dllexport]
pub fn FileTimeToSystemTime(
    machine: &mut Machine,
    lpFileTime: Option<&FILETIME>,
    lpSystemTime: Option<&mut SYSTEMTIME>,
) -> bool {
    let Some(lpFileTime) = lpFileTime else {
        log::warn!("FileTimeToSystemTime: lpFileTime is null");
        set_last_error(machine, ERROR::INVALID_DATA);
        return false;
    };
    // Avoid i64 nanoseconds overflow for the 1601 epoch / far future FILETIMEs.
    let value=lpFileTime.to_u64();
    if value>i64::MAX as u64{set_last_error(machine,ERROR::INVALID_PARAMETER);return false}
    let seconds=(value/10_000_000)as i64-11_644_473_600;
    let Some(date_time)=chrono::DateTime::from_timestamp(seconds,((value%10_000_000)*100)as u32)else{set_last_error(machine,ERROR::INVALID_PARAMETER);return false};
    if let Some(time) = lpSystemTime {
        *time = SYSTEMTIME::from_chrono(&date_time);
    }
    true
}

#[win32_derive::dllexport]
pub async fn Sleep(machine: &mut Machine, dwMilliseconds: u32) -> u32 {
    if dwMilliseconds == 0 {
        return 0;
    }

    #[cfg(feature = "x86-emu")]
    {
        let until = machine.host.ticks().wrapping_add(dwMilliseconds);
        machine.emu.x86.cpu_mut().block(Some(until)).await;
    }

    #[cfg(not(feature = "x86-emu"))]
    {
        _ = machine;
        log::warn!("TODO: sleep");
    }
    0
}

#[repr(C)]
#[derive(Debug)]
pub struct SYSTEMTIME {
    wYear: u16,
    wMonth: u16,
    wDayOfWeek: u16,
    wDay: u16,
    wHour: u16,
    wMinute: u16,
    wSecond: u16,
    wMilliseconds: u16,
}
impl SYSTEMTIME {
    pub fn from_chrono<T>(dt: &T) -> Self
    where
        T: Datelike + Timelike,
    {
        Self {
            wYear: dt.year() as u16,
            wMonth: dt.month() as u16,
            wDayOfWeek: dt.weekday().num_days_from_sunday() as u16,
            wDay: dt.day() as u16,
            wHour: dt.hour() as u16,
            wMinute: dt.minute() as u16,
            wSecond: dt.second() as u16,
            wMilliseconds: (dt.nanosecond() / 1_000_000) as u16,
        }
    }
}
unsafe impl memory::Pod for SYSTEMTIME {}

#[repr(C)]
#[derive(Debug)]
pub struct TIME_ZONE_INFORMATION {
    Bias: u32,
    StandardName: [u16; 32],
    StandardDate: SYSTEMTIME,
    StandardBias: u32,
    DaylightName: [u16; 32],
    DaylightDate: SYSTEMTIME,
    DaylightBias: u32,
}
unsafe impl memory::Pod for TIME_ZONE_INFORMATION {}

#[win32_derive::dllexport]
pub fn GetTimeZoneInformation(
    _machine: &mut Machine,
    lpTimeZoneInformation: Option<&mut TIME_ZONE_INFORMATION>,
) -> u32 {
    const TIME_ZONE_ID_UNKNOWN: u32 = 0;
    // It appears to be legal for all struct members to be zero, especially
    // while TIME_ZONE_ID_UNKNOWN says there's no daylight savings time.
    *lpTimeZoneInformation.unwrap() = TIME_ZONE_INFORMATION::zeroed();
    TIME_ZONE_ID_UNKNOWN
}

/* SPDX-License-Identifier: LGPL-2.1-or-later (this derived section)
 * Wine kernelbase/file.c:4150-4153 and ntdll/time.c:217-227,242-252
 * wine-mirror/wine@0738d528db522f52d9d75f2aec712688dd31d1d2
 * file.c: Copyright 1993 John Burton; 1996, 2004 Alexandre Julliard;
 * 2008 Jeff Zaroyko. ntdll/time.c: Copyright 2002 Rex Jolliff,
 * 1999 Juergen Schmied, 2007 Dmitry Timoshkov. Original ReactOS permission notice
 * for RtlTimeFields portions is retained in corpus; those algorithms are not ported.
 * NtQuerySystemInformation timezone bias -> existing host clock's current UTC
 * offset. Checked guest offsets replace native FILETIME/LARGE_INTEGER pointers.
 * Current bias follows Wine's API behavior, not historical per-date DST rules.
 */
fn local_ticks(ticks:u64,seconds:i32)->u64{ticks.wrapping_add((seconds as i64*10_000_000)as u64)}
fn file_time_bias(machine:&mut Machine,input:u32,output:u32,inverse:bool)->bool{
    let valid={let m=machine.mem();input!=0&&output!=0&&(input as usize).checked_add(8).map_or(false,|e|e<=m.as_slice().len())&&(output as usize).checked_add(8).map_or(false,|e|e<=m.as_slice().len())};
    if !valid{set_last_error(machine,ERROR::INVALID_PARAMETER);return false}
    let value=machine.mem().get_pod::<u64>(input);
    let offset=machine.host.system_time().offset().local_minus_utc();
    machine.mem().put_pod::<u64>(output,local_ticks(value,if inverse{-offset}else{offset}));true
}
#[win32_derive::dllexport]
pub fn FileTimeToLocalFileTime(machine:&mut Machine,lpFileTime:u32,lpLocalFileTime:u32)->bool{file_time_bias(machine,lpFileTime,lpLocalFileTime,false)}
#[win32_derive::dllexport]
pub fn LocalFileTimeToFileTime(machine:&mut Machine,lpLocalFileTime:u32,lpFileTime:u32)->bool{file_time_bias(machine,lpLocalFileTime,lpFileTime,true)}
#[cfg(test)]mod timezone_tests{
 use super::*;
 #[test]fn signed_bias_and_roundtrip(){let t=116_444_736_000_000_000u64;assert_eq!(local_ticks(t,-10800),t-10800*10_000_000);assert_eq!(local_ticks(local_ticks(t,-10800),10800),t);assert_eq!(local_ticks(t,19800),t+19800*10_000_000);}
}
