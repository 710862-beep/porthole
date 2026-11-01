#![allow(non_snake_case)]
#![allow(non_upper_case_globals)]

mod caps;
mod clipper;
mod ddraw1;
mod ddraw2;
mod ddraw7;
mod palette;
mod types;

pub use crate::winapi::com::GUID;
pub use clipper::DirectDrawCreateClipper;
pub use clipper::IDirectDrawClipper;
pub use ddraw1::*;
pub use ddraw2::*;
pub use ddraw7::*;
pub use palette::IDirectDrawPalette;

use super::{heap::Heap, types::*};
use crate::{host, machine::Machine, SurfaceOptions};
use memory::ExtensionsMut;
use std::collections::HashMap;
pub use types::*;

const TRACE_CONTEXT: &'static str = "ddraw";

pub struct Surface {
    pub host: Box<dyn host::Surface>,
    pub width: u32,
    pub height: u32,
    pub palette: u32, // same as key in palettes
    /// x86 address to pixel buffer, or 0 if unused.
    pixels: u32,
    /// Address of attached surface, e.g. back buffer.
    attached: u32,
}

impl Surface {
    fn new(machine: &mut Machine, hwnd: HWND, opts: &SurfaceOptions) -> Self {
        if opts.width == 0 || opts.height == 0 {
            panic!("cannot create 0-sized surface");
        }
        Surface {
            host: machine.host.create_surface(hwnd.to_raw(), &opts),
            width: opts.width,
            height: opts.height,
            palette: 0,
            pixels: 0,
            attached: 0,
        }
    }

    pub fn create(machine: &mut Machine, hwnd: HWND, desc: &DDSURFACEDESC2) -> Vec<Surface> {
        assert!(std::mem::size_of::<DDSURFACEDESC2>() == desc.dwSize as usize);

        let mut surfaces = Vec::new();

        let mut opts = crate::host::SurfaceOptions::default();
        if desc.dwFlags.contains(DDSD::WIDTH) {
            opts.width = desc.dwWidth;
        }
        if desc.dwFlags.contains(DDSD::HEIGHT) {
            opts.height = desc.dwHeight;
        }

        if let Some(caps) = desc.caps() {
            if caps.dwCaps.contains(DDSCAPS::PRIMARYSURFACE) {
                opts.primary = true;
            }
        }

        if opts.width == 0 || opts.height == 0 {
            // Take width/height from window dimensions
            if let Some(wnd) = machine.state.user32.windows.get(hwnd) {
                opts.width = wnd.width;
                opts.height = wnd.height;
            }
        }

        surfaces.push(Surface::new(machine, hwnd, &opts));

        if let Some(count) = desc.back_buffer_count() {
            opts.primary = false;
            for _ in 0..count {
                surfaces.push(Surface::new(machine, hwnd, &opts));
            }
        }

        surfaces
    }
}

