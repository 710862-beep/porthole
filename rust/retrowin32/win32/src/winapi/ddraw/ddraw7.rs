//! Implementation of DirectDraw7 interfaces.

use super::{color_fill, palette::IDirectDrawPalette, types::*, DDERR_INVALIDOBJECT, DDERR_INVALIDPARAMS, DD_OK};
pub use crate::winapi::com::GUID;
use crate::{
    winapi::{com::vtable, ddraw, kernel32::get_symbol, types::*},
    Machine,
};
use bitflags::bitflags;
use memory::ExtensionsMut;
use memory::Pod;

const TRACE_CONTEXT: &'static str = "ddraw/7";

pub const IID_IDirectDraw7: GUID = GUID {
    Data1: 0x15e65ec0,
    Data2: 0x3b9c,
    Data3: 0x11d2,
    Data4: [0xb9, 0x2f, 0x00, 0x60, 0x97, 0x97, 0xea, 0x5b],
};

bitflags! {
    pub struct DDSCL: u32 {
        const FULLSCREEN = 0x0001;
        const ALLOWREBOOT = 0x0002;
        const NOWINDOWCHANGES = 0x0004;
        const NORMAL = 0x0008;
        const EXCLUSIVE = 0x0010;
        const ALLOWMODEX = 0x0040;
        const SETFOCUSWINDOW = 0x0080;
        const SETDEVICEWINDOW = 0x0100;
        const CREATEDEVICEWINDOW = 0x0200;
        const MULTITHREADED = 0x0400;
        const FPUSETUP = 0x0800;
        const FPUPRESERVE =  0x1000;
    }
}
impl TryFrom<u32> for DDSCL {
    type Error = u32;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        DDSCL::from_bits(value).ok_or(value)
    }
}

bitflags! {
    pub struct DDFLIP: u32 {
        const DDFLIP_WAIT = 0x00000001;
        const DDFLIP_EVEN = 0x00000002;
        const DDFLIP_ODD = 0x00000004;
        const DDFLIP_NOVSYNC = 0x00000008;
        const DDFLIP_STEREO = 0x00000010;
        const DDFLIP_DONOTWAIT= 0x00000020;
        const DDFLIP_INTERVAL2= 0x02000000;
        const DDFLIP_INTERVAL3= 0x03000000;
        const DDFLIP_INTERVAL4= 0x04000000;
    }
}
impl TryFrom<u32> for DDFLIP {
    type Error = u32;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        DDFLIP::from_bits(value).ok_or(value)
    }
}

#[win32_derive::dllexport]
pub mod IDirectDraw7 {
    use super::*;

    vtable![
        QueryInterface: todo,
        AddRef: todo,
        Release: ok,
        Compact: todo,
        CreateClipper: todo,
        CreatePalette: ok,
        CreateSurface: ok,
        DuplicateSurface: todo,
        EnumDisplayModes: ok,
        EnumSurfaces: todo,
        FlipToGDISurface: todo,
        GetCaps: ok,
        GetDisplayMode: ok,
        GetFourCCCodes: todo,
        GetGDISurface: todo,
        GetMonitorFrequency: ok,
        GetScanLine: ok,
        GetVerticalBlankStatus: ok,
        Initialize: todo,
        RestoreDisplayMode: ok,
        SetCooperativeLevel: ok,
        SetDisplayMode: ok,
        WaitForVerticalBlank: ok,
        GetAvailableVidMem: ok,
        GetSurfaceFromDC: todo,
        RestoreAllSurfaces: todo,
        TestCooperativeLevel: ok,
        GetDeviceIdentifier: todo,
        StartModeTest: todo,
        EvaluateMode: todo,
    ];

    pub fn new(machine: &mut Machine) -> u32 {
        let ddraw = &mut machine.state.ddraw;
        let lpDirectDraw = ddraw.heap.alloc(machine.emu.memory.mem(), 4);
        let vtable = get_symbol(machine, "ddraw.dll", "IDirectDraw7");
        machine.mem().put_pod::<u32>(lpDirectDraw, vtable);
        lpDirectDraw
    }

