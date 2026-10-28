# Wine → Rust/Wasm porting guide

Pinned upstream: see wine-commit.txt. All derived logic retains LGPL-2.1-or-later
and original notices; see LICENSE.Wine and vendor/ATTRIBUTION.md.

1. Inspect actual code, not API examples. CreateDialogParamA loads RT_DIALOG then
   creates indirectly; Wine's LoadResource pointer is NOT retrowin32's resource
   handle. This port consumes the existing checked resource range instead.
2. Preserve Win32 ABI: guest HWND/u32 and LPARAM/WPARAM 32-bit; BOOL is a guest
   integer even when Rust exports use the existing bool argument adapter.
3. Never turn guest addresses into Rust native pointers. Templates use a checked
   LE byte cursor, owned Strings/Vecs and explicit bounds/count limits. Resource
   entry points restrict parsing to resource length; indirect entry points can
   only bound against available guest memory, not prove allocation ownership.
4. DLGPROC remains an x86 guest code address, invoked via call_x86 across await,
   not a native closure/fn pointer. Do not retain mutable HWND borrows over it.
5. C heap strings become owned buffers. Failed child creation destroys the partial
   dialog and children. Resource handles are not leaked by this lookup path.
6. Goto/error cleanup becomes early return + DestroyWindow. Failures set the
   existing TEB error field; public Win32 ABI remains HWND/BOOL, not Rust Result.
7. Unix/server/driver dependencies are not available. Local window creation,
   controls and Canvas replace only the subset explicitly mapped in the report.
8. The fixed 8x8 raster is not Wine font selection. Font fallback is logged;
   menu-bearing templates, custom dialog classes, ordinal image captions and
   nonempty creation data are rejected with ERROR_NOT_SUPPORTED, not invented.
9. Translation tooling emits review inventory only. Lexical extraction is not
   full C parsing or a proof of complete transitive closure (macros/callbacks).
10. Validate parser error cases, guest callback ordering/IDs/text/focus/commands,
    real Canvas controls, five PEs and original DOOM95 in the same candidate CI.
    Only actual test evidence can move INTEGRATED to VALIDATED.

Known remaining scope: modal loops/EndDialog, full DefDlgProc message semantics,
Unicode A/W dispatch, nested control-parent/tab ordering and Shift+Tab, group
navigation, accelerator/mnemonic handling, complete font/menu/context help and
DPI/monitor positioning. These are implementation gaps, not fundamental limits.
