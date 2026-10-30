//! SDL2 HLE for Gate 2 (Chocolate Doom 3.1.1 official win64 build).
//!
//! The guest imports ~104 SDL2 functions plus SDL2_mixer/SDL2_net/libpng/libfluidsynth symbols.
//! This module implements the surface/renderer/texture object model for real, because Gate 2's
//! rendering claim is defined here: a frame is counted ONLY when the guest presents pixels it
//! wrote itself — `SDL_RenderPresent` after `SDL_RenderCopy` of a guest-filled texture, or
//! `SDL_UpdateWindowSurface` of a guest-filled window surface. The captured bytes are copied out
//! of guest memory at present time; the host never invents a pixel. (A bare `SDL_RenderClear`
//! present captures the guest-issued clear colour — still a guest command, never host content.)
//!
//! Pixel-format constants follow SDL_pixels.h (release-2.30.x):
//! `SDL_DEFINE_PIXELFORMAT(type, order, layout, bits, bytes) =
//! (1<<28)|(type<<24)|(order<<20)|(layout<<16)|(bits<<8)|bytes`.
//! SDL_Surface / SDL_PixelFormat / SDL_Palette / SDL_RendererInfo / SDL_DisplayMode field offsets
//! below are the public ABI layouts from SDL_surface.h / SDL_render.h / SDL_video.h.

use std::collections::HashMap;

use crate::vmm::VirtualMemoryManager;
use crate::win32_hle::Win32Kernel;

pub const PF_INDEX8: u32 = 0x1300_0801;
pub const PF_RGB565: u32 = 0x1515_1002;
pub const PF_XRGB8888: u32 = 0x1616_2004;
pub const PF_ARGB8888: u32 = 0x1636_2004;
pub const PF_RGBA8888: u32 = 0x1646_2004;
pub const PF_ABGR8888: u32 = 0x1676_2004;
pub const PF_BGRA8888: u32 = 0x1686_2004;

#[derive(Clone)]
pub struct SdlSurfaceInfo {
    pub w: i32,
    pub h: i32,
    pub pitch: i32,
    pub format: u32,
    pub bpp: u32,
    pub rmask: u32,
    pub gmask: u32,
    pub bmask: u32,
    pub amask: u32,
    pub pixels: u64,
    /// Guest address of the SDL_Palette struct for indexed formats (0 otherwise).
    pub palette: u64,
}

#[derive(Clone)]
struct SdlWindowInfo {
    w: i32,
    h: i32,
    id: u32,
    /// Lazily created SDL_Surface* backing SDL_GetWindowSurface (aliases `backbuffer`).
    surface: u64,
    /// Guest-memory window backbuffer (ARGB8888). SDL_RenderClear/RenderCopy with no render
    /// target draw here; SDL_RenderPresent captures exactly these guest-written bytes.
    backbuffer: u64,
    bb_pitch: i32,
}

#[derive(Clone)]
struct SdlRendererInfo {
    window: u64,
    target: u64,
    draw_color: [u8; 4],
}

#[derive(Clone)]
struct SdlTextureInfo {
    w: i32,
    h: i32,
    format: u32,
    pixels: u64,
    pitch: i32,
}

pub struct SdlState {
    next_window_id: u32,
    windows: HashMap<u64, SdlWindowInfo>,
    renderers: HashMap<u64, SdlRendererInfo>,
    textures: HashMap<u64, SdlTextureInfo>,
    surfaces: HashMap<u64, SdlSurfaceInfo>,
    ticks_ms: u64,
    /// Frames the GUEST presented (Gate 2's only frame counter on the SDL path).
    pub presented_frames: u64,
    /// Last presented frame as tight RGBA8, copied from guest memory at present time.
    pub last_frame_rgba: Vec<u8>,
    pub last_frame_w: u32,
    pub last_frame_h: u32,
    pub frame_dirty: bool,
    empty_str: u64,
    renderer_name: u64,
}

impl SdlState {
    pub fn new() -> Self {
        Self {
            next_window_id: 1,
            windows: HashMap::new(),
            renderers: HashMap::new(),
            textures: HashMap::new(),
            surfaces: HashMap::new(),
            ticks_ms: 0,
            presented_frames: 0,
            last_frame_rgba: Vec::new(),
            last_frame_w: 0,
            last_frame_h: 0,
            frame_dirty: false,
            empty_str: 0,
            renderer_name: 0,
        }
    }
}

fn bpp_for_format(format: u32) -> u32 {
    let bytes = format & 0xFF;
    if bytes == 0 {
        4
    } else {
        bytes
    }
}

fn masks_for_format(format: u32) -> (u32, u32, u32, u32) {
    match format {
        PF_ARGB8888 => (0x00FF_0000, 0x0000_FF00, 0x0000_00FF, 0xFF00_0000),
        PF_RGBA8888 => (0xFF00_0000, 0x00FF_0000, 0x0000_FF00, 0x0000_00FF),
        PF_ABGR8888 => (0x0000_00FF, 0x0000_FF00, 0x00FF_0000, 0xFF00_0000),
        PF_BGRA8888 => (0x0000_FF00, 0x00FF_0000, 0xFF00_0000, 0x0000_00FF),
        PF_XRGB8888 => (0x00FF_0000, 0x0000_FF00, 0x0000_00FF, 0),
        PF_RGB565 => (0xF800, 0x07E0, 0x001F, 0),
        _ => (0, 0, 0, 0),
    }
}

fn format_for_masks(depth: i32, r: u32, g: u32, b: u32, a: u32) -> u32 {
    match (depth, r, g, b, a) {
        (8, _, _, _, _) => PF_INDEX8,
        (16, 0xF800, 0x07E0, 0x001F, _) => PF_RGB565,
        (32, 0x00FF_0000, 0x0000_FF00, 0x0000_00FF, 0xFF00_0000) => PF_ARGB8888,
        (32, 0xFF00_0000, 0x00FF_0000, 0x0000_FF00, 0x0000_00FF) => PF_RGBA8888,
        (32, 0x0000_00FF, 0x0000_FF00, 0x00FF_0000, 0xFF00_0000) => PF_ABGR8888,
        (32, 0x0000_FF00, 0x00FF_0000, 0xFF00_0000, 0x0000_00FF) => PF_BGRA8888,
        (32, 0x00FF_0000, 0x0000_FF00, 0x0000_00FF, 0) => PF_XRGB8888,
        _ => PF_ARGB8888,
    }
}

/// Decode one packed 32/16-bit pixel to RGBA8 via channel masks (shift+scale to 8 bits).
fn decode_packed(px: u32, rmask: u32, gmask: u32, bmask: u32, amask: u32) -> [u8; 4] {
    let chan = |mask: u32| -> u8 {
        if mask == 0 {
            return 0;
        }
        let shift = mask.trailing_zeros();
        let max = mask >> shift;
        let v = (px & mask) >> shift;
        ((v * 255 + max / 2) / max.max(1)) as u8
    };
    [
        chan(rmask),
        chan(gmask),
        chan(bmask),
        if amask == 0 { 255 } else { chan(amask) },
    ]
}

