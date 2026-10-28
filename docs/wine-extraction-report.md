# Wine extraction and adaptation report

Wine commit: `0738d528db522f52d9d75f2aec712688dd31d1d2`; acquired 2026-10-28 from https://github.com/wine-mirror/wine.

License: **LGPL-2.1-or-later**, Copyright 1993, 1994, 1996 Alexandre Julliard. LICENSE.Wine is an exact copy of COPYING.LIB.

Original dialog.c SHA-256: `cc1f6752bdb875e98a30b3f77acd73e42688740653ea8a574686612e89f42268`.

## Extracted lexical same-file closure

| Function | dialog.c lines | Direct calls |
|---|---|---|
| CreateDialogParamA | 719–728 | CreateDialogIndirectParamA, FindResourceA, LoadResource |
| CreateDialogIndirectParamA | 759–763 | CreateDialogIndirectParamAorW |
| CreateDialogIndirectParamAorW | 749–754 | DIALOG_CreateIndirect |
| DIALOG_CreateIndirect | 443–713 | AdjustWindowRectEx, ClientToScreen, CreateFontIndirectW, CreateFontW, CreateWindowExA, CreateWindowExW, DIALOG_CreateControls32, DIALOG_ParseTemplate32, DIALOG_get_info, DeleteObject, GdiGetCharDimensions, GetActiveWindow, GetCapture, GetCursorPos, GetDesktopWindow, GetDeviceCaps, GetDialogBaseUnits, GetMonitorInfoW, GetNextDlgGroupItem, GetNextDlgTabItem, GetParent, GetProcessHeap, GetSystemMetrics, GetWindowLongW, HIWORD, HeapAlloc, HeapFree, IS_INTRESOURCE, IsWindow, IsWindowEnabled, LOWORD, LoadMenuW, MonitorFromPoint, MonitorFromRect, MonitorFromWindow, MulDiv, NtUserDestroyMenu, NtUserDestroyWindow, NtUserEnableWindow, NtUserGetDC, NtUserReleaseDC, NtUserSetFocus, NtUserSetWindowContextHelpId, NtUserShowWindow, SelectObject, SendMessageW, SetRect, SetWindowLongPtrA, SetWindowLongPtrW, SystemParametersInfoW, TRACE, UpdateWindow, WideCharToMultiByte |
| DIALOG_CreateControls32 | 191–301 | CreateWindowExA, CreateWindowExW, DIALOG_GetControl32, DIALOG_get_info, GetProcessHeap, GetWindowLongPtrA, HeapAlloc, HeapFree, IS_INTRESOURCE, MulDiv, PtrToUlong, SendMessageW, SetLastError, TRACE, WARN, WideCharToMultiByte, debugstr_w |
| DIALOG_ParseTemplate32 | 310–432 | GET_DWORD, GET_WORD, LOBYTE, LOWORD, MAKEINTRESOURCEW, TRACE, debugstr_w, lstrlenW |
| GetDialogBaseUnits | 1498–1501 | NtUserGetDialogBaseUnits |
| GetNextDlgGroupItem | 1528–1627 | GetParent, GetWindow, GetWindowLongW, IsChild, WIN_GetFullHandle |
| GetNextDlgTabItem | 1696–1712 | DIALOG_GetNextTabItem, WIN_GetFullHandle |
| DIALOG_GetControl32 | 87–183 | ERR, GET_DWORD, GET_LONG, GET_WORD, MAKEINTRESOURCEW, TRACE, TRACE_ON, debugstr_w, lstrlenW |
| DIALOG_GetNextTabItem | 1635–1691 | DIALOG_GetNextTabItem, GetParent, GetWindow, GetWindowLongA, IsChild |

## External/macro boundaries — NOT a complete semantic transitive extraction

AdjustWindowRectEx, ClientToScreen, CreateFontIndirectW, CreateFontW, CreateWindowExA, CreateWindowExW, DIALOG_get_info, DeleteObject, ERR, FindResourceA, GET_DWORD, GET_LONG, GET_WORD, GdiGetCharDimensions, GetActiveWindow, GetCapture, GetCursorPos, GetDesktopWindow, GetDeviceCaps, GetMonitorInfoW, GetParent, GetProcessHeap, GetSystemMetrics, GetWindow, GetWindowLongA, GetWindowLongPtrA, GetWindowLongW, HIWORD, HeapAlloc, HeapFree, IS_INTRESOURCE, IsChild, IsWindow, IsWindowEnabled, LOBYTE, LOWORD, LoadMenuW, LoadResource, MAKEINTRESOURCEW, MonitorFromPoint, MonitorFromRect, MonitorFromWindow, MulDiv, NtUserDestroyMenu, NtUserDestroyWindow, NtUserEnableWindow, NtUserGetDC, NtUserGetDialogBaseUnits, NtUserReleaseDC, NtUserSetFocus, NtUserSetWindowContextHelpId, NtUserShowWindow, PtrToUlong, SelectObject, SendMessageW, SetLastError, SetRect, SetWindowLongPtrA, SetWindowLongPtrW, SystemParametersInfoW, TRACE, TRACE_ON, UpdateWindow, WARN, WIN_GetFullHandle, WideCharToMultiByte, debugstr_w, lstrlenW

