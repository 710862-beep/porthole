use super::*;
use crate::{
    str16::decode_cp1252,
    winapi::{kernel32, stack_args::ArrayWithSizeMut, types::*},
    Machine,
};
use memory::Extensions;

const TRACE_CONTEXT: &'static str = "user32/dialog";

#[win32_derive::dllexport]
pub fn MessageBoxA(
    machine: &mut Machine,
    hWnd: HWND,
    lpText: Option<&str>,
    lpCaption: Option<&str>,
    uType: u32,
) -> u32 {
    machine.host.log(
        format!(
            "MessageBox: {}\n{}",
            lpCaption.unwrap_or("Error"),
            lpText.unwrap_or("")
        )
        .as_bytes(),
    );
    1 // IDOK
}

#[win32_derive::dllexport]
pub fn MessageBoxW(
    machine: &mut Machine,
    hWnd: HWND,
    lpText: Option<&Str16>,
    lpCaption: Option<&Str16>,
    uType: u32,
) -> u32 {
    machine.host.log(
        format!(
            "MessageBox: {}\n{}",
            lpCaption.map(|s| s.to_string()).unwrap_or_else(|| "Error".into()),
            lpText.map(|s| s.to_string()).unwrap_or_default()
        )
        .as_bytes(),
    );
    1 // IDOK
}

fn fail(machine: &mut Machine, code: u32) -> u32 {
    kernel32::teb_mut(machine).LastErrorValue = code;
    u32::MAX
}

/// Runs the nested modal message loop owned by DialogBox*.  The dialog procedure
/// terminates it through EndDialog; WM_CLOSE is translated to IDCANCEL by the
/// dialog dispatcher.  Returns the EndDialog result, or -1 on creation failure.
async fn modal_loop(machine: &mut Machine, hDlg: HWND) -> u32 {
    if let Some(w) = machine.state.user32.windows.get_mut(hDlg) {
        if let Some(d) = w.dialog.as_mut() {
            d.modal = true;
        }
    }
    let _ = ShowWindow(machine, hDlg, Ok(SW::NORMAL)).await;
    loop {
        let ended = machine
            .state
            .user32
            .windows
            .get(hDlg)
            .and_then(|w| w.dialog.as_ref())
            .map_or(true, |d| d.ended);
        if ended {
            break;
        }
        let mut msg = MSG {
            hwnd: HWND::null(),
            message: 0,
            wParam: 0,
            lParam: 0,
            time: 0,
            pt_x: 0,
            pt_y: 0,
        };
        let r = GetMessageA(machine, Some(&mut msg), HWND::null(), 0, 0).await;
        if r <= 0 {
            // A quit posted while the modal loop is active must remain visible to
            // the outer loop after the dialog is destroyed.
            if r == 0 {
                PostQuitMessage(machine, msg.wParam as i32);
            }
            break;
        }
        if IsDialogMessageA(machine, hDlg, Some(&msg)).await {
            continue;
        }
        TranslateMessage(machine, Some(&msg));
        DispatchMessageA(machine, Some(&msg)).await;
    }
    let result = machine
        .state
        .user32
        .windows
        .get(hDlg)
        .and_then(|w| w.dialog.as_ref())
        .map_or(0, |d| d.result);
    DestroyWindow(machine, hDlg);
    result
}

#[win32_derive::dllexport]
pub async fn DialogBoxParamA(
    machine: &mut Machine,
    hInstance: u32,
    lpTemplateName: u32,
    hWndParent: HWND,
    lpDialogFunc: u32,
    dwInitParam: u32,
) -> u32 {
    let hDlg = CreateDialogParamA(
        machine,
        hInstance,
        lpTemplateName,
        hWndParent,
        lpDialogFunc,
        dwInitParam,
    )
    .await;
    if hDlg.is_null() {
        return u32::MAX;
    }
    modal_loop(machine, hDlg).await
}

