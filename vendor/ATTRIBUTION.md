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