The original complete dialog.c and COPYING.LIB are retained in artifacts/wine-extraction. Static direct-call analysis cannot resolve macro expansion, callback targets, Wine server protocols or drivers. The requested complete transitive Wine dependency port is **not complete**. No unsupported boundary is silently marked adapted.

## Reviewed Rust subset

- `dialog_template.rs`: DIALOG_ParseTemplate32/DIALOG_GetControl32 layouts, DWORD alignment, ordinals, UTF-16 strings, normal/extended headers; safe bounded cursor instead of C pointer arithmetic.
- `dialog_helpers.rs`: CreateDialogParamA/indirect, subset DIALOG_CreateIndirect/CreateControls32; local HWND creation and guest DLGPROC callback; WM_INITDIALOG, basic tab focus, text/check/command helpers.
- Structs mapped to owned Template/Item/Name and per-HWND DialogInfo, not casts of packed guest DLGTEMPLATE/DLGITEMTEMPLATE; DLGPROC is a guest address.
- Manual review: signed 16-bit coordinates, 32-bit IDs for extended templates, callback borrow release across await, partial-child cleanup, checked pointers, TEB errors and logging reviewed. Source headers include pinned SHA and original copyright.
- Driver/server/window creation uses existing retrowin32/Canvas; not a translation of NtUserCreateWindowEx/wine_server_call or the complete USER_Driver stack.
- GDI font choice is a logged fixed 8x8 fallback; menus/custom dialog classes/ordinal images/creation data return unsupported. Full Unicode W, dialog result rules, modal lifetime, nested tab groups/Shift+Tab remain incomplete.

## Validation state

Source acquired and verified. Same-file closure extracted. Manual Rust subset integrated. No automatic C→Rust translation claimed; translation script emits review inventory. New authored PE assertions cover indirect creation, WM_INITDIALOG param/focus/IDs, text, click notification, Tab/Enter routing, destruction and missing/NULL templates.

**Remote compile and DOOM95 execution pending for this new candidate.** Historical five-PE/controls results are not reused as proof. Stable is not promoted.

See [porting guide](wine-porting-guide.md) and [attribution](../vendor/ATTRIBUTION.md).

## Primeiro resultado remoto: 40749913520

Fonte Porthole `5eda61b7b03d8786b66be45cfdf2dabd1ea694b9`:
https://github.com/710862-beep/porthole/actions/runs/40749913520

- Build Rust/Wasm PASS; cinco PEs PASS.
- DOOM95 resolveu a API e começou criação real do launcher (RT_DIALOG em
  297884..300556). 14 presents/11 mudanças; exit 0 após falha de criação do filho
  `msctls_updown32`. **Não gameplay**, workflow vermelho e promoção bloqueada.
- Controles chegaram às novas asserções, mas o teste de recurso inexistente
  encontrou panic no parser PE preexistente quando .rsrc era vazio. Correção:
  leitura bounds-checked e erros None, com regressões de seção ausente/truncada e
  contagem maliciosa. Este run não valida o fixture completo de diálogos.
- Próxima dependência causal: classe comctl32 `msctls_updown32`, código em
  `dlls/comctl32/updown.c`, Copyright 1997, 2002 Dimitrie O. Paun,
  LGPL-2.1-or-later no mesmo SHA Wine. Extração adicional em
  `wine-updown-extraction.json`; código original/corpus preservados em artifacts.
- Subset manual adaptado: estado por HWND, range invertido/32-bit, posição,
  buddy edit/base 10/16, ação por seta/click com NM_UPDOWN guest mutável e
  notificação scroll, raster básico. Não equivale ao controle completo:
  faltam timers, aceleração, subclassing, acessibilidade/tema e agrupamento local.
- Novo candidato exige outro CI; não reutilizar o primeiro como prova de correção.