/// Inverse of decode_packed: pack an RGBA8 colour into a masked pixel value.
fn encode_packed(rgba: [u8; 4], rmask: u32, gmask: u32, bmask: u32, amask: u32) -> u32 {
    let enc = |v: u8, mask: u32| -> u32 {
        if mask == 0 {
            return 0;
        }
        let shift = mask.trailing_zeros();
        let max = mask >> shift;
        (((v as u32 * max + 127) / 255) << shift) & mask
    };
    enc(rgba[0], rmask) | enc(rgba[1], gmask) | enc(rgba[2], bmask) | enc(rgba[3], amask)
}

/// A drawable pixel buffer (texture or window backbuffer) for renderer blits.
#[derive(Clone)]
struct PixBuf {
    pixels: u64,
    w: i32,
    h: i32,
    pitch: i32,
    format: u32,
    bpp: u32,
    masks: (u32, u32, u32, u32),
}

impl Win32Kernel {
    fn sdl_empty_str(&mut self, vmm: &mut VirtualMemoryManager) -> u64 {
        if self.sdl.empty_str == 0 {
            let p = self.heap_alloc(vmm, self.process_heap, 2);
            if p != 0 {
                let _ = vmm.write_bytes(p, b"\0\0");
            }
            self.sdl.empty_str = p;
        }
        self.sdl.empty_str
    }

    /// Allocate a guest SDL_Surface (+ SDL_PixelFormat, + SDL_Palette for INDEX8) and register it.
    #[allow(clippy::too_many_arguments)]
    fn sdl_new_surface(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        w: i32,
        h: i32,
        format: u32,
        masks: Option<(u32, u32, u32, u32)>,
        pixels: Option<u64>,
        pitch: Option<i32>,
    ) -> u64 {
        let bpp = bpp_for_format(format);
        let (r, g, b, a) = masks.unwrap_or_else(|| masks_for_format(format));
        let pitch = pitch.unwrap_or(w * bpp as i32);
        let pixels = match pixels {
            Some(p) => p,
            None => {
                let size = (pitch.max(0) as u64) * (h.max(0) as u64);
                let p = self.heap_alloc(vmm, self.process_heap, size.max(4));
                if p != 0 && size > 0 {
                    let _ = vmm.write_bytes(p, &vec![0u8; size as usize]);
                }
                p
            }
        };
        // SDL_Palette for indexed formats: {int ncolors; SDL_Color *colors; Uint32 version; int refcount}
        let mut palette = 0u64;
        if format == PF_INDEX8 {
            let colors = self.heap_alloc(vmm, self.process_heap, 256 * 4);
            if colors != 0 {
                // Default palette: identity greyscale until SDL_SetPaletteColors replaces it.
                let mut buf = vec![0u8; 256 * 4];
                for i in 0..256 {
                    buf[i * 4] = i as u8;
                    buf[i * 4 + 1] = i as u8;
                    buf[i * 4 + 2] = i as u8;
                    buf[i * 4 + 3] = 255;
                }
                let _ = vmm.write_bytes(colors, &buf);
            }
            palette = self.heap_alloc(vmm, self.process_heap, 24);
            if palette != 0 {
                let _ = vmm.write_u32(palette, 256);
                let _ = vmm.write_u64(palette + 8, colors);
                let _ = vmm.write_u32(palette + 16, 1);
                let _ = vmm.write_u32(palette + 20, 1);
            }
        }
        // SDL_PixelFormat: {Uint32 format; SDL_Palette *palette; Uint8 BitsPerPixel;
        // Uint8 BytesPerPixel; Uint8 padding[2]; Uint32 Rmask,Gmask,Bmask,Amask; ...}
        let fmt = self.heap_alloc(vmm, self.process_heap, 56);
        if fmt != 0 {
            let _ = vmm.write_u32(fmt, format);
            let _ = vmm.write_u64(fmt + 8, palette);
            let _ = vmm.write_u8(fmt + 16, (bpp * 8) as u8);
            let _ = vmm.write_u8(fmt + 17, bpp as u8);
            let _ = vmm.write_u32(fmt + 20, r);
            let _ = vmm.write_u32(fmt + 24, g);
            let _ = vmm.write_u32(fmt + 28, b);
            let _ = vmm.write_u32(fmt + 32, a);
        }
        // SDL_Surface layout (x64): flags@0, format@8, w@16, h@20, pitch@24, pixels@32,
        // userdata@40, locked@48, lock_data@56, clip_rect@64 (4 x i32), map@80, refcount@88.
        let surf = self.heap_alloc(vmm, self.process_heap, 96);
        if surf == 0 {
            return 0;
        }
        let _ = vmm.write_bytes(surf, &[0u8; 96]);
        let _ = vmm.write_u64(surf + 8, fmt);
        let _ = vmm.write_u32(surf + 16, w as u32);
        let _ = vmm.write_u32(surf + 20, h as u32);
        let _ = vmm.write_u32(surf + 24, pitch as u32);
        let _ = vmm.write_u64(surf + 32, pixels);
        let _ = vmm.write_u32(surf + 64 + 8, w as u32); // clip_rect.w
        let _ = vmm.write_u32(surf + 64 + 12, h as u32); // clip_rect.h
        let _ = vmm.write_u32(surf + 88, 1); // refcount
        self.sdl.surfaces.insert(
            surf,
            SdlSurfaceInfo {
                w,
                h,
                pitch,
                format,
                bpp,
                rmask: r,
                gmask: g,
                bmask: b,
                amask: a,
                pixels,
                palette,
            },
        );
        surf
    }

