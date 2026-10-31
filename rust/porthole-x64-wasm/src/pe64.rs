use crate::jit::HybridWasmJit;
use iced_x86::{Decoder, DecoderOptions, FlowControl};
use crate::vmm::{
    VirtualMemoryManager, MEM_COMMIT, MEM_IMAGE, MEM_PRIVATE, PAGE_EXECUTE_READ,
    PAGE_EXECUTE_READWRITE, PAGE_READONLY, PAGE_READWRITE,
};

pub const THUNK_BASE: u64 = 0x0000_7FF0_0000_0000;
pub const THUNK_STRIDE: u64 = 16;
/// Import stubs (`__imp_` IAT slots patched at load time) live here, in import-table order.
pub const IMPORT_THUNK_BASE: u64 = THUNK_BASE + 0x0000_1000;
/// `GetProcAddress` stubs live in their own pool. They used to be hashed into the *import*
/// pool, which aliased ~1 in 4096 unrelated exports onto an import stub and - worse - was never
/// registered in the callable-thunk table, so calling a resolved pointer faulted with
/// `unmapped thunk 0x7ff0...`.
pub const EXPORT_THUNK_BASE: u64 = THUNK_BASE + 0x0001_0000; // 0x1000..0x10000 is imports
pub const EXPORT_THUNK_END: u64 = THUNK_BASE + THUNK_REGION_SIZE - 0x0000_1000;
pub const THUNK_REGION_SIZE: u64 = 0x0002_0000; // 8192 thunks
pub const EXIT_THUNK_ADDR: u64 = THUNK_BASE;
pub const THREAD_EXIT_THUNK_ADDR: u64 = THUNK_BASE + THUNK_STRIDE;

pub const PEB_ADDR: u64 = 0x0000_7FFE_0001_0000;
pub const PROCESS_HEAP_ADDR: u64 = 0x0000_0000_0060_0000;
pub const PROC_PARAMS_ADDR: u64 = 0x0000_7FFE_0001_1000;
pub const CURDIR_BUF_ADDR: u64 = 0x0000_7FFE_0001_1800;
pub const MAIN_TEB_ADDR: u64 = 0x0000_7FFE_0002_0000;
pub const CURDIR_HANDLE: u64 = 0x0000_0000_0000_0CD0;

pub const MAIN_STACK_BOTTOM: u64 = 0x0000_0000_0200_0000;
pub const MAIN_STACK_TOP: u64 = 0x0000_0000_0220_0000;

