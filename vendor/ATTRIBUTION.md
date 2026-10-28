# Third-party attribution

## Wine-derived dialog subset (LGPL-2.1-or-later)

Source: https://github.com/wine-mirror/wine
Pinned commit: `0738d528db522f52d9d75f2aec712688dd31d1d2`.
Original: `dlls/user32/dialog.c`, Copyright 1993, 1994, 1996 Alexandre Julliard.
License: GNU Lesser General Public License, version 2.1 or (at your option) any later version; full text in `LICENSE.Wine`.

Derived Rust files: `rust/retrowin32/win32/src/winapi/user32/dialog_template.rs`
and `dialog_helpers.rs`. Changes: bounds-checked byte parsing, Rust-owned state,
local HWND/Canvas integration, x86 guest callbacks. This is a partial adaptation,
not Wine user32 or the entire Wine dependency graph running in WebAssembly.
Other original contributors and notices remain in the upstream source downloaded
by `scripts/fetch-wine-source.mjs`; extraction artifacts retain the whole source
file and license, not just attribution-stripped snippets.

Do not relabel these derived files Apache-2.0. The surrounding retrowin32 sources
retain their existing licenses. Source, Cargo.lock, build scripts, pinned upstream
source acquisition and modification notes are provided to permit rebuilding the
candidate with modified library code. No restriction on reverse engineering for
debugging modifications to the LGPL library is imposed. Binary distributors must
satisfy applicable LGPL source/relinking and notice requirements; a repository
link alone is not asserted to satisfy every distribution scenario.

No stable runtime promotion is authorized by acquisition or extraction.

### Wine-derived updown subset

`user32/updown.rs` derives from `dlls/comctl32/updown.c` at the same pinned SHA,
Copyright 1997, 2002 Dimitrie O. Paun, LGPL-2.1-or-later. It implements bounded
range/position/base/buddy messages and a basic arrow action/guest notification,
not themes, full buddy subclassing, timers or locale grouping.

### Wine-derived virtual environment and user name

The GetUserNameA/W section in `win32/src/winapi/advapi32.rs` derives from
`dlls/advapi32/advapi.c:45-71`, Copyright 1995 Sven Verdoolaege.
`win32/src/winapi/kernel32/env.rs` derives from the environment functions in
`dlls/kernelbase/process.c`, Copyright 1996, 1998 Alexandre Julliard.
Both are LGPL-2.1-or-later at the same pinned Wine SHA. NT process environment
queries become a per-emulated-process map and owned guest heap blocks. The
configured initial virtual account is **Porthole**, not a claim about the host
user. Generic ANSI environment encoding is partial (ASCII arguments/Latin-1
output); the Unicode paths operate on UTF-16. Other registry code in advapi32.rs
retains its prior licensing; the derived identity section is explicitly marked.

### Wine-derived WideCharToMultiByte subset

The marked section in kernel32/nls.rs derives from `dlls/kernelbase/locale.c`
at the pinned SHA: Copyright 1995 Martin von Loewis; 1998 David Lee Lambert;
2000 Julio César Gázquez; 2003 Jon Griffiths; 2005 Dmitry Timoshkov;
2002, 2019 Alexandre Julliard, LGPL-2.1-or-later. Parameter/flag validation and
CP1252/UTF8 behavior are adapted to checked guest buffers and Rust conversion.
Full codepage/best-fit/composition tables are not ported. The native export ABI
has all eight Win32 arguments, including default-character and used-default
pointers; the earlier upstream declaration omitted one parameter.

### Wine-derived directory API subset

The marked section in kernel32/file.rs derives from Wine
`dlls/kernelbase/file.c:1732-1756,2964-2984`, Copyright 1993 John Burton;
1996, 2004 Alexandre Julliard; 2008 Jeff Zaroyko, LGPL-2.1-or-later.
Nt/Rtl current-directory access becomes a local authorized VFS host operation
shared by relative file opens/stat and GetCurrentDirectoryA. No host OS chdir,
UNC/device paths, or independent per-drive current directories are implemented.

### Wine-derived file time / local bias subset

The marked section in kernel32/time.rs adapts
`dlls/kernelbase/file.c:4150-4153` and `dlls/ntdll/time.c:217-252`, under the
same pinned Wine SHA and LGPL-2.1-or-later. The former file's copyrights are
listed above; ntdll/time.c lists Copyright 2002 Rex Jolliff (RtlTimeFields portions adapted from ReactOS
with special permission), 1999 Juergen Schmied and 2007 Dmitry Timoshkov (see original header in pinned source). Current UTC offset
comes from the existing host clock, replacing the NT shared time-of-day query;
this is not a no-op UTC-copy stub or a historical timezone database port.