    /// Capture a guest pixel buffer into the presented-frame slot as tight RGBA8.
    /// Every byte comes from guest memory (texture/surface pixels the guest wrote).
    fn sdl_capture_pixels(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        pixels: u64,
        w: i32,
        h: i32,
        pitch: i32,
        bpp: u32,
        masks: (u32, u32, u32, u32),
        palette: u64,
    ) {
        if w <= 0 || h <= 0 || pitch <= 0 || pixels == 0 {
            return;
        }
        let mut raw = vec![0u8; (pitch as usize) * (h as usize)];
        if vmm.read_bytes(pixels, &mut raw).is_err() {
            return;
        }
        let mut palette_cols = [[0u8; 4]; 256];
        if bpp == 1 && palette != 0 {
            let colors = vmm.read_u64(palette + 8).unwrap_or(0);
            if colors != 0 {
                let mut buf = [0u8; 256 * 4];
                if vmm.read_bytes(colors, &mut buf).is_ok() {
                    for i in 0..256 {
                        palette_cols[i] = [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], buf[i * 4 + 3]];
                    }
                }
            }
        }
        let mut out = vec![0u8; (w as usize) * (h as usize) * 4];
        for y in 0..h as usize {
            let row = &raw[y * pitch as usize..];
            for x in 0..w as usize {
                let dst = (y * w as usize + x) * 4;
                let px: [u8; 4] = match bpp {
                    1 => palette_cols[row[x] as usize],
                    2 => {
                        let v = u16::from_le_bytes([row[x * 2], row[x * 2 + 1]]) as u32;
                        decode_packed(v, masks.0, masks.1, masks.2, masks.3)
                    }
                    3 => [row[x * 3], row[x * 3 + 1], row[x * 3 + 2], 255],
                    _ => {
                        let v = u32::from_le_bytes([
                            row[x * 4],
                            row[x * 4 + 1],
                            row[x * 4 + 2],
                            row[x * 4 + 3],
                        ]);
                        decode_packed(v, masks.0, masks.1, masks.2, masks.3)
                    }
                };
                out[dst..dst + 4].copy_from_slice(&px);
            }
        }
        self.sdl.last_frame_rgba = out;
        self.sdl.last_frame_w = w as u32;
        self.sdl.last_frame_h = h as u32;
        self.sdl.frame_dirty = true;
        self.sdl.presented_frames += 1;
    }

    fn sdl_present_surface(&mut self, vmm: &mut VirtualMemoryManager, surf: u64) {
        if let Some(s) = self.sdl.surfaces.get(&surf).cloned() {
            self.sdl_capture_pixels(
                vmm,
                s.pixels,
                s.w,
                s.h,
                s.pitch,
                s.bpp,
                (s.rmask, s.gmask, s.bmask, s.amask),
                s.palette,
            );
        }
    }

    fn sdl_tex_pixbuf(&self, tex: u64) -> Option<PixBuf> {
        self.sdl.textures.get(&tex).map(|t| PixBuf {
            pixels: t.pixels,
            w: t.w,
            h: t.h,
            pitch: t.pitch,
            format: t.format,
            bpp: bpp_for_format(t.format),
            masks: masks_for_format(t.format),
        })
    }

    /// The renderer's current drawing destination: its target texture, or the window backbuffer.
    fn sdl_dst_pixbuf(&self, r: &SdlRendererInfo) -> Option<PixBuf> {
        if r.target != 0 {
            return self.sdl_tex_pixbuf(r.target);
        }
        self.sdl.windows.get(&r.window).and_then(|w| {
            if w.backbuffer == 0 {
                None
            } else {
                Some(PixBuf {
                    pixels: w.backbuffer,
                    w: w.w,
                    h: w.h,
                    pitch: w.bb_pitch,
                    format: PF_ARGB8888,
                    bpp: 4,
                    masks: masks_for_format(PF_ARGB8888),
                })
            }
        })
    }

    /// Fill a PixBuf entirely with one RGBA colour (SDL_RenderClear on the current target).
    fn sdl_fill_pixbuf(&mut self, vmm: &mut VirtualMemoryManager, dst: &PixBuf, rgba: [u8; 4]) {
        if dst.w <= 0 || dst.h <= 0 || dst.pitch <= 0 || dst.pixels == 0 {
            return;
        }
        let bpp = dst.bpp as usize;
        let packed = encode_packed(rgba, dst.masks.0, dst.masks.1, dst.masks.2, dst.masks.3);
        let mut buf = vec![0u8; (dst.pitch as usize) * (dst.h as usize)];
        for y in 0..dst.h as usize {
            let row = y * dst.pitch as usize;
            for x in 0..dst.w as usize {
                let off = row + x * bpp;
                buf[off..off + bpp.min(4)].copy_from_slice(&packed.to_le_bytes()[..bpp.min(4)]);
            }
        }
        let _ = vmm.write_bytes(dst.pixels, &buf);
    }

    /// SDL_RenderCopy: nearest-neighbour scaled blit of a guest texture into the current render
    /// destination. Every output pixel is a guest texture pixel (converted between pixel
    /// formats via the real masks); this is what makes the presented frame guest-rendered
    /// instead of a stale recording of an untouched target buffer.
    fn sdl_render_blit(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        src: &PixBuf,
        srect: (i32, i32, i32, i32),
        dst: &PixBuf,
        drect: (i32, i32, i32, i32),
    ) {
        let (sx, sy, sw, sh) = srect;
        let (dx, dy, dw, dh) = drect;
        if sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0 || src.pitch <= 0 || dst.pitch <= 0 {
            return;
        }
        let mut sdata = vec![0u8; (src.pitch as usize) * (src.h.max(0) as usize)];
        if vmm.read_bytes(src.pixels, &mut sdata).is_err() {
            return;
        }
        let mut ddata = vec![0u8; (dst.pitch as usize) * (dst.h.max(0) as usize)];
        if vmm.read_bytes(dst.pixels, &mut ddata).is_err() {
            return;
        }
        let sbpp = src.bpp as usize;
        let dbpp = dst.bpp as usize;
        let read_src = |x: i32, y: i32| -> [u8; 4] {
            let cx = x.clamp(0, src.w - 1) as usize;
            let cy = y.clamp(0, src.h - 1) as usize;
            let off = cy * src.pitch as usize + cx * sbpp;
            match sbpp {
                1 => {
                    let v = sdata[off];
                    [v, v, v, 255]
                }
                2 => {
                    let v = u16::from_le_bytes([sdata[off], sdata[off + 1]]) as u32;
                    decode_packed(v, src.masks.0, src.masks.1, src.masks.2, src.masks.3)
                }
                3 => [sdata[off], sdata[off + 1], sdata[off + 2], 255],
                _ => {
                    let v = u32::from_le_bytes([
                        sdata[off],
                        sdata[off + 1],
                        sdata[off + 2],
                        sdata[off + 3],
                    ]);
                    decode_packed(v, src.masks.0, src.masks.1, src.masks.2, src.masks.3)
                }
            }
        };
        for j in 0..dh {
            let ty = dy + j;
            if ty < 0 || ty >= dst.h {
                continue;
            }
            let syy = sy + ((j as i64 * sh as i64) / dh as i64) as i32;
            let drow = ty as usize * dst.pitch as usize;
            for i in 0..dw {
                let tx = dx + i;
                if tx < 0 || tx >= dst.w {
                    continue;
                }
                let sxx = sx + ((i as i64 * sw as i64) / dw as i64) as i32;
                let rgba = read_src(sxx, syy);
                let packed = encode_packed(rgba, dst.masks.0, dst.masks.1, dst.masks.2, dst.masks.3);
                let off = drow + tx as usize * dbpp;
                ddata[off..off + dbpp.min(4)]
                    .copy_from_slice(&packed.to_le_bytes()[..dbpp.min(4)]);
            }
        }
        let _ = vmm.write_bytes(dst.pixels, &ddata);
    }

    /// Entry point for every SDL-family DLL import. Returns the value for RAX.
    pub fn sdl_dispatch(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        dll: &str,
        symbol: &str,
        args: &[u64; 10],
    ) -> u64 {
        let a0 = args[0];
        let a1 = args[1];
        let a2 = args[2];
        let a3 = args[3];
        let a4 = args[4];
        let a5 = args[5];
        match dll {
            "sdl2.dll" => {}
            "sdl2_mixer.dll" => {
                // Audio mixing is out of scope for the rendering gate; report plausible mixer
                // answers so a guest that ignores -nosound degrades silently (and say so once).
                return match symbol {
                    "Mix_OpenAudioDevice" | "Mix_Init" | "Mix_AllocateChannels" => 0,
                    "Mix_QuerySpec" => {
                        if a0 != 0 {
                            let _ = vmm.write_u32(a0, 44100);
                        }
                        if a1 != 0 {
                            let _ = vmm.write_u16(a1, 0x8010); // AUDIO_S16LSB
                        }
                        if a2 != 0 {
                            let _ = vmm.write_u32(a2, 2);
                        }
                        1
                    }
                    _ => 0,
                };
            }
            "sdl2_net.dll" => {
                return match symbol {
                    "SDLNet_GetError" => self.sdl_empty_str(vmm),
                    "SDLNet_AllocPacket" => self.heap_alloc(vmm, self.process_heap, 64),
                    _ => 0,
                };
            }
            "libpng16-16.dll" => {
                // Screenshot encoding only; allocations succeed, writes are dropped (named gap:
                // PNG screenshots are not produced by the emulator).
                return match symbol {
                    "png_create_write_struct" | "png_create_info_struct" => {
                        self.heap_alloc(vmm, self.process_heap, 256)
                    }
                    _ => 0,
                };
            }
            "libfluidsynth-3.dll" | "libsamplerate-0.dll" | "winmm.dll" => {
                // Music/synth path: with -nosound these are unreachable. Return allocations for
                // constructors and 0 elsewhere; fluid_synth_write_s16 fills silence.
                return match symbol {
                    "new_fluid_settings" | "new_fluid_synth" | "new_fluid_player" => {
                        self.heap_alloc(vmm, self.process_heap, 256)
                    }
                    "fluid_synth_write_s16" => {
                        // (synth, len, lout, loff, lincr, rout, roff, rincr): silence both.
                        let len = (a1 as usize).min(1 << 20);
                        for base in [a2, a5] {
                            if base != 0 {
                                for i in 0..len {
                                    let _ = vmm.write_u16(base + (i as u64) * 4, 0);
                                }
                            }
                        }
                        0
                    }
                    "src_simple" => 0,
                    "midiOutGetNumDevs" => 0,
                    _ => 0,
                };
            }
            _ => return 0,
        }
        match symbol {
            // ---------------------------------------------------------- lifecycle / misc
            "SDL_Init" | "SDL_InitSubSystem" => 0,
            "SDL_Quit" | "SDL_QuitSubSystem" | "SDL_SetMainReady" => 0,
            "SDL_GetError" => self.sdl_empty_str(vmm),
            "SDL_SetHint" | "SDL_SetHintWithPriority" => 1,
            "SDL_GetVersion" => {
                // SDL_version {Uint8 major, minor, patch}
                if a0 != 0 {
                    let _ = vmm.write_bytes(a0, &[2, 30, 7]);
                }
                0
            }
            "SDL_GetTicks" => {
                let by_frames = self.sdl.presented_frames.saturating_mul(28);
                if self.sdl.ticks_ms < by_frames {
                    self.sdl.ticks_ms = by_frames;
                }
                self.sdl.ticks_ms = self.sdl.ticks_ms.saturating_add(1);
                self.sdl.ticks_ms & 0xFFFF_FFFF
            }
            "SDL_Delay" => {
                self.sdl.ticks_ms = self.sdl.ticks_ms.saturating_add(a0);
                0
            }
            "SDL_ShowSimpleMessageBox" => {
                let title = self.read_ansi(vmm, a1);
                let msg = self.read_ansi(vmm, a2);
                let line = format!("\n[SDL_ShowSimpleMessageBox] {title}: {msg}\n");
                self.stdout.extend_from_slice(line.as_bytes());
                0
            }
            "SDL_GetPrefPath" => {
                let org = if a0 != 0 { self.read_ansi(vmm, a0) } else { String::new() };
                let app = if a1 != 0 { self.read_ansi(vmm, a1) } else { String::new() };
                let path = format!("C:\\Users\\PORTHOLE\\AppData\\Roaming\\{org}\\{app}\\");
                let p = self.heap_alloc(vmm, self.process_heap, path.len() as u64 + 1);
                if p != 0 {
                    let _ = self.write_ansi(vmm, p, &path);
                }
                p
            }
            "SDL_free" => {
                self.heap_free(a0);
                0
            }
            "SDL_memcpy" => {
                if a0 != 0 && a1 != 0 && a2 > 0 {
                    let mut buf = vec![0u8; a2 as usize];
                    if vmm.read_bytes(a1, &mut buf).is_ok() {
                        let _ = vmm.write_bytes(a0, &buf);
                    }
                }
                a0
            }
            "SDL_strlen" => vmm.read_c_string(a0, 0x10000).map(|s| s.len() as u64).unwrap_or(0),
            "SDL_wcslen" => vmm
                .read_wide_string(a0, 0x10000)
                .map(|s| s.len() as u64)
                .unwrap_or(0),
            "SDL_iconv_string" => {
                // char *SDL_iconv_string(tocode=a0, fromcode=a1, inbuf=a2, inbytesleft=a3)
                let to = self.read_ansi(vmm, a0).to_ascii_uppercase();
                let from = self.read_ansi(vmm, a1).to_ascii_uppercase();
                let mut raw = vec![0u8; a3 as usize];
                if a2 == 0 || vmm.read_bytes(a2, &mut raw).is_err() {
                    return 0;
                }
                let mut chars: Vec<char> = Vec::new();
                if from.contains("UTF-16") || from.contains("UTF_16") {
                    let units: Vec<u16> = raw
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    for ch in char::decode_utf16(units.into_iter()) {
                        chars.push(ch.unwrap_or('\u{fffd}'));
                    }
                } else if from.contains("UTF-32") {
                    for c in raw.chunks_exact(4) {
                        let v = u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
                        chars.push(char::from_u32(v).unwrap_or('\u{fffd}'));
                    }
                } else {
                    // UTF-8 / ASCII / ANSI: bytes are treated as UTF-8 with Latin-1 fallback.
                    match std::str::from_utf8(&raw) {
                        Ok(s) => chars.extend(s.chars()),
                        Err(_) => chars.extend(raw.iter().map(|&b| b as char)),
                    }
                }
                let mut out: Vec<u8> = Vec::new();
                if to.contains("UTF-16") {
                    let mut buf = [0u16; 2];
                    for ch in chars {
                        for u in ch.encode_utf16(&mut buf) {
                            out.extend_from_slice(&u.to_le_bytes());
                        }
                    }
                    out.extend_from_slice(&[0, 0]);
                } else if to.contains("UTF-32") {
                    for ch in chars {
                        out.extend_from_slice(&(ch as u32).to_le_bytes());
                    }
                    out.extend_from_slice(&[0, 0, 0, 0]);
                } else {
                    let s: String = chars.into_iter().collect();
                    out.extend_from_slice(s.as_bytes());
                    out.push(0);
                }
                let p = self.heap_alloc(vmm, self.process_heap, out.len() as u64);
                if p != 0 {
                    let _ = vmm.write_bytes(p, &out);
                }
                p
            }
            "SDL_qsort" => {
                // Needs guest comparator upcalls, which the HLE upcall path does not model yet.
                self.note(
                    "K SDL_qsort called but NOT sorted (guest comparator upcall unimplemented)"
                        .to_string(),
                );
                0
            }
            // ---------------------------------------------------------- video / window
            "SDL_GetNumVideoDisplays" => 1,
            "SDL_GetCurrentDisplayMode" | "SDL_GetDesktopDisplayMode" | "SDL_GetDisplayMode" => {
                let mode = if symbol == "SDL_GetDisplayMode" { a2 } else { a1 };
                if mode != 0 {
                    // SDL_DisplayMode {Uint32 format; int w; int h; int refresh_rate; void *driverdata}
                    let _ = vmm.write_u32(mode, PF_ARGB8888);
                    let _ = vmm.write_u32(mode + 4, 1920);
                    let _ = vmm.write_u32(mode + 8, 1080);
                    let _ = vmm.write_u32(mode + 12, 60);
                    let _ = vmm.write_u64(mode + 16, 0);
                }
                0
            }
            "SDL_GetDisplayBounds" | "SDL_GetDisplayUsableBounds" => {
                if a1 != 0 {
                    let _ = vmm.write_bytes(a1, &[0u8; 16]);
                    let _ = vmm.write_u32(a1 + 8, 1920);
                    let _ = vmm.write_u32(a1 + 12, 1080);
                }
                0
            }
            "SDL_CreateWindow" => {
                let w = a3 as i32;
                let h = a4 as i32;
                let win = self.heap_alloc(vmm, self.process_heap, 64);
                if win == 0 {
                    return 0;
                }
                let id = self.sdl.next_window_id;
                self.sdl.next_window_id += 1;
                let (w, h) = (if w > 0 { w } else { 640 }, if h > 0 { h } else { 480 });
                let bb_pitch = w * 4;
                let backbuffer =
                    self.heap_alloc(vmm, self.process_heap, (bb_pitch as u64) * (h as u64));
                if backbuffer != 0 {
                    let _ = vmm.write_bytes(
                        backbuffer,
                        &vec![0u8; (bb_pitch as usize) * (h as usize)],
                    );
                }
                self.sdl.windows.insert(
                    win,
                    SdlWindowInfo {
                        w,
                        h,
                        id,
                        surface: 0,
                        backbuffer,
                        bb_pitch,
                    },
                );
                win
            }
            "SDL_DestroyWindow" => {
                self.sdl.windows.remove(&a0);
                0
            }
            "SDL_GetWindowID" => self
                .sdl
                .windows
                .get(&a0)
                .map(|w| w.id as u64)
                .unwrap_or(0),
            "SDL_GetWindowFlags" => 0x4, // SDL_WINDOW_SHOWN
            "SDL_GetWindowDisplayIndex" => 0,
            "SDL_GetWindowSize" => {
                if let Some(w) = self.sdl.windows.get(&a0) {
                    if a1 != 0 {
                        let _ = vmm.write_u32(a1, w.w as u32);
                    }
                    if a2 != 0 {
                        let _ = vmm.write_u32(a2, w.h as u32);
                    }
                }
                0
            }
            "SDL_SetWindowSize" => {
                let (nw, nh) = (a1 as i32, a2 as i32);
                let need_realloc = match self.sdl.windows.get(&a0) {
                    Some(w) => w.w != nw || w.h != nh,
                    None => false,
                };
                if need_realloc && nw > 0 && nh > 0 {
                    let bb_pitch = nw * 4;
                    let backbuffer =
                        self.heap_alloc(vmm, self.process_heap, (bb_pitch as u64) * (nh as u64));
                    if backbuffer != 0 {
                        let _ = vmm.write_bytes(
                            backbuffer,
                            &vec![0u8; (bb_pitch as usize) * (nh as usize)],
                        );
                    }
                    if let Some(w) = self.sdl.windows.get_mut(&a0) {
                        w.w = nw;
                        w.h = nh;
                        w.backbuffer = backbuffer;
                        w.bb_pitch = bb_pitch;
                        w.surface = 0; // force GetWindowSurface to re-wrap the new backbuffer
                    }
                }
                0
            }
            "SDL_SetWindowTitle" | "SDL_SetWindowMinimumSize" | "SDL_SetWindowIcon"
            | "SDL_SetWindowPosition" | "SDL_SetWindowBordered" | "SDL_ShowWindow"
            | "SDL_HideWindow" | "SDL_RaiseWindow" => 0,
            "SDL_SetWindowFullscreen" => 0,
            "SDL_GetWindowSurface" => {
                let (w, h, existing, backbuffer, bb_pitch) = match self.sdl.windows.get(&a0) {
                    Some(info) => (info.w, info.h, info.surface, info.backbuffer, info.bb_pitch),
                    None => return 0,
                };
                if existing != 0 {
                    return existing;
                }
                // The window surface aliases the renderer backbuffer: pixels the guest writes
                // through either API are the same bytes SDL_RenderPresent captures.
                let surf = if backbuffer != 0 {
                    self.sdl_new_surface(
                        vmm,
                        w,
                        h,
                        PF_ARGB8888,
                        None,
                        Some(backbuffer),
                        Some(bb_pitch),
                    )
                } else {
                    self.sdl_new_surface(vmm, w, h, PF_ARGB8888, None, None, None)
                };
                if let Some(info) = self.sdl.windows.get_mut(&a0) {
                    info.surface = surf;
                }
                surf
            }
            "SDL_UpdateWindowSurface" | "SDL_UpdateWindowSurfaceRects" => {
                if let Some(info) = self.sdl.windows.get(&a0).cloned() {
                    if info.surface != 0 {
                        self.sdl_present_surface(vmm, info.surface);
                    }
                }
                0
            }
            // ---------------------------------------------------------- renderer / texture
            "SDL_CreateRenderer" => {
                if !self.sdl.windows.contains_key(&a0) {
                    return 0;
                }
                let r = self.heap_alloc(vmm, self.process_heap, 64);
                if r == 0 {
                    return 0;
                }
                self.sdl.renderers.insert(
                    r,
                    SdlRendererInfo {
                        window: a0,
                        target: 0,
                        draw_color: [0, 0, 0, 255],
                    },
                );
                r
            }
            "SDL_DestroyRenderer" => {
                self.sdl.renderers.remove(&a0);
                0
            }
            "SDL_GetRendererInfo" => {
                if self.sdl.renderer_name == 0 {
                    let p = self.heap_alloc(vmm, self.process_heap, 20);
                    if p != 0 {
                        let _ = self.write_ansi(vmm, p, "porthole-software");
                    }
                    self.sdl.renderer_name = p;
                }
                if a1 != 0 {
                    // SDL_RendererInfo {const char *name; Uint32 flags; Uint32 num_texture_formats;
                    // Uint32 texture_formats[16]; int max_texture_width; int max_texture_height}
                    let _ = vmm.write_u64(a1, self.sdl.renderer_name);
                    let _ = vmm.write_u32(a1 + 8, 0x1); // SDL_RENDERER_SOFTWARE
                    let _ = vmm.write_u32(a1 + 12, 1);
                    let _ = vmm.write_u32(a1 + 16, PF_ARGB8888);
                    let _ = vmm.write_u32(a1 + 80, 8192);
                    let _ = vmm.write_u32(a1 + 84, 8192);
                }
                0
            }
            "SDL_GetRendererOutputSize" => {
                if let Some(r) = self.sdl.renderers.get(&a0).cloned() {
                    if let Some(w) = self.sdl.windows.get(&r.window) {
                        if a1 != 0 {
                            let _ = vmm.write_u32(a1, w.w as u32);
                        }
                        if a2 != 0 {
                            let _ = vmm.write_u32(a2, w.h as u32);
                        }
                    }
                }
                0
            }
            "SDL_CreateTexture" => {
                let format = a1 as u32;
                let w = a3 as i32;
                let h = a4 as i32;
                let bpp = bpp_for_format(format);
                let pitch = w * bpp as i32;
                let size = (pitch.max(0) as u64) * (h.max(0) as u64);
                let pixels = self.heap_alloc(vmm, self.process_heap, size.max(4));
                if pixels != 0 && size > 0 {
                    let _ = vmm.write_bytes(pixels, &vec![0u8; size as usize]);
                }
                let tex = self.heap_alloc(vmm, self.process_heap, 64);
                if tex == 0 {
                    return 0;
                }
                self.sdl.textures.insert(
                    tex,
                    SdlTextureInfo {
                        w,
                        h,
                        format,
                        pixels,
                        pitch,
                    },
                );
                tex
            }
            "SDL_CreateTextureFromSurface" => {
                let s = match self.sdl.surfaces.get(&a1).cloned() {
                    Some(s) => s,
                    None => return 0,
                };
                let tex = self.heap_alloc(vmm, self.process_heap, 64);
                if tex == 0 {
                    return 0;
                }
                // Texture pixels live in their own buffer seeded from the surface.
                let size = (s.pitch.max(0) as u64) * (s.h.max(0) as u64);
                let pixels = self.heap_alloc(vmm, self.process_heap, size.max(4));
                if pixels != 0 && size > 0 {
                    let mut buf = vec![0u8; size as usize];
                    if vmm.read_bytes(s.pixels, &mut buf).is_ok() {
                        let _ = vmm.write_bytes(pixels, &buf);
                    }
                }
                self.sdl.textures.insert(
                    tex,
                    SdlTextureInfo {
                        w: s.w,
                        h: s.h,
                        format: s.format,
                        pixels,
                        pitch: s.pitch,
                    },
                );
                tex
            }
            "SDL_DestroyTexture" => {
                self.sdl.textures.remove(&a0);
                0
            }
            "SDL_QueryTexture" => {
                if let Some(t) = self.sdl.textures.get(&a0) {
                    if a1 != 0 {
                        let _ = vmm.write_u32(a1, t.format);
                    }
                    if a2 != 0 {
                        let _ = vmm.write_u32(a2, 1); // SDL_TEXTUREACCESS_STREAMING
                    }
                    if a3 != 0 {
                        let _ = vmm.write_u32(a3, t.w as u32);
                    }
                    if a4 != 0 {
                        let _ = vmm.write_u32(a4, t.h as u32);
                    }
                    0
                } else {
                    (-1i64) as u64
                }
            }
            "SDL_LockTexture" => {
                // (texture, rect*, void **pixels, int *pitch)
                match self.sdl.textures.get(&a0).cloned() {
                    Some(t) => {
                        let mut ptr = t.pixels;
                        if a1 != 0 {
                            let rx = vmm.read_u32(a1).unwrap_or(0) as i32;
                            let ry = vmm.read_u32(a1 + 4).unwrap_or(0) as i32;
                            let bpp = bpp_for_format(t.format) as i32;
                            ptr += (ry.max(0) as u64) * (t.pitch.max(0) as u64)
                                + (rx.max(0) as u64) * (bpp as u64);
                        }
                        if a2 != 0 {
                            let _ = vmm.write_u64(a2, ptr);
                        }
                        if a3 != 0 {
                            let _ = vmm.write_u32(a3, t.pitch as u32);
                        }
                        0
                    }
                    None => (-1i64) as u64,
                }
            }
            "SDL_UnlockTexture" => 0,
            "SDL_UpdateTexture" => {
                // (texture, rect*, pixels, pitch)
                if let Some(t) = self.sdl.textures.get(&a0).cloned() {
                    let (rx, ry, rw, rh) = if a1 != 0 {
                        (
                            vmm.read_u32(a1).unwrap_or(0) as i32,
                            vmm.read_u32(a1 + 4).unwrap_or(0) as i32,
                            vmm.read_u32(a1 + 8).unwrap_or(0) as i32,
                            vmm.read_u32(a1 + 12).unwrap_or(0) as i32,
                        )
                    } else {
                        (0, 0, t.w, t.h)
                    };
                    let bpp = bpp_for_format(t.format) as usize;
                    let src_pitch = a3 as usize;
                    let row_bytes = (rw.max(0) as usize) * bpp;
                    for row in 0..rh.max(0) as usize {
                        let src = a2 + (row * src_pitch) as u64;
                        let dst = t.pixels
                            + ((ry + row as i32).max(0) as u64) * (t.pitch.max(0) as u64)
                            + (rx.max(0) as usize * bpp) as u64;
                        let mut buf = vec![0u8; row_bytes];
                        if vmm.read_bytes(src, &mut buf).is_ok() {
                            let _ = vmm.write_bytes(dst, &buf);
                        }
                    }
                    0
                } else {
                    (-1i64) as u64
                }
            }
            "SDL_SetRenderTarget" => {
                if let Some(r) = self.sdl.renderers.get_mut(&a0) {
                    r.target = a1;
                }
                0
            }
            "SDL_SetRenderDrawColor" => {
                if let Some(r) = self.sdl.renderers.get_mut(&a0) {
                    r.draw_color = [a1 as u8, a2 as u8, a3 as u8, a4 as u8];
                }
                0
            }
            "SDL_GetRenderDrawColor" => 0,
            "SDL_RenderClear" => {
                // Fill the current destination (target texture or window backbuffer) with the
                // guest-issued draw colour.
                if let Some(r) = self.sdl.renderers.get(&a0).cloned() {
                    if let Some(dst) = self.sdl_dst_pixbuf(&r) {
                        self.sdl_fill_pixbuf(vmm, &dst, r.draw_color);
                    }
                }
                0
            }
            "SDL_RenderCopy" | "SDL_RenderCopyEx" => {
                // Real scaled blit of the guest texture into the current destination
                // (RenderCopyEx rotation/flip are not modelled; Chocolate Doom uses plain
                // RenderCopy). NULL srcrect = whole texture; NULL dstrect = whole destination.
                if let Some(r) = self.sdl.renderers.get(&a0).cloned() {
                    if let (Some(src), Some(dst)) =
                        (self.sdl_tex_pixbuf(a1), self.sdl_dst_pixbuf(&r))
                    {
                        let mut read_rect = |p: u64, full: (i32, i32)| -> (i32, i32, i32, i32) {
                            if p != 0 {
                                (
                                    vmm.read_u32(p).unwrap_or(0) as i32,
                                    vmm.read_u32(p + 4).unwrap_or(0) as i32,
                                    vmm.read_u32(p + 8).unwrap_or(0) as i32,
                                    vmm.read_u32(p + 12).unwrap_or(0) as i32,
                                )
                            } else {
                                (0, 0, full.0, full.1)
                            }
                        };
                        let srect = read_rect(a2, (src.w, src.h));
                        let drect = read_rect(a3, (dst.w, dst.h));
                        self.sdl_render_blit(vmm, &src, srect, &dst, drect);
                    }
                }
                0
            }
            "SDL_RenderPresent" => {
                // THE Gate 2 present: capture the window BACKBUFFER — the bytes composed solely
                // from the guest's own RenderClear/RenderCopy draws this frame. (The previous
                // implementation captured the last RenderCopy *source* texture while RenderCopy
                // moved no pixels, yielding a constant clear-colour checksum for 2,703 frames;
                // the checksum-evolution evidence exposed that, and the compositor above is the
                // fix.) No host pixel is ever introduced; the counter advances only here.
                if let Some(r) = self.sdl.renderers.get(&a0).cloned() {
                    if let Some(w) = self.sdl.windows.get(&r.window).cloned() {
                        if w.backbuffer != 0 {
                            self.sdl_capture_pixels(
                                vmm,
                                w.backbuffer,
                                w.w,
                                w.h,
                                w.bb_pitch,
                                4,
                                masks_for_format(PF_ARGB8888),
                                0,
                            );
                        }
                    }
                }
                0
            }
            "SDL_RenderSetLogicalSize" | "SDL_RenderSetIntegerScale" | "SDL_RenderSetScale"
            | "SDL_RenderSetViewport" | "SDL_SetTextureBlendMode" | "SDL_SetTextureScaleMode"
            | "SDL_SetTextureColorMod" | "SDL_SetTextureAlphaMod" => 0,
            // ---------------------------------------------------------- surfaces
            "SDL_CreateRGBSurface" => {
                // (flags, w, h, depth, Rmask, Gmask, Bmask, Amask)
                let depth = a3 as i32;
                let masks = (a4 as u32, a5 as u32, args[6] as u32, args[7] as u32);
                let format = format_for_masks(depth, masks.0, masks.1, masks.2, masks.3);
                self.sdl_new_surface(vmm, a1 as i32, a2 as i32, format, Some(masks), None, None)
            }
            "SDL_CreateRGBSurfaceWithFormat" => {
                self.sdl_new_surface(vmm, a1 as i32, a2 as i32, a4 as u32, None, None, None)
            }
            "SDL_CreateRGBSurfaceFrom" => {
                // (pixels, w, h, depth, pitch, Rmask, Gmask, Bmask, Amask)
                let depth = a3 as i32;
                let masks = (a5 as u32, args[6] as u32, args[7] as u32, args[8] as u32);
                let format = format_for_masks(depth, masks.0, masks.1, masks.2, masks.3);
                self.sdl_new_surface(
                    vmm,
                    a1 as i32,
                    a2 as i32,
                    format,
                    Some(masks),
                    Some(a0),
                    Some(a4 as i32),
                )
            }
            "SDL_CreateRGBSurfaceWithFormatFrom" => self.sdl_new_surface(
                vmm,
                a1 as i32,
                a2 as i32,
                a5 as u32,
                None,
                Some(a0),
                Some(a4 as i32),
            ),
            "SDL_FreeSurface" => {
                if let Some(s) = self.sdl.surfaces.remove(&a0) {
                    let _ = s;
                }
                0
            }
            "SDL_LockSurface" | "SDL_UnlockSurface" => 0,
            "SDL_SetSurfacePalette" => 0,
            "SDL_SetPaletteColors" => {
                // (SDL_Palette *a0, const SDL_Color *a1, firstcolor=a2, ncolors=a3)
                if a0 != 0 && a1 != 0 {
                    let colors = vmm.read_u64(a0 + 8).unwrap_or(0);
                    if colors != 0 {
                        let n = (a3 as usize).min(256);
                        let mut buf = vec![0u8; n * 4];
                        if vmm.read_bytes(a1, &mut buf).is_ok() {
                            let _ = vmm.write_bytes(colors + (a2 as u64) * 4, &buf);
                        }
                    }
                }
                0
            }
            "SDL_FillRect" => {
                if let Some(s) = self.sdl.surfaces.get(&a0).cloned() {
                    let (rx, ry, rw, rh) = if a1 != 0 {
                        (
                            vmm.read_u32(a1).unwrap_or(0) as i32,
                            vmm.read_u32(a1 + 4).unwrap_or(0) as i32,
                            vmm.read_u32(a1 + 8).unwrap_or(0) as i32,
                            vmm.read_u32(a1 + 12).unwrap_or(0) as i32,
                        )
                    } else {
                        (0, 0, s.w, s.h)
                    };
                    let color = a2 as u32;
                    let bpp = s.bpp as usize;
                    let mut row = vec![0u8; (rw.max(0) as usize) * bpp];
                    for i in 0..rw.max(0) as usize {
                        row[i * bpp..i * bpp + bpp.min(4)]
                            .copy_from_slice(&color.to_le_bytes()[..bpp.min(4)]);
                    }
                    for yy in 0..rh.max(0) {
                        let dst = s.pixels
                            + ((ry + yy).max(0) as u64) * (s.pitch.max(0) as u64)
                            + (rx.max(0) as usize * bpp) as u64;
                        let _ = vmm.write_bytes(dst, &row);
                    }
                }
                0
            }
            "SDL_UpperBlit" | "SDL_LowerBlit" | "SDL_UpperBlitScaled" | "SDL_LowerBlitScaled" => {
                // SDL_BlitSurface(src=a0, srcrect=a1, dst=a2, dstrect=a3)
                let (src, dst) = match (
                    self.sdl.surfaces.get(&a0).cloned(),
                    self.sdl.surfaces.get(&a2).cloned(),
                ) {
                    (Some(s), Some(d)) => (s, d),
                    _ => return (-1i64) as u64,
                };
                let (sx, sy, sw, sh) = if a1 != 0 {
                    (
                        vmm.read_u32(a1).unwrap_or(0) as i32,
                        vmm.read_u32(a1 + 4).unwrap_or(0) as i32,
                        vmm.read_u32(a1 + 8).unwrap_or(0) as i32,
                        vmm.read_u32(a1 + 12).unwrap_or(0) as i32,
                    )
                } else {
                    (0, 0, src.w, src.h)
                };
                let (dx, dy) = if a3 != 0 {
                    (
                        vmm.read_u32(a3).unwrap_or(0) as i32,
                        vmm.read_u32(a3 + 4).unwrap_or(0) as i32,
                    )
                } else {
                    (0, 0)
                };
                if src.format == dst.format {
                    let bpp = src.bpp as usize;
                    let row_bytes = (sw.max(0) as usize) * bpp;
                    for row in 0..sh.max(0) {
                        let saddr = src.pixels
                            + ((sy + row).max(0) as u64) * (src.pitch.max(0) as u64)
                            + (sx.max(0) as usize * bpp) as u64;
                        let daddr = dst.pixels
                            + ((dy + row).max(0) as u64) * (dst.pitch.max(0) as u64)
                            + (dx.max(0) as usize * bpp) as u64;
                        let mut buf = vec![0u8; row_bytes];
                        if vmm.read_bytes(saddr, &mut buf).is_ok() {
                            let _ = vmm.write_bytes(daddr, &buf);
                        }
                    }
                } else if src.bpp == 1 && dst.bpp == 4 {
                    // Indexed -> 32-bit conversion via the source palette.
                    let mut cols = [[0u8; 4]; 256];
                    if src.palette != 0 {
                        let colors = vmm.read_u64(src.palette + 8).unwrap_or(0);
                        let mut buf = [0u8; 256 * 4];
                        if colors != 0 && vmm.read_bytes(colors, &mut buf).is_ok() {
                            for i in 0..256 {
                                cols[i] = [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], buf[i * 4 + 3]];
                            }
                        }
                    }
                    for row in 0..sh.max(0) {
                        let mut srow = vec![0u8; sw.max(0) as usize];
                        let saddr = src.pixels
                            + ((sy + row).max(0) as u64) * (src.pitch.max(0) as u64)
                            + sx.max(0) as u64;
                        if vmm.read_bytes(saddr, &mut srow).is_err() {
                            continue;
                        }
                        let mut drow = vec![0u8; (sw.max(0) as usize) * 4];
                        for (i, &idx) in srow.iter().enumerate() {
                            let c = cols[idx as usize];
                            let v = (c[3] as u32) << 24
                                | (c[0] as u32) << 16
                                | (c[1] as u32) << 8
                                | c[2] as u32;
                            drow[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
                        }
                        let daddr = dst.pixels
                            + ((dy + row).max(0) as u64) * (dst.pitch.max(0) as u64)
                            + (dx.max(0) as u64) * 4;
                        let _ = vmm.write_bytes(daddr, &drow);
                    }
                } else {
                    self.note(format!(
                        "K SDL blit with unmodelled conversion {:#x} -> {:#x} (skipped)",
                        src.format, dst.format
                    ));
                }
                0
            }
            // ---------------------------------------------------------- events / input
            "SDL_PollEvent" => 0,
            "SDL_PeepEvents" => 0,
            "SDL_WaitEvent" => {
                // No input devices exist. Returning 0 (error) makes event loops fall through to
                // their tick path instead of deadlocking on a wait that can never complete.
                0
            }
            "SDL_PumpEvents" | "SDL_FlushEvent" | "SDL_FlushEvents" => 0,
            "SDL_GetMouseState" | "SDL_GetRelativeMouseState" | "SDL_GetGlobalMouseState" => {
                if a0 != 0 {
                    let _ = vmm.write_u32(a0, 0);
                }
                if a1 != 0 {
                    let _ = vmm.write_u32(a1, 0);
                }
                0
            }
            "SDL_WarpMouseInWindow" | "SDL_SetRelativeMouseMode" | "SDL_ShowCursor" => 0,
            "SDL_GetModState" => 0,
            "SDL_GetKeyFromScancode" => a0,
            "SDL_GetKeyName" => self.sdl_empty_str(vmm),
            "SDL_StartTextInput" | "SDL_StopTextInput" => 0,
            "SDL_IsTextInputActive" => 0,
            // Joysticks: none attached — every query is answered from the empty device set.
            "SDL_NumJoysticks" | "SDL_IsGameController" | "SDL_JoystickNumAxes"
            | "SDL_JoystickNumHats" | "SDL_JoystickGetAxis" | "SDL_JoystickGetButton"
            | "SDL_JoystickGetHat" | "SDL_GameControllerGetAxis" | "SDL_GameControllerGetButton"
            | "SDL_GameControllerTypeForIndex" | "SDL_JoystickOpen" | "SDL_GameControllerOpen"
            | "SDL_JoystickEventState" | "SDL_GameControllerEventState" => 0,
            "SDL_JoystickName" | "SDL_GameControllerName" => self.sdl_empty_str(vmm),
            "SDL_JoystickGetGUIDFromString" => {
                // SDL_JoystickGUID is a 16-byte struct returned by value in RDX:RAX; the kernel
                // dispatch only sets RAX, so a zero GUID in RAX is all we can hand back (the
                // guest only reaches this with a configured joystick, which cannot exist here).
                0
            }
            "SDL_JoystickGetDeviceGUID" => 0,
            "SDL_JoystickGetGUIDString" => {
                // (guid, char *pszGUID=a2 by value quirk: signature is
                //  void SDL_JoystickGetGUIDString(SDL_JoystickGUID, char*, int)) — argv layout
                //  puts the buffer in the third slot due to struct-by-value.
                0
            }
            "SDL_JoystickClose" | "SDL_GameControllerClose" => 0,
            // ---------------------------------------------------------- threads / audio
            "SDL_CreateMutex" | "SDL_CreateCond" | "SDL_CreateSemaphore" => {
                self.heap_alloc(vmm, self.process_heap, 32)
            }
            "SDL_LockMutex" | "SDL_UnlockMutex" | "SDL_TryLockMutex" | "SDL_CondSignal"
            | "SDL_CondBroadcast" | "SDL_CondWait" | "SDL_DestroyMutex" | "SDL_DestroyCond"
            | "SDL_DestroySemaphore" => 0,
            "SDL_CreateThread" => {
                // Guest thread bodies are not scheduled by the emulator (named limitation also
                // recorded for Tier A). Returning NULL makes SDL-threaded audio paths report
                // failure instead of running half-parallel.
                self.note(
                    "K SDL_CreateThread -> NULL (guest thread bodies are not scheduled)"
                        .to_string(),
                );
                0
            }
            "SDL_WaitThread" => {
                if a1 != 0 {
                    let _ = vmm.write_u32(a1, 0);
                }
                0
            }
            "SDL_PauseAudio" | "SDL_CloseAudio" | "SDL_LockAudio" | "SDL_UnlockAudio" => 0,
            "SDL_BuildAudioCVT" => {
                if a0 != 0 {
                    let _ = vmm.write_u32(a0, 0); // needed = 0: no conversion required
                }
                0
            }
            "SDL_ConvertAudio" => {
                self.note("K SDL_ConvertAudio: no-op (formats declared identical)".to_string());
                0
            }
            "SDL_MixAudioFormat" => {
                // Mixing silence over silence: leave destination untouched.
                0
            }
            _ => {
                self.note(format!("K SDL unimplemented {symbol} -> 0"));
                0
            }
        }
    }
}
