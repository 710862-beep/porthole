use super::{Brush, DCTarget, Pen, BITMAP, COLORREF, HDC, FONT};
use crate::{
    winapi::{
        bitmap::{Bitmap, BitmapMono, BitmapRGBA32},
        types::HANDLE,
    },
    Machine,
};

const TRACE_CONTEXT: &'static str = "gdi32/object";

#[derive(Debug)]
pub enum BitmapType {
    RGBA32(BitmapRGBA32),
    Mono(BitmapMono),
}

impl BitmapType {
    pub fn inner(&self) -> &dyn Bitmap {
        match self {
            BitmapType::RGBA32(b) => b,
            BitmapType::Mono(b) => b,
        }
    }
}

/// GDI Object, as identified by HANDLEs.
#[derive(Debug)]
pub enum Object {
    Brush(Brush),
    Bitmap(BitmapType),
    Pen(Pen),
    Palette(Vec<[u8; 4]>),
    Font(FONT),
}

pub type HGDIOBJ = HANDLE<Object>;
impl HGDIOBJ {
    /// Some Windows APIs use low values of GDI objects as known system constants,
    /// so start the handles higher.
    pub fn lowest_value() -> u32 {
        0x100
    }
}

#[derive(Debug, win32_derive::TryFromEnum)]
pub enum GetStockObjectArg {
    WHITE_BRUSH = 0,
    LTGRAY_BRUSH = 1,
    GRAY_BRUSH = 2,
    DKGRAY_BRUSH = 3,
    BLACK_BRUSH = 4,
    NULL_BRUSH = 5,
    NULL_PEN = 6,
    WHITE_PEN = 7,
    BLACK_PEN = 8,
    OEM_FIXED_FONT = 10,
    ANSI_FIXED_FONT = 11,
    ANSI_VAR_FONT = 12,
    SYSTEM_FONT = 13,
    DEVICE_DEFAULT_FONT = 14,
    DEFAULT_PALETTE = 15,
    SYSTEM_FIXED_FONT = 16,
    DEFAULT_GUI_FONT = 17,
    DC_BRUSH = 18,
    DC_PEN = 19,
}

#[win32_derive::dllexport]
pub fn GetStockObject(machine: &mut Machine, i: Result<GetStockObjectArg, u32>) -> HGDIOBJ {
    let Ok(i) = i else { return HGDIOBJ::null(); };
    match i {
        GetStockObjectArg::WHITE_BRUSH => machine.state.gdi32.objects.add(Object::Brush(Brush {
            color: Some(COLORREF::white()),
        })),
        GetStockObjectArg::LTGRAY_BRUSH => machine.state.gdi32.objects.add(Object::Brush(Brush {
            color: Some(COLORREF::from_rgb(0xc0, 0xc0, 0xc0)),
        })),
        GetStockObjectArg::BLACK_BRUSH => machine.state.gdi32.objects.add(Object::Brush(Brush {
            color: Some(COLORREF::from_rgb(0x00, 0x00, 0x00)),
        })),
        GetStockObjectArg::NULL_BRUSH => machine
            .state
            .gdi32
            .objects
            .add(Object::Brush(Brush { color: None })),
        GetStockObjectArg::GRAY_BRUSH => machine.state.gdi32.objects.add(Object::Brush(Brush {
            color: Some(COLORREF::from_rgb(0x80, 0x80, 0x80)),
        })),
        GetStockObjectArg::DKGRAY_BRUSH => machine.state.gdi32.objects.add(Object::Brush(Brush {
            color: Some(COLORREF::from_rgb(0x40, 0x40, 0x40)),
        })),
        GetStockObjectArg::NULL_PEN => machine.state.gdi32.objects.add(Object::Pen(Pen {
            color: COLORREF::from_rgb(0, 0, 0),
        })),
        GetStockObjectArg::WHITE_PEN => machine.state.gdi32.objects.add(Object::Pen(Pen {
            color: COLORREF::white(),
        })),
        GetStockObjectArg::BLACK_PEN | GetStockObjectArg::DC_PEN => machine
            .state
            .gdi32
            .objects
            .add(Object::Pen(Pen { color: COLORREF::from_rgb(0, 0, 0) })),
        GetStockObjectArg::DC_BRUSH => machine.state.gdi32.objects.add(Object::Brush(Brush {
            color: Some(COLORREF::white()),
        })),
        GetStockObjectArg::OEM_FIXED_FONT
        | GetStockObjectArg::ANSI_FIXED_FONT
        | GetStockObjectArg::ANSI_VAR_FONT
        | GetStockObjectArg::SYSTEM_FONT
        | GetStockObjectArg::DEVICE_DEFAULT_FONT
        | GetStockObjectArg::SYSTEM_FIXED_FONT
        | GetStockObjectArg::DEFAULT_GUI_FONT => machine.state.gdi32.objects.add(Object::Font(FONT {})),
        GetStockObjectArg::DEFAULT_PALETTE => machine
            .state
            .gdi32
            .objects
            .add(Object::Palette(Vec::new())),
    }
}

#[win32_derive::dllexport]
pub fn SelectObject(machine: &mut Machine, hdc: HDC, hGdiObj: HGDIOBJ) -> HGDIOBJ {
    let dc = match machine.state.gdi32.dcs.get_mut(hdc) {
        None => return HGDIOBJ::null(), // TODO: HGDI_ERROR
        Some(dc) => dc,
    };

    let obj = match machine.state.gdi32.objects.get(hGdiObj) {
        None => return HGDIOBJ::null(), // TODO: HGDI_ERROR
        Some(obj) => obj,
    };
    match obj {
        Object::Bitmap(_) => match dc.target {
            DCTarget::Memory(prev) => {
                dc.target = DCTarget::Memory(hGdiObj);
                prev
            }
            DCTarget::Window(_) => todo!(),
            DCTarget::DirectDrawSurface(_) => todo!(),
        },
        Object::Brush(_) => std::mem::replace(&mut dc.brush, hGdiObj),
        Object::Pen(_) => std::mem::replace(&mut dc.pen, hGdiObj),
        Object::Palette(_) => std::mem::replace(&mut dc.palette, hGdiObj),
        Object::Font(_) => std::mem::replace(&mut dc.font, hGdiObj),
    }
}

#[win32_derive::dllexport]
pub fn GetObjectA(machine: &mut Machine, handle: HGDIOBJ, bytes: u32, out: u32) -> u32 {
    let obj = match machine.state.gdi32.objects.get(handle) {
        None => return 0, // fail
        Some(obj) => obj,
    };

    match obj {
        Object::Brush(_) => todo!(),
        Object::Bitmap(bitmap) => {
            assert_eq!(bytes as usize, std::mem::size_of::<BITMAP>());
            let out = machine.mem().view_mut::<BITMAP>(out);
            let bitmap = bitmap.inner();
            *out = BITMAP {
                bmType: 0,
                bmWidth: bitmap.width(),
                bmHeight: bitmap.height(),
                bmWidthBytes: 0,
                bmPlanes: 0,
                bmBitsPixel: 0,
                bmBits: 0,
            };
            bytes
        }
        Object::Pen(_) => todo!(),
        Object::Palette(_) => 0,
        Object::Font(_) => 0,
    }
}

#[win32_derive::dllexport]
pub fn DeleteObject(_machine: &mut Machine, handle: HGDIOBJ) -> bool {
    // TODO: leak
    true
}