#[derive(Debug, Clone)]
pub struct LoadedPe64Info {
    pub image_base: u64,
    pub size_of_image: u64,
    pub entry_point: u64,
    pub text_base: u64,
    pub text_size: u64,
    pub import_count: usize,
    pub aot_blocks_compiled: usize,
    pub aot_bytes_compiled: usize,
    pub aot_instructions_scanned: usize,
    pub tls_callbacks: Vec<u64>,
    pub resources: Vec<PeResource>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceKey {
    Id(u32),
    Name(String),
}

#[derive(Debug, Clone)]
pub struct PeResource {
    pub type_key: ResourceKey,
    pub name_key: ResourceKey,
    pub language: u16,
    pub data_rva: u32,
    pub size: u32,
}

#[derive(Debug, Clone)]
pub struct ImportBinding {
    pub dll: String,
    pub symbol: String,
    pub ordinal: u16,
    pub iat_va: u64,
}

fn read_le_u16(b: &[u8], off: usize) -> Option<u16> {
    b.get(off..off + 2)
        .map(|s| u16::from_le_bytes(s.try_into().unwrap()))
}

fn read_le_u32(b: &[u8], off: usize) -> Option<u32> {
    b.get(off..off + 4)
        .map(|s| u32::from_le_bytes(s.try_into().unwrap()))
}

fn read_le_u64(b: &[u8], off: usize) -> Option<u64> {
    b.get(off..off + 8)
        .map(|s| u64::from_le_bytes(s.try_into().unwrap()))
}

fn rva_to_offset(sections: &[(u64, u64, u64, u64)], b: &[u8], rva: u64) -> Option<usize> {
    for &(va, vsize, raw, rsize) in sections {
        let span = vsize.max(rsize);
        if rva >= va && rva < va + span {
            let off = raw + (rva - va);
            if off < b.len() as u64 {
                return Some(off as usize);
            }
        }
    }
    None
}

fn read_resource_name(b: &[u8], off: usize) -> String {
    let len = match read_le_u16(b, off) {
        Some(v) => v as usize,
        None => return String::new(),
    };
    let mut units = Vec::with_capacity(len.min(512));
    for i in 0..len.min(512) {
        match read_le_u16(b, off + 2 + i * 2) {
            Some(v) => units.push(v),
            None => break,
        }
    }
    String::from_utf16_lossy(&units)
}

fn walk_resource_dir(
    b: &[u8],
    sections: &[(u64, u64, u64, u64)],
    base: usize,
    dir_off: usize,
    level: u8,
    ty: Option<ResourceKey>,
    nm: Option<ResourceKey>,
    out: &mut Vec<PeResource>,
) {
    if level > 2 || out.len() >= 8192 {
        return;
    }
    let named = read_le_u16(b, dir_off + 12).unwrap_or(0) as usize;
    let ids = read_le_u16(b, dir_off + 14).unwrap_or(0) as usize;
    let count = named.saturating_add(ids).min(4096);
    for i in 0..count {
        let ent = dir_off + 16 + i * 8;
        let name_raw = match read_le_u32(b, ent) { Some(v) => v, None => break };
        let off_raw = match read_le_u32(b, ent + 4) { Some(v) => v, None => break };
        let key = if name_raw & 0x8000_0000 != 0 {
            ResourceKey::Name(read_resource_name(b, base + (name_raw & 0x7FFF_FFFF) as usize))
        } else {
            ResourceKey::Id(name_raw & 0xFFFF)
        };
        if off_raw & 0x8000_0000 != 0 {
            let (nt, nn) = match level {
                0 => (Some(key), None),
                1 => (ty.clone(), Some(key)),
                _ => (ty.clone(), nm.clone()),
            };
            walk_resource_dir(b, sections, base, base + (off_raw & 0x7FFF_FFFF) as usize, level + 1, nt, nn, out);
        } else if level == 2 {
            if let (Some(t), Some(n), ResourceKey::Id(lang)) = (ty.clone(), nm.clone(), key) {
                let data_ent = base + off_raw as usize;
                let data_rva = read_le_u32(b, data_ent).unwrap_or(0);
                let size = read_le_u32(b, data_ent + 4).unwrap_or(0);
                if data_rva != 0 && rva_to_offset(sections, b, data_rva as u64).is_some() {
                    out.push(PeResource { type_key: t, name_key: n, language: lang as u16, data_rva, size });
                }
            }
        }
        if out.len() >= 8192 { break; }
    }
}

fn parse_pe_resources(b: &[u8], sections: &[(u64, u64, u64, u64)], rva: u32, _size: u32) -> Vec<PeResource> {
    let mut out = Vec::new();
    if rva == 0 { return out; }
    if let Some(base) = rva_to_offset(sections, b, rva as u64) {
        walk_resource_dir(b, sections, base, base, 0, None, None, &mut out);
    }
    out
}

pub fn load_pe64_image<F>(
    pe_bytes: &[u8],
    vmm: &mut VirtualMemoryManager,
    jit: &mut HybridWasmJit,
    mut bind_import: F,
) -> Result<(LoadedPe64Info, Vec<ImportBinding>), String>
where
    F: FnMut(&str, &str, u16) -> u64,
{
    if pe_bytes.len() < 0x100 {
        return Err("PE image too small".to_string());
    }
    let mz = read_le_u16(pe_bytes, 0).ok_or("Missing MZ")?;
    if mz != 0x5A4D {
        return Err(format!("Invalid DOS signature 0x{mz:04x}"));
    }
    let lfanew = read_le_u32(pe_bytes, 0x3C).ok_or("Missing e_lfanew")? as usize;
    let pe_sig = read_le_u32(pe_bytes, lfanew).ok_or("Invalid e_lfanew")?;
    if pe_sig != 0x0000_4550 {
        return Err(format!("Invalid PE signature 0x{pe_sig:08x}"));
    }

    let coff = lfanew + 4;
    let machine = read_le_u16(pe_bytes, coff).ok_or("Missing Machine")?;
    if machine != 0x8664 {
        return Err(format!(
            "Expected x86-64 PE32+ (0x8664), got 0x{machine:04x}"
        ));
    }
    let num_sections = read_le_u16(pe_bytes, coff + 2).ok_or("Missing NumberOfSections")? as usize;
    let size_opt_hdr =
        read_le_u16(pe_bytes, coff + 16).ok_or("Missing SizeOfOptionalHeader")? as usize;

    let opt = coff + 20;
    let opt_magic = read_le_u16(pe_bytes, opt).ok_or("Missing OptionalHeader Magic")?;
    if opt_magic != 0x020B {
        return Err(format!(
            "Expected PE32+ OptionalHeader magic 0x020B, got 0x{opt_magic:04x}"
        ));
    }

    let entry_rva = read_le_u32(pe_bytes, opt + 16).ok_or("Missing AddressOfEntryPoint")? as u64;
    let preferred_base = read_le_u64(pe_bytes, opt + 24).ok_or("Missing ImageBase")?;
    let image_base = if preferred_base >= 0x10000 {
        preferred_base
    } else {
        0x0000_0001_4000_0000
    };
    let size_of_image = read_le_u32(pe_bytes, opt + 56).ok_or("Missing SizeOfImage")? as u64;
    let size_of_headers =
        read_le_u32(pe_bytes, opt + 60).ok_or("Missing SizeOfHeaders")? as usize;
    let num_rva = read_le_u32(pe_bytes, opt + 108).unwrap_or(16) as usize;

    // Map full image span in VMM (pinned so CRT/code headers stay hot unless dynamic heap swaps)
    vmm.map_region(
        image_base,
        size_of_image,
        PAGE_EXECUTE_READWRITE,
        MEM_COMMIT,
        MEM_IMAGE,
        true,
    );

    // Copy DOS + PE + Section headers at ImageBase (required by MinGW pre_c_init!)
    let hdr_copy = size_of_headers.min(pe_bytes.len());
    vmm.host_write_bytes(image_base, &pe_bytes[..hdr_copy])
        .map_err(|e| format!("Failed writing PE headers: {e:?}"))?;

    let sec_table = opt + size_opt_hdr;
    let mut text_base = image_base + entry_rva;
    let mut text_size = 0u64;
    let mut sections: Vec<(u64, u64, u64, u64)> = Vec::new();

    for i in 0..num_sections {
        let sh = sec_table + i * 40;
        if sh + 40 > pe_bytes.len() {
            break;
        }
        let name_bytes = &pe_bytes[sh..sh + 8];
        let virt_size = read_le_u32(pe_bytes, sh + 8).unwrap_or(0) as usize;
        let virt_addr = read_le_u32(pe_bytes, sh + 12).unwrap_or(0) as u64;
        let raw_size = read_le_u32(pe_bytes, sh + 16).unwrap_or(0) as usize;
        let raw_ptr = read_le_u32(pe_bytes, sh + 20).unwrap_or(0) as usize;
        let characteristics = read_le_u32(pe_bytes, sh + 36).unwrap_or(0);
        sections.push((virt_addr, virt_size as u64, raw_ptr as u64, raw_size as u64));

        let copy_len = raw_size.min(if virt_size > 0 { virt_size } else { raw_size });
        if raw_ptr < pe_bytes.len() && copy_len > 0 {
            let end = (raw_ptr + copy_len).min(pe_bytes.len());
            vmm.host_write_bytes(image_base + virt_addr, &pe_bytes[raw_ptr..end])
                .map_err(|e| format!("Failed mapping section {i}: {e:?}"))?;
        }

        if name_bytes.starts_with(b".text") || (characteristics & 0x2000_0000) != 0 {
            if text_size == 0 {
                text_base = image_base + virt_addr;
                text_size = (virt_size.max(raw_size)) as u64;
            }
        }
        let _ = (
            PAGE_EXECUTE_READ,
            PAGE_READONLY,
            PAGE_READWRITE,
            characteristics,
        );
    }

    // Apply IMAGE_REL_BASED_DIR64 relocations if image_base != preferred_base
    if image_base != preferred_base && num_rva > 5 {
        let reloc_dir = opt + 112 + 5 * 8;
        let reloc_rva = read_le_u32(pe_bytes, reloc_dir).unwrap_or(0) as u64;
        let reloc_size = read_le_u32(pe_bytes, reloc_dir + 4).unwrap_or(0) as u64;
        let delta = image_base.wrapping_sub(preferred_base);
        let mut cursor = 0u64;
        while cursor + 8 <= reloc_size && reloc_rva != 0 {
            let mut hdr = [0u8; 8];
            vmm.host_read_bytes(image_base + reloc_rva + cursor, &mut hdr)
                .map_err(|e| format!("Reloc read err: {e:?}"))?;
            let page_rva = u32::from_le_bytes(hdr[0..4].try_into().unwrap()) as u64;
            let block_sz = u32::from_le_bytes(hdr[4..8].try_into().unwrap()) as u64;
            if block_sz < 8 {
                break;
            }
            let entries = (block_sz - 8) / 2;
            for e in 0..entries {
                let entry = vmm
                    .read_u16(image_base + reloc_rva + cursor + 8 + e * 2)
                    .map_err(|err| format!("Reloc entry err: {err:?}"))?;
                let rtype = entry >> 12;
                let roff = (entry & 0x0FFF) as u64;
                if rtype == 10 {
                    // IMAGE_REL_BASED_DIR64
                    let patch_va = image_base + page_rva + roff;
                    let orig = vmm
                        .read_u64(patch_va)
                        .map_err(|err| format!("Reloc val err: {err:?}"))?;
                    vmm.host_write_bytes(patch_va, &orig.wrapping_add(delta).to_le_bytes())
                        .map_err(|err| format!("Reloc write err: {err:?}"))?;
                }
            }
            cursor += block_sz;
        }
    }

    // Map synthetic HLE thunk region (filled with 0xC3 RET bytes)
    vmm.map_region(
        THUNK_BASE,
        THUNK_REGION_SIZE,
        PAGE_EXECUTE_READ,
        MEM_COMMIT,
        MEM_PRIVATE,
        true,
    );
    let ret_fill = vec![0xC3u8; 4096];
    let mut tp = THUNK_BASE;
    while tp < THUNK_BASE + THUNK_REGION_SIZE {
        let _ = vmm.host_write_bytes(tp, &ret_fill);
        tp += 4096;
    }

    // Parse Imports (DataDirectory[1]) and patch IAT
    let mut bindings = Vec::new();
    if num_rva > 1 {
        let imp_dir = opt + 112 + 8;
        let imp_rva = read_le_u32(pe_bytes, imp_dir).unwrap_or(0) as u64;
        let imp_size = read_le_u32(pe_bytes, imp_dir + 4).unwrap_or(0) as u64;
        if imp_rva != 0 && imp_size >= 20 {
            let mut desc_off = 0u64;
            loop {
                let desc_va = image_base + imp_rva + desc_off;
                let mut desc = [0u8; 20];
                if vmm.host_read_bytes(desc_va, &mut desc).is_err() {
                    break;
                }
                let oft_rva = u32::from_le_bytes(desc[0..4].try_into().unwrap()) as u64;
                let name_rva = u32::from_le_bytes(desc[12..16].try_into().unwrap()) as u64;
                let ft_rva = u32::from_le_bytes(desc[16..20].try_into().unwrap()) as u64;
                if oft_rva == 0 && name_rva == 0 && ft_rva == 0 {
                    break;
                }

                let dll_bytes = vmm
                    .read_c_string(image_base + name_rva, 256)
                    .unwrap_or_default();
                let dll_name = String::from_utf8_lossy(&dll_bytes).to_ascii_lowercase();

                let lookup_rva = if oft_rva != 0 { oft_rva } else { ft_rva };
                let mut idx = 0u64;
                loop {
                    let thunk_data = vmm
                        .read_u64(image_base + lookup_rva + idx * 8)
                        .unwrap_or(0);
                    if thunk_data == 0 {
                        break;
                    }
                    let iat_va = image_base + ft_rva + idx * 8;
                    let (sym_name, ordinal) = if (thunk_data & 0x8000_0000_0000_0000) != 0 {
                        let ord = (thunk_data & 0xFFFF) as u16;
                        (format!("#{ord}"), ord)
                    } else {
                        let ibn_va = image_base + (thunk_data & 0x7FFF_FFFF);
                        let hint = vmm.read_u16(ibn_va).unwrap_or(0);
                        let raw = vmm.read_c_string(ibn_va + 2, 512).unwrap_or_default();
                        (String::from_utf8_lossy(&raw).into_owned(), hint)
                    };

                    let thunk_va = bind_import(&dll_name, &sym_name, ordinal);
                    vmm.host_write_bytes(iat_va, &thunk_va.to_le_bytes())
                        .map_err(|e| format!("IAT patch err: {e:?}"))?;

                    bindings.push(ImportBinding {
                        dll: dll_name.clone(),
                        symbol: sym_name,
                        ordinal,
                        iat_va,
                    });
                    idx += 1;
                }

                desc_off += 20;
            }
        }
    }

    // Parse the PE resource directory (DataDirectory[2]) so FindResource/LoadString can
    // return real dialog templates and string-table entries instead of NULL.
    let mut resources = Vec::new();
    if num_rva > 2 {
        let res_dir = opt + 112 + 2 * 8;
        let res_rva = read_le_u32(pe_bytes, res_dir).unwrap_or(0);
        let res_size = read_le_u32(pe_bytes, res_dir + 4).unwrap_or(0);
        resources = parse_pe_resources(pe_bytes, &sections, res_rva, res_size);
    }

    // KUSER_SHARED_DATA is fixed at 0x7FFE0000 on Windows x64. Zeroed => no kernel debugger.
    vmm.map_region(0x7FFE0000, 0x1000, PAGE_READWRITE, MEM_COMMIT, MEM_PRIVATE, true);

    // Initialize PEB, RTL_USER_PROCESS_PARAMETERS, and Main Thread TEB + Stack
    vmm.map_region(PEB_ADDR, 0x20000, PAGE_READWRITE, MEM_COMMIT, MEM_PRIVATE, true);
    vmm.map_region(
        MAIN_STACK_BOTTOM,
        MAIN_STACK_TOP - MAIN_STACK_BOTTOM,
        PAGE_READWRITE,
        MEM_COMMIT,
        MEM_PRIVATE,
        true,
    );

    // PEB fields
    let _ = vmm.write_u64(PEB_ADDR + 0x10, image_base); // ImageBaseAddress
    let _ = vmm.write_u64(PEB_ADDR + 0x20, PROC_PARAMS_ADDR); // ProcessParameters
    // PEB_LDR_DATA + one LDR_DATA_TABLE_ENTRY for the executable. al-khaser's SizeOfImage
    // anti-dump walks Ldr->InLoadOrderModuleList and writes the entry's SizeOfImage; a NULL
    // Ldr faulted the guest at the SEH sentinel instead of completing the check.
    let ldr_va = PEB_ADDR + 0x3000;
    let ldr_entry = PEB_ADDR + 0x4000;
    let _ = vmm.write_u64(PEB_ADDR + 0x18, ldr_va); // Ldr
    let _ = vmm.write_u32(ldr_va, 0x58); // Length
    let _ = vmm.write_u8(ldr_va + 4, 1); // Initialized
    for head in [0x10u64, 0x20, 0x30] {
        let _ = vmm.write_u64(ldr_va + head, ldr_entry); // Flink
        let _ = vmm.write_u64(ldr_va + head + 8, ldr_entry); // Blink
    }
    for link in [0x00u64, 0x10, 0x20] {
        let _ = vmm.write_u64(ldr_entry + link, ldr_va + 0x10 + link);
        let _ = vmm.write_u64(ldr_entry + link + 8, ldr_va + 0x10 + link);
    }
    let _ = vmm.write_u64(ldr_entry + 0x30, image_base); // DllBase
    let _ = vmm.write_u64(ldr_entry + 0x38, image_base + entry_rva); // EntryPoint
    let _ = vmm.write_u32(ldr_entry + 0x40, size_of_image as u32); // SizeOfImage
    vmm.map_region(PROCESS_HEAP_ADDR, 0x1000, PAGE_READWRITE, MEM_COMMIT, MEM_PRIVATE, true);
    let _ = vmm.write_u64(PEB_ADDR + 0x30, PROCESS_HEAP_ADDR); // ProcessHeap
    let _ = vmm.write_u32(PEB_ADDR + 0xB8, 4); // NumberOfProcessors (x64)
    let _ = vmm.write_u32(PROCESS_HEAP_ADDR + 0x70, 2); // HEAP_GROWABLE, no debug flags
    let _ = vmm.write_u32(PROCESS_HEAP_ADDR + 0x74, 0); // ForceFlags

    // Initial CurrentDirectory = "C:\Game\"
    let init_cwd: Vec<u16> = "C:\\Game\\".encode_utf16().collect();
    for (i, &ch) in init_cwd.iter().enumerate() {
        let _ = vmm.write_u16(CURDIR_BUF_ADDR + (i as u64) * 2, ch);
    }
    let _ = vmm.write_u16(CURDIR_BUF_ADDR + (init_cwd.len() as u64) * 2, 0);
    // RTL_USER_PROCESS_PARAMETERS (x64): StandardInput @0x20, StandardOutput @0x28,
    // StandardError @0x30, CurrentDirectory (CURDIR) @0x38 = { DosPath UNICODE_STRING
    // @0x38 (Length @0x38, MaximumLength @0x3A, Buffer @0x40), Handle @0x48 }.
    // The previous offsets (0x28/0x30/0x38) wrote the CURDIR over the standard-handle
    // slots, so PEB readers (Wine directory.c TEST_GRANTED_ACCESS) saw Handle=garbage.
    let _ = vmm.write_u16(PROC_PARAMS_ADDR + 0x38, (init_cwd.len() * 2) as u16); // DosPath.Length
    let _ = vmm.write_u16(PROC_PARAMS_ADDR + 0x3A, 520); // DosPath.MaximumLength
    let _ = vmm.write_u64(PROC_PARAMS_ADDR + 0x40, CURDIR_BUF_ADDR); // DosPath.Buffer
    let _ = vmm.write_u64(PROC_PARAMS_ADDR + 0x48, CURDIR_HANDLE); // CurrentDirectory.Handle

    // Handle static TLS directory (DataDirectory[9]) if present
    let mut tls_array_ptr = 0u64;
    let mut tls_callbacks: Vec<u64> = Vec::new();
    if num_rva > 9 {
        let tls_dir = opt + 112 + 9 * 8;
        let tls_rva = read_le_u32(pe_bytes, tls_dir).unwrap_or(0) as u64;
        let tls_sz = read_le_u32(pe_bytes, tls_dir + 4).unwrap_or(0) as u64;
        if tls_rva != 0 && tls_sz >= 40 {
            let tls_va = image_base + tls_rva;
            let raw_start = vmm.read_u64(tls_va).unwrap_or(0);
            let raw_end = vmm.read_u64(tls_va + 8).unwrap_or(0);
            let idx_va = vmm.read_u64(tls_va + 16).unwrap_or(0);
            if idx_va != 0 {
                let _ = vmm.host_write_bytes(idx_va, &0u32.to_le_bytes());
            }
            let tls_block_va = PEB_ADDR + 0x18000;
            let tls_arr_va = PEB_ADDR + 0x17F00;
            let len = raw_end.saturating_sub(raw_start).min(4096) as usize;
            if raw_start != 0 && len > 0 {
                let mut tmp = vec![0u8; len];
                if vmm.host_read_bytes(raw_start, &mut tmp).is_ok() {
                    let _ = vmm.host_write_bytes(tls_block_va, &tmp);
                }
            }
            let _ = vmm.write_u64(tls_arr_va, tls_block_va);
            tls_array_ptr = tls_arr_va;
            // AddressOfCallBacks (TLS directory + 24): null-terminated PIMAGE_TLS_CALLBACK array.
            let callbacks_va = vmm.read_u64(tls_va + 24).unwrap_or(0);
            if callbacks_va != 0 {
                for i in 0..64u64 {
                    let cb = vmm.read_u64(callbacks_va + i * 8).unwrap_or(0);
                    if cb == 0 { break; }
                    if vmm.find_region(cb).is_some() { tls_callbacks.push(cb); }
                }
            }
        }
    }

    init_teb(
        vmm,
        MAIN_TEB_ADDR,
        MAIN_STACK_TOP,
        MAIN_STACK_BOTTOM,
        0x1000,
        0x1004,
        tls_array_ptr,
    );

    // Full .text AOT scan is performed by BrowserX64Emulator::aot_compile_text after load,
    // so the host can measure compilation lag separately from PE parsing/relocation.
    let aot_blocks_compiled = 0usize;
    let aot_bytes_compiled = 0usize;
    let aot_instructions_scanned = 0usize;

    Ok((
        LoadedPe64Info {
            image_base,
            size_of_image,
            entry_point: image_base + entry_rva,
            text_base,
            text_size,
            import_count: bindings.len(),
            aot_blocks_compiled,
            aot_bytes_compiled,
            aot_instructions_scanned,
            tls_callbacks,
            resources,
        },
        bindings,
    ))
}

/// Linear-sweep `.text` with the iced-x86 length/flow decoder to discover real instruction
/// boundaries and branch targets, then compile each candidate basic block with the *same*
/// JIT decoder used at runtime. Unsupported instructions terminate a block precisely; they
/// never cause mid-instruction decoding. Returns (blocks_compiled, wasm_bytes, insns_scanned).
pub fn aot_scan_text(
    vmm: &mut VirtualMemoryManager,
    jit: &mut HybridWasmJit,
    text_base: u64,
    text_size: u64,
    entry_rip: u64,
) -> (usize, usize, usize) {
    if text_size == 0 || text_size > 64 * 1024 * 1024 { return (0, 0, 0); }
    let mut text = vec![0u8; text_size as usize];
    if vmm.host_read_bytes(text_base, &mut text).is_err() { return (0, 0, 0); }
    let mut starts: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
    if entry_rip >= text_base && entry_rip < text_base + text_size { starts.insert(entry_rip); }
    let mut decoder = match Decoder::try_new(64, &text, DecoderOptions::NONE) {
        Ok(d) => d,
        Err(_) => return (0, 0, 0),
    };
    decoder.set_ip(text_base);
    let end = text_base + text_size;
    let mut scanned = 0usize;
    while (decoder.position() as u64) < text_size {
        let ins = decoder.decode();
        scanned += 1;
        if ins.is_invalid() {
            // Resynchronize at the next byte; never compile an invalid instruction.
            let pos = decoder.position().saturating_sub(ins.len().max(1));
            let next = pos + 1;
            if next >= text.len() { break; }
            decoder.set_position(next);
            decoder.set_ip(text_base + next as u64);
            continue;
        }
        let next_ip = decoder.ip();
        match ins.flow_control() {
            FlowControl::Next => {}
            FlowControl::ConditionalBranch | FlowControl::UnconditionalBranch | FlowControl::Call => {
                let target = ins.near_branch_target();
                if target >= text_base && target < end { starts.insert(target); }
                if next_ip >= text_base && next_ip < end { starts.insert(next_ip); }
            }
            FlowControl::Return | FlowControl::Interrupt | FlowControl::Exception => {
                if next_ip >= text_base && next_ip < end { starts.insert(next_ip); }
            }
            _ => {
                if next_ip >= text_base && next_ip < end { starts.insert(next_ip); }
            }
        }
        if next_ip >= end { break; }
    }
    let mut blocks = 0usize;
    let mut bytes = 0usize;
    for rip in starts {
        let off = (rip - text_base) as usize;
        let len = 512usize.min(text.len() - off).min(4096 - (rip & 0xFFF) as usize);
        if len < 1 { continue; }
        let epoch = vmm.page_write_epoch(rip & !0xFFF);
        if jit.get_valid_artifact(rip, epoch).is_some() { continue; }
        if let Some(art) = jit.try_compile_block(rip, epoch, &text[off..off + len]) {
            blocks += 1;
            bytes += art.wasm_bytes.len();
        }
    }
    // Second pass: forward references are now present, so relink static JMP/CALL
    // edges into native Wasm call/return_call chains where acyclic.
    for rip in &starts {
        let off = (*rip - text_base) as usize;
        let len = 512usize.min(text.len() - off).min(4096 - (*rip & 0xFFF) as usize);
        if len < 1 { continue; }
        let epoch = vmm.page_write_epoch(*rip & !0xFFF);
        if let Some(art) = jit.try_relink_block(*rip, epoch, &text[off..off + len]) {
            bytes += art.wasm_bytes.len();
        }
    }
    (blocks, bytes, scanned)
}

pub fn init_teb(
    vmm: &mut VirtualMemoryManager,
    teb_addr: u64,
    stack_base: u64,
    stack_limit: u64,
    pid: u64,
    tid: u64,
    tls_array_ptr: u64,
) {
    let _ = vmm.write_u64(teb_addr + 0x00, 0); // ExceptionList
    let _ = vmm.write_u64(teb_addr + 0x08, stack_base); // StackBase (MUST be non-zero for MinGW CRT!)
    let _ = vmm.write_u64(teb_addr + 0x10, stack_limit); // StackLimit
    let _ = vmm.write_u64(teb_addr + 0x30, teb_addr); // NtCurrentTeb() self pointer (GS:[0x30])
    let _ = vmm.write_u64(teb_addr + 0x40, pid); // ClientId.UniqueProcess
    let _ = vmm.write_u64(teb_addr + 0x48, tid); // ClientId.UniqueThread
    let _ = vmm.write_u64(teb_addr + 0x58, tls_array_ptr); // ThreadLocalStoragePointer
    let _ = vmm.write_u64(teb_addr + 0x60, PEB_ADDR); // ProcessEnvironmentBlock
    let _ = vmm.write_u32(teb_addr + 0x68, 0); // LastErrorValue
}