fn wide_resource_name(machine: &Machine, ptr: u32) -> Result<kernel32::ResourceKey<String16>, u32> {
    if ptr >> 16 == 0 {
        return Ok(kernel32::ResourceKey::Id(ptr));
    }
    let mem = machine.mem();
    let bytes = mem.as_slice().get(ptr as usize..).ok_or(87u32)?;
    let mut units = Vec::new();
    for i in 0..32768 {
        let off = i * 2;
        if off + 2 > bytes.len() {
            return Err(87);
        }
        let u = u16::from_le_bytes([bytes[off], bytes[off + 1]]);
        if u == 0 {
            break;
        }
        units.push(u);
    }
    Ok(kernel32::ResourceKey::Name(String16(units)))
}

async fn dialog_box_from_key(
    machine: &mut Machine,
    hInstance: u32,
    name: kernel32::ResourceKey<String16>,
    hWndParent: HWND,
    lpDialogFunc: u32,
    dwInitParam: u32,
) -> u32 {
    let instance = if hInstance == 0 {
        machine.state.kernel32.image_base
    } else {
        hInstance
    };
    let range = kernel32::find_resource(
        &machine.state.kernel32,
        machine.mem(),
        instance,
        kernel32::ResourceKey::Id(5),
        name.as_ref(),
    );
    let Some(range) = range else {
        return fail(machine, 1814);
    };
    let hDlg = dialog_helpers::indirect(
        machine,
        instance,
        range.start,
        Some(range.len()),
        hWndParent,
        lpDialogFunc,
        dwInitParam,
    )
    .await;
    if hDlg.is_null() {
        return u32::MAX;
    }
    modal_loop(machine, hDlg).await
}

#[win32_derive::dllexport]
pub async fn DialogBoxParamW(
    machine: &mut Machine,
    hInstance: u32,
    lpTemplateName: u32,
    hWndParent: HWND,
    lpDialogFunc: u32,
    dwInitParam: u32,
) -> u32 {
    let name = match wide_resource_name(machine, lpTemplateName) {
        Ok(n) => n,
        Err(e) => return fail(machine, e),
    };
    dialog_box_from_key(
        machine,
        hInstance,
        name,
        hWndParent,
        lpDialogFunc,
        dwInitParam,
    )
    .await
}

#[win32_derive::dllexport]
pub async fn DialogBoxIndirectParamA(
    machine: &mut Machine,
    hInstance: u32,
    hDialogTemplate: u32,
    hWndParent: HWND,
    lpDialogFunc: u32,
    dwInitParam: u32,
) -> u32 {
    let hDlg = dialog_helpers::indirect(
        machine,
        hInstance,
        hDialogTemplate,
        None,
        hWndParent,
        lpDialogFunc,
        dwInitParam,
    )
    .await;
    if hDlg.is_null() {
        return u32::MAX;
    }
    modal_loop(machine, hDlg).await
}

#[win32_derive::dllexport]
pub fn EndDialog(machine: &mut Machine, hDlg: HWND, nResult: u32) -> bool {
    dialog_helpers::end_dialog(machine, hDlg, nResult)
}

fn item_hwnd(machine: &Machine, hDlg: HWND, nIDDlgItem: i32) -> HWND {
    dialog_helpers::GetDlgItem(machine, hDlg, nIDDlgItem)
}

fn cp1252_bytes(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| {
            let u = c as u32;
            if u < 0x80 {
                u as u8
            } else {
                match c {
                    '€' => 0x80,
                    '‚' => 0x82,
                    'ƒ' => 0x83,
                    '„' => 0x84,
                    '…' => 0x85,
                    '†' => 0x86,
                    '‡' => 0x87,
                    'ˆ' => 0x88,
                    '‰' => 0x89,
                    'Š' => 0x8a,
                    '‹' => 0x8b,
                    'Œ' => 0x8c,
                    'Ž' => 0x8e,
                    '‘' => 0x91,
                    '’' => 0x92,
                    '“' => 0x93,
                    '”' => 0x94,
                    '•' => 0x95,
                    '–' => 0x96,
                    '—' => 0x97,
                    '˜' => 0x98,
                    '™' => 0x99,
                    'š' => 0x9a,
                    '›' => 0x9b,
                    'œ' => 0x9c,
                    'ž' => 0x9e,
                    'Ÿ' => 0x9f,
                    _ => {
                        if (0xa0..=0xff).contains(&u) {
                            u as u8
                        } else {
                            b'?'
                        }
                    }
                }
            }
        })
        .collect()
}