/// DirectDraw DDBLT_COLORFILL. Keeps the locked guest buffer and the host
/// surface in sync. 8bpp colors are palette indices; 16/32bpp colors are raw
/// guest pixel values. The host surface is always RGBA.
pub fn color_fill(machine: &mut Machine, this: u32, rect: Option<&RECT>, color: u32) -> u32 {
    let Some(surface) = machine.state.ddraw.surfaces.get(&this) else {
        return DDERR_INVALIDOBJECT;
    };
    let (width, height, palette, pixels, attached) =
        (surface.width, surface.height, surface.palette, surface.pixels, surface.attached);
    let (x0, y0, x1, y1) = match rect {
        Some(r) => (
            r.left.max(0) as u32,
            r.top.max(0) as u32,
            (r.right.max(0) as u32).min(width),
            (r.bottom.max(0) as u32).min(height),
        ),
        None => (0, 0, width, height),
    };
    if x1 <= x0 || y1 <= y0 {
        return DD_OK;
    }
    let bpp = machine.state.ddraw.bytes_per_pixel.max(1);
    let rgba: [u8; 4] = if bpp == 1 {
        let index = (color & 0xff) as usize;
        match machine
            .state
            .ddraw
            .palettes
            .get(&palette)
            .or_else(|| machine.state.ddraw.palettes.get(&machine.state.ddraw.palette_hack))
            .and_then(|p| p.get(index))
        {
            Some(p) => [p.peRed, p.peGreen, p.peBlue, 255],
            None => [index as u8, index as u8, index as u8, 255],
        }
    } else {
        [(color >> 16) as u8, (color >> 8) as u8, color as u8, 255]
    };
    if pixels != 0 {
        let stride = width * bpp;
        let row_bytes = (x1 - x0) * bpp;
        let fill: Vec<u8> = match bpp {
            1 => vec![(color & 0xff) as u8; row_bytes as usize],
            2 => [(color & 0xff) as u8, ((color >> 8) & 0xff) as u8]
                .into_iter()
                .cycle()
                .take(row_bytes as usize)
                .collect(),
            4 => color.to_le_bytes().into_iter().cycle().take(row_bytes as usize).collect(),
            _ => vec![0; row_bytes as usize],
        };
        let mem = machine.emu.memory.mem();
        for y in y0..y1 {
            let addr = pixels + y * stride + x0 * bpp;
            if (addr as u64) + (row_bytes as u64) <= mem.len() as u64 {
                mem.sub32_mut(addr, row_bytes).copy_from_slice(&fill);
            }
        }
    }
    let surface = machine.state.ddraw.surfaces.get_mut(&this).unwrap();
    surface.host.fill_rect(x0, y0, x1 - x0, y1 - y0, rgba);
    if attached == 0 {
        surface.host.show();
    }
    DD_OK
}

pub struct State {
    heap: Heap,

    // TODO: this is per-IDirectDraw state.
    hwnd: HWND,
    pub surfaces: HashMap<u32, Surface>,

    bytes_per_pixel: u32,

    palettes: HashMap<u32, Box<[PALETTEENTRY]>>,
    /// XXX monolife attaches palette only to back surface, then flips; we need to rearrange
    /// how surface flipping works for the palettes to work out, so this is hacked for now.
    palette_hack: u32,
}

impl State {
    pub fn new_init(machine: &mut Machine) -> Self {
        let mut ddraw = State::default();
        ddraw.heap = machine.state.kernel32.new_private_heap(
            &mut machine.emu.memory,
            4 << 20,
            "ddraw.dll heap".into(),
        );
        ddraw
    }
}

impl Default for State {
    fn default() -> Self {
        State {
            heap: Heap::default(),
            hwnd: HWND::null(),
            surfaces: HashMap::new(),
            bytes_per_pixel: 4,
            palettes: HashMap::new(),
            palette_hack: 0,
        }
    }
}

const DD_OK: u32 = 0;
// DD error codes are generated with this MAKE_HRESULT macro, maybe it doesn't matter too much.
const DDERR_GENERIC: u32 = 0x80004005;
const DDERR_INVALIDOBJECT: u32 = 0x8876_0082; // MAKE_DDHRESULT(130)
const DDERR_INVALIDPARAMS: u32 = 0x8007_0057; // E_INVALIDARG

#[win32_derive::dllexport]
pub fn DirectDrawCreate(
    machine: &mut Machine,
    lpGuid: Option<&GUID>,
    lplpDD: Option<&mut u32>,
    pUnkOuter: u32,
) -> u32 {
    DirectDrawCreateEx(machine, lpGuid, lplpDD, None, pUnkOuter)
}

#[win32_derive::dllexport]
pub fn DirectDrawCreateEx(
    machine: &mut Machine,
    lpGuid: Option<&GUID>,
    lplpDD: Option<&mut u32>,
    iid: Option<&GUID>,
    pUnkOuter: u32,
) -> u32 {
    assert!(lpGuid.is_none());
    assert!(pUnkOuter == 0);

    if machine.state.ddraw.heap.addr == 0 {
        machine.state.ddraw = State::new_init(machine);
    }

    match iid {
        None => {
            // DirectDrawCreate
            *lplpDD.unwrap() = ddraw1::IDirectDraw::new(machine);
            return DD_OK;
        }
        Some(&ddraw7::IID_IDirectDraw7) => {
            *lplpDD.unwrap() = ddraw7::IDirectDraw7::new(machine);
            DD_OK
        }
        _ => {
            log::error!("DirectDrawCreateEx: unknown IID {iid:x?}");
            DDERR_GENERIC
        }
    }
}