### Wine-derived window enabling

EnableWindow/IsWindowEnabled marked section in `user32/window.rs` adapts Wine
`dlls/win32u/window.c:1133-1171,1189-1198` at the pinned SHA, LGPL-2.1-or-later,
Copyright 1993, 1994 Alexandre Julliard. Server style updates are per-process
window-table updates; WM_CANCELMODE/WM_ENABLE still reach guest wndprocs.
Accessibility WinEvents/server/multi-thread window ownership are not ported.

### Wine-derived cooperative mutex objects

`kernel32/mutex.rs` and mutex portions of sync/misc/init adapt Wine
`dlls/kernelbase/sync.c:702-760,782-785` and `server/mutex.c:85-140,185-198`,
Copyright 1998 Alexandre Julliard, LGPL-2.1-or-later, pinned SHA above.
`dlls/ntdll/unix/sync.c` was read as the NT/server boundary reference, not
translated as Linux syscalls. Kernel object storage is per-Machine; real guest
CPU/thread IDs, recursion, shared named objects, owned-object references,
ReleaseMutex errors and abandonment feed the existing cooperative waits.
Security descriptors/access masks, global cross-process objects and NT futex
fast paths are not ported.

### Wine-derived DirectPlay provider metadata enumeration

`winapi/dplay.rs` adapts `dlls/dplayx/dplay.c:4952-5131,6540-6601`,
Copyright 1998,1999,2000,2001 Peter Hunnisett, LGPL-2.1-or-later at the pinned SHA.
Root callback edges DP_InitConnections/DP_ReadConnections are included explicitly
in extraction (not discoverable merely by regex call syntax). GUIDs, names,
versions and stop/continue callbacks come from registry metadata; no network
session object or functional transport is manufactured. DirectPlayCreate fails
with DPERR_UNAVAILABLE and clears its checked output. This is not full DirectPlay.

### Wine-derived combo insertion/search subset

Marked controls.rs message cases adapt `dlls/user32/combo.c:1930-1980` and
`dlls/user32/listbox.c:1019-1080,1689+`, Copyright 1997 Alex Korobka and
Copyright 1996 Alexandre Julliard respectively, LGPL-2.1-or-later. Vector-backed
string items replace LB storage; ASCII-case prefix/exact search, insertion and
selection are supported. Locale collation, directory-prefix special cases and
owner-draw item-data comparisons remain unsupported.

IsWindowVisible additionally adapts Wine `win32u/window.c:1075-1091` (same
Copyright 1993, 1994 Alexandre Julliard/LGPL), traversing only real parents, not
top-level owners. Item-data messages use `listbox.c:2776-2792` and the combo
forwarding at `combo.c:2063-2066`, preserving opaque x86 DWORD data and Wine's
undocumented TRUE return from LB_SETITEMDATA, not a fabricated pointer/value.

### Wine-derived normal window placement subset

`user32/placement.rs` adapts `dlls/win32u/window.c:3172-3186,3317-3333` and
`set_window_placement` helpers, Copyright 1993, 1994 Alexandre Julliard,
LGPL-2.1-or-later. A 44-byte x86 WINDOWPLACEMENT is checked/copied; a single
virtual work area replaces monitor/server queries. Normal position/size and
visibility reach real Host DOM methods; guest MOVE/SIZE/SHOWWINDOW callbacks
remain real. Min/max/DPI/taskbar/asynchronous placement explicitly unsupported.

### Wine-derived MIDI capability query, no-driver profile

`winmm/midi.rs` adapts `dlls/winmm/winmm.c:287-290` →
`dlls/winmm/lolvldrv.c:75-82`, Copyright 1993 Martin Ayotte and 1998-2002
Eric Pouech, LGPL-2.1-or-later. Driver device count comes from the Host profile;
this build installs **zero** WinMM MIDI drivers, consistent with disabled wave
output. This is a truthful no-device configuration, not working MIDI/music,
not host hardware enumeration and not a successful midiOutOpen emulation.

midiOutSetVolume additionally follows Wine `winmm.c:571-581` under the same
copyright/license, dispatching to the no-driver Host profile and returning
MMSYSERR_INVALHANDLE rather than claiming successful volume/playback.

### SYSTEM_INFO mapping

`kernel32/sysinfo.rs`: Wine `dlls/kernelbase/memory.c:158-203,237-252`, SHA
0738d528db522f52d9d75f2aec712688dd31d1d2, Copyright 1997 Alexandre Julliard,
LGPL-2.1-or-later. NT hardware queries replaced with documented virtual Win32
x86 single-vCPU ABI profile. This is not physical host hardware enumeration.