fn set_item_text(machine: &mut Machine, hDlg: HWND, nIDDlgItem: i32, text: &str) -> bool {
    let child = item_hwnd(machine, hDlg, nIDDlgItem);
    if child.is_null() {
        kernel32::teb_mut(machine).LastErrorValue = 1400;
        return false;
    }
    let bytes = cp1252_bytes(text);
    if let Some(w) = machine.state.user32.windows.get_mut(child) {
        w.title = text.to_string();
        if let Some(c) = w.control.as_mut() {
            c.text = bytes;
            c.start = c.text.len();
            c.end = c.start;
        }
    }
    super::controls::paint(machine, child);
    true
}

fn item_text(machine: &Machine, hDlg: HWND, nIDDlgItem: i32) -> Option<String> {
    let child = item_hwnd(machine, hDlg, nIDDlgItem);
    if child.is_null() {
        return None;
    }
    let w = machine.state.user32.windows.get(child)?;
    if let Some(c) = w.control.as_ref() {
        Some(decode_cp1252(&c.text))
    } else {
        Some(w.title.clone())
    }
}

#[win32_derive::dllexport]
pub fn SetDlgItemTextW(
    machine: &mut Machine,
    hDlg: HWND,
    nIDDlgItem: i32,
    lpString: Option<&Str16>,
) -> bool {
    let text = lpString.map(|s| s.to_string()).unwrap_or_default();
    set_item_text(machine, hDlg, nIDDlgItem, &text)
}

#[win32_derive::dllexport]
pub fn SetDlgItemInt(
    machine: &mut Machine,
    hDlg: HWND,
    nIDDlgItem: i32,
    uValue: u32,
    bSigned: bool,
) -> bool {
    let text = if bSigned {
        format!("{}", uValue as i32)
    } else {
        format!("{}", uValue)
    };
    set_item_text(machine, hDlg, nIDDlgItem, &text)
}

#[win32_derive::dllexport]
pub fn GetDlgItemTextW(
    machine: &mut Machine,
    hDlg: HWND,
    nIDDlgItem: i32,
    lpString: ArrayWithSizeMut<u16>,
) -> u32 {
    let Some(buf) = lpString.to_option() else {
        kernel32::teb_mut(machine).LastErrorValue = 87;
        return 0;
    };
    if buf.is_empty() {
        return 0;
    }
    let Some(text) = item_text(machine, hDlg, nIDDlgItem) else {
        kernel32::teb_mut(machine).LastErrorValue = 1400;
        buf[0] = 0;
        return 0;
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    let n = units.len().min(buf.len() - 1);
    buf[..n].copy_from_slice(&units[..n]);
    buf[n] = 0;
    n as u32
}

#[win32_derive::dllexport]
pub fn GetDlgItemInt(
    machine: &mut Machine,
    hDlg: HWND,
    nIDDlgItem: i32,
    mut lpTranslated: Option<&mut u32>,
    bSigned: bool,
) -> u32 {
    let Some(text) = item_text(machine, hDlg, nIDDlgItem) else {
        if let Some(t) = lpTranslated.as_deref_mut() {
            *t = 0;
        }
        kernel32::teb_mut(machine).LastErrorValue = 1400;
        return 0;
    };
    let trimmed = text.trim();
    let (negative, digits) = if let Some(rest) = trimmed.strip_prefix('-') {
        (true, rest)
    } else if let Some(rest) = trimmed.strip_prefix('+') {
        (false, rest)
    } else {
        (false, trimmed)
    };
    let mut value: u64 = 0;
    let mut ok = !digits.is_empty();
    for c in digits.chars() {
        let Some(d) = c.to_digit(10) else {
            ok = false;
            break;
        };
        value = value.saturating_mul(10).saturating_add(d as u64);
        if value > 0x1_0000_0000 {
            ok = false;
            break;
        }
    }
    if let Some(t) = lpTranslated.as_deref_mut() {
        *t = if ok { 1 } else { 0 };
    }
    if !ok {
        return 0;
    }
    if bSigned {
        let signed = if negative {
            -(value as i64)
        } else {
            value as i64
        };
        signed as i32 as u32
    } else {
        if negative {
            if let Some(t) = lpTranslated.as_deref_mut() {
                *t = 0;
            }
            return 0;
        }
        value as u32
    }
}