    #[win32_derive::dllexport]
    pub fn Release(_machine: &mut Machine, this: u32) -> u32 {
        log::warn!("{this:x}->Release()");
        0 // TODO: return refcount?
    }

    #[win32_derive::dllexport]
    pub fn CreatePalette(
        machine: &mut Machine,
        this: u32,
        flags: Result<DDPCAPS, u32>,
        entries: u32,
        lplpPalette: u32,
        unused: u32,
    ) -> u32 {
        let flags = flags.unwrap();
        if !flags.contains(DDPCAPS::_8BIT) {
            todo!();
        }
        // TODO: if palette is DDPCAPS_8BITENTRIES then SetEntries needs change too.

        let palette = IDirectDrawPalette::new(machine);
        let entries = machine
            .mem()
            .view_n::<PALETTEENTRY>(entries, 256)
            .to_vec()
            .into_boxed_slice();
        machine.state.ddraw.palettes.insert(palette, entries);
        machine.mem().put_pod::<u32>(lplpPalette, palette);
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn CreateSurface(
        machine: &mut Machine,
        this: u32,
        desc: Option<&DDSURFACEDESC2>,
        lpDirectDrawSurface7: Option<&mut u32>,
        unused: u32,
    ) -> u32 {
        let surfaces = ddraw::Surface::create(machine, machine.state.ddraw.hwnd, desc.unwrap());
        if surfaces.len() > 2 {
            todo!()
        }

        let mut prev = 0;
        for mut surface in surfaces.into_iter().rev() {
            let ptr = IDirectDrawSurface7::new(machine);
            surface.attached = prev;
            machine.state.ddraw.surfaces.insert(ptr, surface);
            prev = ptr;
        }

        *lpDirectDrawSurface7.unwrap() = prev;

        DD_OK
    }

    #[win32_derive::dllexport]
    pub async fn EnumDisplayModes(
        machine: &mut Machine,
        this: u32,
        dwFlags: u32,
        lpSurfaceDesc: Option<&DDSURFACEDESC2>,
        lpContext: u32,
        lpEnumCallback: u32,
    ) -> u32 {
        if lpSurfaceDesc.is_some() {
            todo!()
        }

        let mem = machine.emu.memory.mem();
        let desc_addr = machine
            .state
            .ddraw
            .heap
            .alloc(mem, std::mem::size_of::<DDSURFACEDESC2>() as u32);
        let desc = mem.view_mut::<DDSURFACEDESC2>(desc_addr);
        *desc = DDSURFACEDESC2::zeroed();
        // TODO: offer multiple display modes rather than hardcoding this one.
        desc.dwSize = std::mem::size_of::<DDSURFACEDESC2>() as u32;
        desc.dwWidth = 320;
        desc.dwHeight = 200;
        desc.ddpfPixelFormat = DDPIXELFORMAT {
            dwSize: std::mem::size_of::<DDPIXELFORMAT>() as u32,
            dwFlags: 0,
            dwFourCC: 0,
            dwRGBBitCount: 8,
            dwRBitMask: 0xFF000000,
            dwGBitMask: 0x00FF0000,
            dwBBitMask: 0x0000FF00,
            dwRGBAlphaBitMask: 0x000000FF,
        };

        machine
            .call_x86(lpEnumCallback, vec![desc_addr, lpContext])
            .await;

        machine
            .state
            .ddraw
            .heap
            .free(machine.emu.memory.mem(), desc_addr);

        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetDisplayMode(
        _machine: &mut Machine,
        this: u32,
        lpDDSurfaceDesc: Option<&mut DDSURFACEDESC2>,
    ) -> u32 {
        let desc = lpDDSurfaceDesc.unwrap();
        *desc = DDSURFACEDESC2::zeroed();
        desc.dwSize = std::mem::size_of::<DDSURFACEDESC2>() as u32;
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetCaps(machine: &mut Machine, _this: u32, driver: u32, hel: u32) -> u32 {
        ddraw::caps::get_caps(machine, driver, hel)
    }

    #[win32_derive::dllexport]
    pub fn GetMonitorFrequency(_machine: &mut Machine, _this: u32, frequency: Option<&mut u32>) -> u32 {
        let Some(frequency) = frequency else { return DDERR_INVALIDPARAMS; };
        *frequency = 60;
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetScanLine(_machine: &mut Machine, _this: u32, scanline: Option<&mut u32>) -> u32 {
        let Some(scanline) = scanline else { return DDERR_INVALIDPARAMS; };
        // Software rasterizer has no asynchronous CRT beam; report a stable
        // visible scanline instead of DDERR_UNSUPPORTED.
        *scanline = 0;
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetVerticalBlankStatus(machine: &mut Machine, _this: u32, status: Option<&mut u32>) -> u32 {
        let Some(status) = status else { return DDERR_INVALIDPARAMS; };
        // Honest 60 Hz software CRT clock: a 1 ms vertical-blank window each 16 ms
        // refresh. Games that poll for the beam edge (DOOM95) need both states.
        *status = if machine.host.ticks() % 16 == 0 { 1 } else { 0 };
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetAvailableVidMem(
        machine: &mut Machine,
        _this: u32,
        _caps: Option<&DDSCAPS2>,
        total: Option<&mut u32>,
        free: Option<&mut u32>,
    ) -> u32 {
        let (Some(total), Some(free)) = (total, free) else { return DDERR_INVALIDPARAMS; };
        *total = machine.state.ddraw.heap.size;
        *free = machine.state.ddraw.heap.free_bytes();
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn TestCooperativeLevel(_machine: &mut Machine, _this: u32) -> u32 {
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn RestoreDisplayMode(_machine: &mut Machine, this: u32) -> u32 {
        0
    }

    #[win32_derive::dllexport]
    pub fn SetCooperativeLevel(
        machine: &mut Machine,
        this: u32,
        hwnd: HWND,
        flags: Result<DDSCL, u32>,
    ) -> u32 {
        // TODO: this triggers behaviors like fullscreen.
        machine.state.ddraw.hwnd = hwnd;
        let flags = flags.unwrap();
        if flags.contains(DDSCL::EXCLUSIVE) {
            let window = machine.state.user32.windows.get_mut(hwnd).unwrap();
            window.expect_toplevel_mut().host.fullscreen();
        }
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn SetDisplayMode(
        machine: &mut Machine,
        this: u32,
        width: u32,
        height: u32,
        bpp: u32,
        refresh: u32,
        flags: u32,
    ) -> u32 {
        if let Some(wnd) = machine
            .state
            .user32
            .windows
            .get_mut(machine.state.ddraw.hwnd)
        {
            wnd.set_client_size(&mut *machine.host, width, height);
        }
        machine.state.ddraw.bytes_per_pixel = bpp / 8;
        DD_OK
    }

    #[win32_derive::dllexport]
    pub async fn WaitForVerticalBlank(
        machine: &mut Machine,
        _this: u32,
        _flags: u32,
        _unused: u32,
    ) -> u32 {
        // Pace to the next 60 Hz vertical-blank window using the same honest clock
        // as GetVerticalBlankStatus. The async upcall yields to the host timer so
        // wall-clock time advances instead of spinning the Wasm instance.
        let phase = machine.host.ticks() % 16;
        let delay = if phase == 0 { 16 } else { 16 - phase };
        crate::winapi::kernel32::Sleep(machine, delay).await;
        DD_OK
    }
}

#[win32_derive::dllexport]
pub mod IDirectDrawSurface7 {
    use super::*;

    vtable![
        QueryInterface: todo,
        AddRef: todo,
        Release: ok,
        AddAttachedSurface: todo,
        AddOverlayDirtyRect: todo,
        Blt: ok,
        BltBatch: todo,
        BltFast: ok,
        DeleteAttachedSurface: todo,
        EnumAttachedSurfaces: todo,
        EnumOverlayZOrders: todo,
        Flip: ok,
        GetAttachedSurface: ok,
        GetBltStatus: ok,
        GetCaps: ok,
        GetClipper: todo,
        GetColorKey: ok,
        GetDC: ok,
        GetFlipStatus: ok,
        GetOverlayPosition: todo,
        GetPalette: ok,
        GetPixelFormat: ok,
        GetSurfaceDesc: ok,
        Initialize: todo,
        IsLost: ok,
        Lock: ok,
        ReleaseDC: ok,
        Restore: ok,
        SetClipper: ok,
        SetColorKey: ok,
        SetOverlayPosition: todo,
        SetPalette: ok,
        Unlock: ok,
        UpdateOverlay: todo,
        UpdateOverlayDisplay: todo,
        UpdateOverlayZOrder: todo,
        GetDDInterface: todo,
        PageLock: todo,
        PageUnlock: todo,
        SetSurfaceDesc: todo,
        SetPrivateData: todo,
        GetPrivateData: todo,
        FreePrivateData: todo,
        GetUniquenessValue: todo,
        ChangeUniquenessValue: todo,
        SetPriority: todo,
        GetPriority: todo,
        SetLOD: todo,
        GetLOD: todo,
    ];

    pub fn new(machine: &mut Machine) -> u32 {
        let ddraw = &mut machine.state.ddraw;
        let lpDirectDrawSurface7 = ddraw.heap.alloc(machine.emu.memory.mem(), 4);
        let vtable = get_symbol(machine, "ddraw.dll", "IDirectDrawSurface7");
        machine.mem().put_pod::<u32>(lpDirectDrawSurface7, vtable);
        lpDirectDrawSurface7
    }

    #[win32_derive::dllexport]
    pub fn Release(_machine: &mut Machine, this: u32) -> u32 {
        log::warn!("{this:x}->Release()");
        0 // TODO: return refcount?
    }

    #[win32_derive::dllexport]
    pub fn Blt(
        machine: &mut Machine,
        this: u32,
        lpDstRect: Option<&RECT>,
        lpSrc: u32,
        lpSrcRect: Option<&RECT>,
        flags: Result<DDBLT, u32>,
        lpDDBLTFX: Option<&DDBLTFX>,
    ) -> u32 {
        if lpDstRect.is_some() || lpSrcRect.is_some() {
            log::warn!("todo: Blt with rects");
        }
        let flags = flags.unwrap();
        if flags.contains(DDBLT::COLORFILL) {
            let Some(fx) = lpDDBLTFX else {
                return DDERR_INVALIDPARAMS;
            };
            if fx.dwSize as usize != std::mem::size_of::<DDBLTFX>() {
                return DDERR_INVALIDPARAMS;
            }
            return color_fill(machine, this, lpDstRect, fx.fill);
        }
        log::warn!("Blt: ignoring behavioral flags");
        BltFast(machine, this, 0, 0, lpSrc, None, 0)
    }

    #[win32_derive::dllexport]
    pub fn BltFast(
        machine: &mut Machine,
        this: u32,
        x: u32,
        y: u32,
        lpSrc: u32,
        lpRect: Option<&RECT>,
        flags: u32,
    ) -> u32 {
        if flags != 0 {
            log::warn!("BltFast flags: {:x}", flags);
        }
        let (dst, src) = unsafe {
            let dst = machine.state.ddraw.surfaces.get_mut(&this).unwrap() as *mut ddraw::Surface;
            let src = machine.state.ddraw.surfaces.get(&lpSrc).unwrap() as *const ddraw::Surface;
            assert_ne!(dst as *const ddraw::Surface, src);
            (&mut *dst, &*src)
        };
        if let Some(rect) = lpRect {
            let sx = rect.left as u32;
            let w = (rect.right - rect.left) as u32;
            let sy = rect.top as u32;
            let h = (rect.bottom - rect.top) as u32;
            dst.host.bit_blt(x, y, src.host.as_ref(), sx, sy, w, h);
        } else {
            dst.host
                .bit_blt(x, y, src.host.as_ref(), 0, 0, src.width, src.height);
        }
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn Flip(machine: &mut Machine, this: u32, lpSurf: u32, flags: Result<DDFLIP, u32>) -> u32 {
        let surface = machine.state.ddraw.surfaces.get(&this).unwrap();
        let attached = surface.attached;
        let back = machine.state.ddraw.surfaces.get_mut(&attached).unwrap();
        back.host.show();
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetAttachedSurface(
        machine: &mut Machine,
        this: u32,
        lpDDSCaps2: Option<&DDSCAPS2>,
        lpDirectDrawSurface7: Option<&mut u32>,
    ) -> u32 {
        // TODO: consider caps.
        let surface = machine.state.ddraw.surfaces.get(&this).unwrap();
        *lpDirectDrawSurface7.unwrap() = surface.attached;
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetCaps(_machine: &mut Machine, this: u32, lpDDSCAPS2: Option<&mut DDSCAPS2>) -> u32 {
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetBltStatus(_machine: &mut Machine, _this: u32, _flags: u32) -> u32 {
        // All supported blts are synchronous; DD_OK means "not still drawing".
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetFlipStatus(_machine: &mut Machine, _this: u32, _flags: u32) -> u32 {
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn IsLost(_machine: &mut Machine, _this: u32) -> u32 {
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetPalette(machine: &mut Machine, this: u32, palette: Option<&mut u32>) -> u32 {
        let Some(surface) = machine.state.ddraw.surfaces.get(&this) else { return DDERR_INVALIDOBJECT; };
        let Some(palette) = palette else { return DDERR_INVALIDPARAMS; };
        *palette = surface.palette;
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetColorKey(machine: &mut Machine, this: u32, _flags: u32, color_key: Option<&mut DDCOLORKEY>) -> u32 {
        let Some(surface) = machine.state.ddraw.surfaces.get(&this) else { return DDERR_INVALIDOBJECT; };
        let Some(color_key) = color_key else { return DDERR_INVALIDPARAMS; };
        *color_key = surface.color_key.clone().unwrap_or_default();
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn SetColorKey(machine: &mut Machine, this: u32, _flags: u32, color_key: Option<&DDCOLORKEY>) -> u32 {
        let Some(surface) = machine.state.ddraw.surfaces.get_mut(&this) else { return DDERR_INVALIDOBJECT; };
        surface.color_key = color_key.cloned();
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetDC(machine: &mut Machine, this: u32, lpHDC: u32) -> u32 {
        let dc =
            crate::winapi::gdi32::DC::new(crate::winapi::gdi32::DCTarget::DirectDrawSurface(this));
        let handle = machine.state.gdi32.dcs.add(dc);
        machine.mem().put_pod::<u32>(lpHDC, handle.to_raw());
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetPixelFormat(
        _machine: &mut Machine,
        this: u32,
        fmt: Option<&mut DDPIXELFORMAT>,
    ) -> u32 {
        let fmt = fmt.unwrap();
        assert!(fmt.dwSize == std::mem::size_of::<DDPIXELFORMAT>() as u32);
        *fmt = DDPIXELFORMAT {
            dwSize: std::mem::size_of::<DDPIXELFORMAT>() as u32,
            dwFlags: 0x00000040,
            dwFourCC: 0,
            dwRGBBitCount: 32,
            dwRBitMask: 0xFF00_0000,
            dwGBitMask: 0x00FF_0000,
            dwBBitMask: 0x0000_FF00,
            dwRGBAlphaBitMask: 0x0000_00FF,
        };
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn GetSurfaceDesc(
        machine: &mut Machine,
        this: u32,
        lpDesc: Option<&mut DDSURFACEDESC2>,
    ) -> u32 {
        let surf = machine.state.ddraw.surfaces.get(&this).unwrap();
        let desc = lpDesc.unwrap();
        assert!(desc.dwSize as usize == std::mem::size_of::<DDSURFACEDESC2>());
        // TODO: a trace of a ddraw2 program had the result contain
        // CAPS, HEIGHT, PITCH, PIXELFORMAT, WIDTH
        desc.dwWidth = surf.width;
        desc.dwFlags.insert(DDSD::WIDTH);
        desc.dwHeight = surf.height;
        desc.dwFlags.insert(DDSD::HEIGHT);
        desc.lPitch_dwLinearSize = surf.width * 4;
        desc.dwFlags.insert(DDSD::PITCH);

        // TODO: a trace of a ddraw2 program had the result contain
        // DDPF_RGB, r/g/b bitmasks
        desc.ddpfPixelFormat.dwRGBBitCount = 32;
        desc.dwFlags.insert(DDSD::PIXELFORMAT);
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn Lock(
        machine: &mut Machine,
        this: u32,
        rect: Option<&RECT>,
        desc: Option<&mut DDSURFACEDESC2>,
        flags: Result<DDLOCK, u32>,
        unused: u32,
    ) -> u32 {
        if rect.is_some() {
            // TODO: once we implement this, we need corresponding logic in Unlock.
            // Note also ddraw1's Unlock has a different type than 7.
            todo!();
        }
        let desc = desc.unwrap();
        let surf = machine.state.ddraw.surfaces.get_mut(&this).unwrap();
        if surf.pixels == 0 {
            surf.pixels = machine.state.ddraw.heap.alloc(
                machine.emu.memory.mem(),
                surf.width * surf.height * machine.state.ddraw.bytes_per_pixel,
            );
        }
        // It seems callers (effect, monolife) don't provide flags for what they want,
        // and instead expect all fields to be included.
        desc.lpSurface = surf.pixels;
        desc.lPitch_dwLinearSize = surf.width * machine.state.ddraw.bytes_per_pixel;
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn ReleaseDC(_machine: &mut Machine, _this: u32, _hDC: u32) -> u32 {
        // leak
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn Restore(_machine: &mut Machine, _this: u32) -> u32 {
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn SetClipper(_machine: &mut Machine, this: u32, clipper: u32) -> u32 {
        // e.g. machine.state.ddraw.surfaces.get_mut(&this).unwrap().palette = palette;
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn SetPalette(machine: &mut Machine, this: u32, palette: u32) -> u32 {
        machine.state.ddraw.surfaces.get_mut(&this).unwrap().palette = palette;
        machine.state.ddraw.palette_hack = palette;
        DD_OK
    }

    #[win32_derive::dllexport]
    pub fn Unlock(machine: &mut Machine, this: u32, rect: Option<&mut RECT>) -> u32 {
        let surf = machine.state.ddraw.surfaces.get_mut(&this).unwrap();
        if let Some(rect) = rect {
            // TODO: needs to match the rect passed in Lock.
            rect.left = 0;
            rect.top = 0;
            rect.right = surf.width as i32;
            rect.bottom = surf.height as i32;
        }
        assert!(surf.pixels != 0);
        match machine.state.ddraw.bytes_per_pixel {
            1 => {
                let pixels = machine
                    .emu
                    .memory
                    .mem()
                    .view_n::<u8>(surf.pixels, surf.width * surf.height);
                if let Some(palette) = machine
                    .state
                    .ddraw
                    .palettes
                    .get(&machine.state.ddraw.palette_hack)
                {
                    // XXX very inefficient
                    let pixels32: Vec<_> = pixels
                        .iter()
                        .map(|&i| {
                            let p = &palette[i as usize];
                            [p.peRed, p.peGreen, p.peBlue, 255]
                        })
                        .collect();
                    surf.host.write_pixels(&pixels32);
                }
            }
            4 => {
                let pixels = machine
                    .emu
                    .memory
                    .mem()
                    .view_n::<[u8; 4]>(surf.pixels, surf.width * surf.height);
                // XXX setting alpha channel manually, very inefficient :(
                let pixels32: Vec<_> = pixels.iter().map(|&[r, g, b, _a]| [r, g, b, 255]).collect();
                surf.host.write_pixels(&pixels32);
            }
            bpp => todo!("Unlock for {bpp}bpp"),
        }

        // If surface is primary then updates should show immediately.
        // XXX probably need something other than attached here
        if surf.attached == 0 {
            surf.host.show();
        }

        DD_OK
    }
}
