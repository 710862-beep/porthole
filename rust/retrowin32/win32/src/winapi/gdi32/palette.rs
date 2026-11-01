use crate::{winapi::gdi32::{HGDIOBJ, Object, HDC}, Machine};
use memory::{Extensions, ExtensionsMut};

const TRACE_CONTEXT: &'static str = "gdi32/palette";

fn system_palette() -> Vec<[u8; 4]> {
    // Standard 256-entry Windows VGA palette: 16 system colors, 240 color cube, 8 grays.
    let mut entries = Vec::with_capacity(256);
    let sys = [[0,0,0],[128,0,0],[0,128,0],[128,128,0],[0,0,128],[128,0,128],[0,128,128],[192,192,192],[128,128,128],[255,0,0],[0,255,0],[255,255,0],[0,0,255],[255,0,255],[0,255,255],[255,255,255]];
    for c in sys { entries.push([c[0], c[1], c[2], 255]); }
    for r in 0..6 { for g in 0..6 { for b in 0..6 {
        let v = |x: u8| if x == 0 { 0 } else { 55 + x * 40 };
        entries.push([v(r), v(g), v(b), 255]);
    }}}
    for i in 0..8 { let g = 8 + i * 32; entries.push([g, g, g, 255]); }
    entries.truncate(256);
    entries
}

#[win32_derive::dllexport]
pub fn CreatePalette(machine: &mut Machine, plpal: u32) -> HGDIOBJ {
    if plpal == 0 { return HGDIOBJ::null(); }
    let mem = machine.mem();
    let Some(bytes) = mem.as_slice().get(plpal as usize..) else { return HGDIOBJ::null(); };
    if bytes.len() < 4 { return HGDIOBJ::null(); }
    let count = u16::from_le_bytes([bytes[2], bytes[3]]) as usize;
    if count == 0 || bytes.len() < 4 + count * 4 { return HGDIOBJ::null(); }
    let mut entries = Vec::with_capacity(count);
    for i in 0..count {
        let off = 4 + i * 4;
        entries.push([bytes[off + 2], bytes[off + 1], bytes[off], 255]); // RGBQUAD -> RGBA
    }
    machine.state.gdi32.objects.add(Object::Palette(entries))
}
#[win32_derive::dllexport]
pub fn GetSystemPaletteEntries(machine: &mut Machine, hdc: HDC, iStart: u32, cEntries: u32, lppe: u32) -> u32 {
    let _ = hdc;
    let pal = system_palette();
    if lppe == 0 { return pal.len() as u32; }
    let count = (cEntries as usize).min(pal.len().saturating_sub(iStart as usize));
    let mem = machine.mem();
    if lppe.checked_add(count as u32 * 4).map_or(true, |end| end as usize > mem.as_slice().len()) { return 0; }
    for i in 0..count {
        let e = pal[iStart as usize + i];
        let off = lppe + i as u32 * 4;
        mem.put_pod::<u8>(off, e[2]); mem.put_pod::<u8>(off + 1, e[1]); mem.put_pod::<u8>(off + 2, e[0]); mem.put_pod::<u8>(off + 3, 0);
    }
    count as u32
}
#[win32_derive::dllexport]
pub fn SelectPalette(machine: &mut Machine, hdc: HDC, hpal: HGDIOBJ, bForceBackground: u32) -> HGDIOBJ {
    let _ = bForceBackground;
    if machine.state.gdi32.objects.get(hpal).is_none() { return HGDIOBJ::null(); }
    let Some(dc) = machine.state.gdi32.dcs.get_mut(hdc) else { return HGDIOBJ::null(); };
    std::mem::replace(&mut dc.palette, hpal)
}
#[win32_derive::dllexport]
pub fn RealizePalette(machine: &mut Machine, hdc: HDC) -> u32 {
    let _ = hdc;
    0 // no system-palette entries remapped in a true-color backing store
}
#[win32_derive::dllexport]
pub fn UnrealizeObject(machine: &mut Machine, hGdiObj: HGDIOBJ) -> bool {
    machine.state.gdi32.objects.get(hGdiObj).is_some()
}
