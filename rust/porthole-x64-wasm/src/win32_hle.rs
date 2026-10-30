use std::collections::HashMap;

use crate::d3d12_hle::D3d12Subsystem;
use crate::pe64::{
    CURDIR_HANDLE, MAIN_STACK_BOTTOM, MAIN_STACK_TOP, MAIN_TEB_ADDR, PROC_PARAMS_ADDR, PEB_ADDR,
    EXPORT_THUNK_BASE, EXPORT_THUNK_END, THREAD_EXIT_THUNK_ADDR, THUNK_BASE, THUNK_STRIDE,
};
use crate::vmm::{MemoryTrap, VirtualMemoryManager, MEM_COMMIT, MEM_PRIVATE, PAGE_READWRITE};
use crate::win32_fmt::{
    cp1252_byte_to_wchar, format_win64_printf, mb_to_wide, wide_to_mb, VaSlotReader,
};

pub const ERROR_SUCCESS: u32 = 0;
pub const ERROR_INVALID_FUNCTION: u32 = 1;
pub const ERROR_FILE_NOT_FOUND: u32 = 2;
pub const ERROR_PATH_NOT_FOUND: u32 = 3;
pub const ERROR_TOO_MANY_OPEN_FILES: u32 = 4;
pub const ERROR_ACCESS_DENIED: u32 = 5;
pub const ERROR_INVALID_HANDLE: u32 = 6;
pub const ERROR_NOT_ENOUGH_MEMORY: u32 = 8;
pub const ERROR_INVALID_DRIVE: u32 = 15;
pub const ERROR_NO_MORE_FILES: u32 = 18;
pub const ERROR_SHARING_VIOLATION: u32 = 32;
pub const ERROR_HANDLE_EOF: u32 = 38;
pub const ERROR_INVALID_PARAMETER: u32 = 87;
pub const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
pub const ERROR_INVALID_NAME: u32 = 123;
pub const ERROR_ALREADY_EXISTS: u32 = 183;
pub const ERROR_ENVVAR_NOT_FOUND: u32 = 203;
pub const ERROR_MORE_DATA: u32 = 234;
pub const ERROR_BUFFER_OVERFLOW: u32 = 111;
pub const ERROR_CALL_NOT_IMPLEMENTED: u32 = 120;
pub const ERROR_BROKEN_PIPE: u32 = 109;
pub const ERROR_PROC_NOT_FOUND: u32 = 127;
pub const ERROR_MOD_NOT_FOUND: u32 = 126;
pub const ERROR_INVALID_ADDRESS: u32 = 487;
pub const ERROR_NOT_SUPPORTED: u32 = 50;

/// Guest VA of the synthetic CRT data-import cells (`_fmode`, `_commode`, `_iob`, `__initenv`).
///
/// Old MSVC binaries (7za.exe 21.07 among them) import *data* symbols from msvcrt.dll: the IAT
/// slot must contain the address of the variable inside the DLL, and the guest dereferences it
/// (`mov rcx,[__imp__fmode]; mov [rcx],eax` at 0x4d82cb in 7za). Binding those slots to code
/// thunks made the CRT write through 0x7ff000001350 and fault on instruction 29.
pub const DATA_IMPORT_BASE: u64 = 0x0000_7FF0_0004_0000;
/// Old-msvcrt `FILE` (`struct _iobuf`) stride on x64.
pub const OLD_FILE_SIZE: u64 = 48;
/// Deterministic guest clock: 2026-10-30T00:00:00Z as a Windows FILETIME.
pub const FIXED_FILETIME: u64 = 134_377_920_000_000_000;

pub const STDIN_HANDLE_VAL: u64 = 0x10;
pub const STDOUT_HANDLE_VAL: u64 = 0x14;
pub const STDERR_HANDLE_VAL: u64 = 0x18;

pub const INVALID_HANDLE_VALUE: u64 = u64::MAX;
pub const INVALID_FILE_ATTRIBUTES: u32 = 0xFFFF_FFFF;
pub const STILL_ACTIVE: u32 = 259;
pub const WAIT_OBJECT_0: u32 = 0;
pub const WAIT_TIMEOUT: u32 = 258;
pub const WAIT_ABANDONED: u32 = 0x80;
pub const WAIT_FAILED: u32 = 0xFFFF_FFFF;

pub const DRIVE_UNKNOWN: u32 = 0;
pub const DRIVE_NO_ROOT_DIR: u32 = 1;
pub const DRIVE_REMOVABLE: u32 = 2;
pub const DRIVE_FIXED: u32 = 3;

pub const MAX_ATOM_LEN: usize = 255;
pub const FIRST_STRING_ATOM: u16 = 0xC000;

pub const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
pub const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;

pub const CP_ACP: u32 = 0;
pub const CP_OEMCP: u32 = 1;
pub const CP_UTF8: u32 = 65001;
pub const ANSI_CODEPAGE: u32 = 1252;

/// Marker for an HLE call that must invoke a guest function before returning.
///
/// An upcall is a *re-entrant* HLE call: the guest called an API stub, the API needs the guest to
/// run some code (a CRT constructor), so the driver pushes a sentinel return address and jumps into
/// guest code. When the guest's `ret` lands on the sentinel, [`Win32Kernel::finish_upcall`] decides
/// whether to call the next guest function ([`UpcallStep::Call`]) or to give control back to the
/// API handler ([`UpcallStep::Resume`]) so the original call can finally pop its own return
/// address. `resume_rip` is that stub address; it is never overwritten by the upcall machinery.
#[derive(Debug, Clone)]
pub enum UpcallState {
    Initterm {
        start: u64,
        next_slot: u64,
        end: u64,
        resume_rip: u64,
    },
}

/// Next action for the driver after an upcalled guest function returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpcallStep {
    /// Push a fresh sentinel and call this guest function.
    Call(u64),
    /// All guest work for this API is done: re-enter the API stub at `resume_rip` with the stack
    /// frame exactly as the original guest `call` left it.
    Resume(u64),
}

#[derive(Debug, Clone)]
pub enum HleAction {
    Return(u64),
    Upcall { target: u64, resume_rip: u64, rax: u64 },
    ExitProcess(u32),
}

#[derive(Debug, Clone)]
struct AtomTable {
    by_name: HashMap<String, u16>,
    by_id: HashMap<u16, String>,
    next_id: u16,
}

impl AtomTable {
    fn new() -> Self {
        Self {
            by_name: HashMap::new(),
            by_id: HashMap::new(),
            next_id: FIRST_STRING_ATOM,
        }
    }

    /// Returns `Some(atom)` for integer atoms, `None` when the pointer must be dereferenced.
    fn integer_atom(raw_ptr: u64) -> Option<u64> {
        if raw_ptr < 0x1_0000 {
            if raw_ptr >= 1 && raw_ptr <= 0xBFFF {
                Some(raw_ptr)
            } else {
                Some(0)
            }
        } else {
            None
        }
    }

    fn add(&mut self, name: &str) -> u16 {
        let key = name.to_ascii_uppercase();
        if let Some(&id) = self.by_name.get(&key) {
            return id;
        }
        if self.next_id == 0 {
            return 0;
        }
        let id = self.next_id;
        self.by_name.insert(key, id);
        self.by_id.insert(id, name.to_string());
        // 0xC000..=0xFFFF are reserved for string atoms in the ATOM space; wrap defensively.
        if self.next_id == u16::MAX {
            self.next_id = 0;
        } else {
            self.next_id += 1;
        }
        id
    }

    fn find(&self, name: &str) -> u16 {
        self.by_name
            .get(&name.to_ascii_uppercase())
            .copied()
            .unwrap_or(0)
    }

    fn name_of(&self, atom: u16) -> Option<&str> {
        self.by_id.get(&atom).map(|s| s.as_str())
    }
}

#[derive(Debug, Clone)]
struct GuestFile {
    path: String,
    data: Vec<u8>,
    position: u64,
    writable: bool,
    is_directory: bool,
    handle_count: u32,
}

#[derive(Debug, Clone)]
struct HeapState {
    base: u64,
    next: u64,
    end: u64,
}

#[derive(Debug, Clone)]
struct GuestThread {
    handle: u64,
    teb_addr: u64,
    stack_top: u64,
    stack_base: u64,
    entry: u64,
    param: u64,
    exit_code: u32,
    finished: bool,
    started: bool,
    signal_handle: u64,
}

#[derive(Debug, Clone)]
struct Waitable {
    signaled: bool,
    manual_reset: bool,
}

#[derive(Debug, Clone)]
struct FindEntry {
    name: String,
    is_dir: bool,
    size: u64,
}

#[derive(Debug, Clone)]
struct FindSearch {
    entries: Vec<FindEntry>,
    next: usize,
}

#[derive(Debug, Clone)]
struct FileMapping {
    file_key: Option<String>,
    size: u64,
    va: u64,
}

pub struct Win32Kernel {
    pub last_error: u32,
    atoms_global: AtomTable,
    atoms_local: AtomTable,
    env: Vec<(String, String)>,
    pub cwd: String,
    files: HashMap<String, GuestFile>,
    pub next_handle: u64,
    pub cwd_handle: u64,
    pub heaps: Vec<HeapState>,
    pub process_heap: u64,
    waitables: HashMap<u64, Waitable>,
    pub threads: Vec<GuestThread>,
    pub current_thread: usize,
    pub tls_slots: Vec<Option<u64>>,
    pub crit_sections: HashMap<u64, u32>,
    pub d3d12: D3d12Subsystem,
    pub stdout: Vec<u8>,
    pub exit_code: Option<u32>,
    pub ticks: u64,
    upcall_stack: Vec<UpcallState>,
    modules: HashMap<String, u64>,
    pub instructions: u64,
    pub swapped_page_hook: bool,
    handle_map: HashMap<u64, String>,
    import_thunks: HashMap<u64, (String, String, u16)>,
    export_thunks: HashMap<(String, String), u64>,
    bitmaps: HashMap<u64, Bitmap>,
    dc_brush: HashMap<u64, u32>,
    selected_bitmap: HashMap<u64, u64>,
    windows: Vec<(u64, u32, u32)>,
    /// Command line handed to the guest (`GetCommandLineA/W`, `__p___argc`, `__p___argv`).
    pub command_line: String,
    crt_argc_ptr: u64,
    crt_argv_var: u64,
    crt_wargv_var: u64,
    crt_environ_var: u64,
    crt_wenviron_var: u64,
    command_line_a: u64,
    command_line_w: u64,
    timezone_daylight: u64,
    tzname_ptr: u64,
    /// Next free slot in the `GetProcAddress` stub pool (`EXPORT_THUNK_BASE`..`EXPORT_THUNK_END`).
    export_thunk_next: u64,
    /// Diagnostics emitted from inside an HLE handler; the driver drains these into its trace.
    pub hle_notes: Vec<String>,
    /// How often each imported symbol was called (published as a histogram by the trace driver).
    pub hle_calls: HashMap<String, u64>,
    /// Symbols that reached the default arm, i.e. the guest called an API nobody implemented.
    pub hle_unimplemented: Vec<String>,
    /// Full path of the loaded image (`GetModuleFileNameW(NULL, ...)`), set by the harness.
    pub exe_path: String,
    /// Data-import cells, created by [`Self::init_data_imports`].
    pub fmode_cell: u64,
    pub commode_cell: u64,
    pub iob_base: u64,
    pub initenv_cell: u64,
    atexit_funcs: Vec<u64>,
    semaphores: HashMap<u64, i32>,
    find_searches: HashMap<u64, FindSearch>,
    file_mappings: HashMap<u64, FileMapping>,
    next_mapping_va: u64,
    alloc_sizes: HashMap<u64, u64>,
    free_blocks: Vec<(u64, u64)>,
    qpc_ticks: u64,
    app_type: u32,
}

impl Win32Kernel {
    pub fn new() -> Self {
        let mut kernel = Self {
            last_error: 0,
            atoms_global: AtomTable::new(),
            atoms_local: AtomTable::new(),
            env: Vec::new(),
            cwd: "C:\\Game".to_string(),
            files: HashMap::new(),
            next_handle: 0x100,
            cwd_handle: CURDIR_HANDLE,
            heaps: Vec::new(),
            process_heap: 0x40,
            waitables: HashMap::new(),
            threads: Vec::new(),
            current_thread: 0,
            tls_slots: vec![None; 64],
            crit_sections: HashMap::new(),
            d3d12: D3d12Subsystem::new(),
            stdout: Vec::new(),
            exit_code: None,
            ticks: 0x1000,
            upcall_stack: Vec::new(),
            modules: HashMap::new(),
            instructions: 0,
            swapped_page_hook: false,
            handle_map: HashMap::new(),
            import_thunks: HashMap::new(),
            export_thunks: HashMap::new(),
            bitmaps: HashMap::new(),
            dc_brush: HashMap::new(),
            selected_bitmap: HashMap::new(),
            windows: Vec::new(),
            command_line: String::from("test.exe"),
            crt_argc_ptr: 0,
            crt_argv_var: 0,
            crt_wargv_var: 0,
            crt_environ_var: 0,
            crt_wenviron_var: 0,
            command_line_a: 0,
            command_line_w: 0,
            timezone_daylight: 0,
            tzname_ptr: 0,
            export_thunk_next: 0,
            hle_notes: Vec::new(),
            hle_calls: HashMap::new(),
            hle_unimplemented: Vec::new(),
            exe_path: String::new(),
            fmode_cell: 0,
            commode_cell: 0,
            iob_base: 0,
            initenv_cell: 0,
            atexit_funcs: Vec::new(),
            semaphores: HashMap::new(),
            find_searches: HashMap::new(),
            file_mappings: HashMap::new(),
            next_mapping_va: 0x0000_0006_0000_0000,
            alloc_sizes: HashMap::new(),
            free_blocks: Vec::new(),
            qpc_ticks: 0,
            app_type: 0,
        };
        kernel.env.push(("PATH".into(), "C:\\Windows\\System32".into()));
        kernel.env.push(("SystemRoot".into(), "C:\\Windows".into()));
        kernel.env.push(("WINDIR".into(), "C:\\Windows".into()));
        kernel.env.push(("TEMP".into(), "C:\\Users\\PORTHOLE\\Temp".into()));
        kernel.env.push(("TMP".into(), "C:\\Users\\PORTHOLE\\Temp".into()));
        kernel.env.push(("USERPROFILE".into(), "C:\\Users\\PORTHOLE".into()));
        kernel.env.push(("COMPUTERNAME".into(), "PORTHOLE".into()));
        kernel.env.push(("USERNAME".into(), "PORTHOLE".into()));
        kernel.env.push(("WINETEST_PLATFORM".into(), "wine".into()));
        // Seed the virtual volume.
        //
        // `files` is keyed by the *upper-case* path (`lookup_file` normalises on every read), so
        // seeding mixed-case keys made every one of these directories invisible: a `CreateFileW`
        // into the default `C:\\Game` working directory failed with ERROR_PATH_NOT_FOUND(3) because
        // `parent_exists` could not find the parent that was seeded as "C:\\Game".
        for (path, writable) in [
            ("C:\\", false),
            ("C:\\Windows", false),
            ("C:\\Windows\\System32", false),
            ("C:\\Users", true),
            ("C:\\Users\\Public", true),
            // The PORTHOLE user profile + temp dir that %TEMP%/%USERPROFILE% and
            // GetTempPath point at must actually exist, or CreateDirectory under
            // %TEMP% fails with ERROR_PATH_NOT_FOUND (Wine directory.c cascade).
            ("C:\\Users\\PORTHOLE", true),
            ("C:\\Users\\PORTHOLE\\Temp", true),
            ("C:\\Game", true),
        ] {
            let key = path.to_ascii_uppercase();
            kernel.files.insert(
                key,
                GuestFile {
                    path: path.to_string(),
                    data: Vec::new(),
                    position: 0,
                    writable,
                    is_directory: true,
                    handle_count: 1,
                },
            );
        }
        kernel.alloc_handle(); // process pseudo-handle 0x100
        kernel
    }

    pub fn alloc_handle(&mut self) -> u64 {
        let h = self.next_handle;
        self.next_handle += 4;
        h
    }

    /// Records a diagnostic line for the driver's trace ring buffer.
    pub fn note(&mut self, line: String) {
        if self.hle_notes.len() < 100_000 {
            self.hle_notes.push(line);
        }
    }

    /// Records a symbol that reached the default dispatch arm.
    fn record_unimplemented(&mut self, symbol: &str) {
        if self.hle_unimplemented.len() < 512 && !self.hle_unimplemented.iter().any(|s| s == symbol) {
            self.hle_unimplemented.push(symbol.to_string());
        }
    }

    /// `symbol=count` lines, most-called first.
    pub fn hle_histogram(&self, top: usize) -> String {
        let mut pairs: Vec<(&String, &u64)> = self.hle_calls.iter().collect();
        pairs.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        pairs
            .into_iter()
            .take(top)
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn unimplemented_symbols(&self) -> String {
        self.hle_unimplemented.join(" ")
    }

    pub fn set_last_error(&mut self, err: u32) {
        self.last_error = err;
    }

    pub fn init_modules(&mut self) {
        for (i, name) in [
            "kernel32.dll",
            "kernelbase.dll",
            "ntdll.dll",
            "user32.dll",
            "gdi32.dll",
            "advapi32.dll",
            "ucrtbase.dll",
            "msvcrt.dll",
            "d3d12.dll",
            "dxgi.dll",
        ]
        .iter()
        .enumerate()
        {
            self.modules
                .insert(name.to_string(), 0x7FFE_1000_0000 + (i as u64) * 0x1_0000);
        }
    }

    fn canonical_path(&mut self, raw: &str) -> Result<String, u32> {
        let mut s = raw.replace('/', "\\");
        if s.is_empty() {
            return Err(ERROR_PATH_NOT_FOUND);
        }
        // Wildcard ordering follows NT name resolution: a wildcard in a *parent* component
        // names a directory that cannot exist, so the lookup fails with ERROR_PATH_NOT_FOUND
        // before the final component is ever validated; a wildcard confined to the final
        // component is ERROR_INVALID_NAME (directory.c:243-249, 438, Gate 5).
        if s.contains('?') || s.contains('*') {
            let comps: Vec<&str> = s.split(['\\', '/']).filter(|c| !c.is_empty()).collect();
            let in_parent = comps.len() > 1
                && comps[..comps.len() - 1]
                    .iter()
                    .any(|c| c.contains('?') || c.contains('*'));
            return Err(if in_parent {
                ERROR_PATH_NOT_FOUND
            } else {
                ERROR_INVALID_NAME
            });
        }
        if s.starts_with("\\\\") {
            return Err(ERROR_INVALID_NAME);
        }
        if s.len() >= 2 && s.as_bytes()[1] == b':' {
            let drive = s.as_bytes()[0].to_ascii_uppercase();
            if drive != b'C' {
                return Err(ERROR_INVALID_DRIVE);
            }
            s = s[2..].to_string();
        } else if s.starts_with('\\') {
            // root-relative
        } else {
            // `cwd` already carries its drive ("C:\Windows\System32"), so only its drive-less
            // part may be prepended - joining the whole thing produced "C:\C:\Windows\System32"
            // for every relative path, so CreateDirectoryA(".") failed with a no-parent error.
            let base = match self.cwd.split_once(':') {
                Some((_, rest)) => rest.to_string(),
                None => self.cwd.clone(),
            };
            s = format!("{}\\{}", base.trim_end_matches(['\\', '/']), s);
        }
        if !s.starts_with('\\') {
            s = format!("\\{}", s);
        }
        // Normalize "." and ".." and duplicate separators, and strip the trailing dots/spaces
        // Win32 removes from every component ("Please Remove Me." names "Please Remove Me",
        // directory.c:255-266).
        let mut parts: Vec<String> = Vec::new();
        for part in s.split('\\') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                other => {
                    let trimmed = other.trim_end_matches(['.', ' ']);
                    if !trimmed.is_empty() {
                        parts.push(trimmed.to_string());
                    }
                }
            }
        }
        Ok(format!("C:\\{}", parts.join("\\")))
    }

    fn dir_of(path: &str) -> String {
        match path.rfind('\\') {
            Some(0) => "C:\\".to_string(),
            Some(i) => path[..i].to_string(),
            None => "C:\\".to_string(),
        }
    }

    pub fn vfs_insert_directory(&mut self, path: &str) {
        let key = path.to_ascii_uppercase();
        self.files.entry(key).or_insert_with(|| GuestFile {
            path: path.to_string(),
            data: Vec::new(),
            position: 0,
            writable: false,
            is_directory: true,
            handle_count: 0,
        });
    }

    pub fn vfs_insert_file(&mut self, path: &str, bytes: &[u8]) {
        let key = path.to_ascii_uppercase();
        self.files.insert(
            key,
            GuestFile {
                path: path.to_string(),
                data: bytes.to_vec(),
                position: 0,
                writable: true,
                is_directory: false,
                handle_count: 0,
            },
        );
    }

    pub fn vfs_snapshot(&self, path: &str) -> Option<Vec<u8>> {
        self.files
            .get(&path.to_ascii_uppercase())
            .filter(|f| !f.is_directory)
            .map(|f| f.data.clone())
    }

    fn lookup_file(&self, path: &str) -> Option<&GuestFile> {
        self.files.get(&path.to_ascii_uppercase())
    }

    fn dir_exists(&self, path: &str) -> bool {
        if path == "C:\\" || path == "C:" {
            return true;
        }
        self.lookup_file(path).map(|f| f.is_directory).unwrap_or(false)
    }

    fn parent_exists(&self, path: &str) -> bool {
        let dir = Self::dir_of(path);
        self.dir_exists(&dir)
    }

    fn is_root(&self, path: &str) -> bool {
        path == "C:\\" || path == "C:" || path.is_empty()
    }

    // ---------------------------------------------------------------- memory

    fn heap_alloc(&mut self, vmm: &mut VirtualMemoryManager, heap: u64, size: u64) -> u64 {
        let aligned = (size.max(1) + 15) & !15;
        // Reuse freed blocks before growing the bump frontier. A pure bump allocator exhausts
        // any fixed region under a real C++ workload (7-Zip churns thousands of new/delete
        // pairs for a single small archive), so `free` must actually recycle.
        if let Some(pos) = self.free_blocks.iter().position(|&(_, sz)| sz >= aligned) {
            let (va, sz) = self.free_blocks.swap_remove(pos);
            if sz - aligned >= 16 {
                self.free_blocks.push((va + aligned, sz - aligned));
                self.alloc_sizes.insert(va, aligned);
            } else {
                self.alloc_sizes.insert(va, sz);
            }
            let _ = vmm.host_write_bytes(va, &vec![0u8; aligned as usize]);
            return va;
        }
        let idx = self
            .heaps
            .iter()
            .position(|h| h.base == heap)
            .unwrap_or(0);
        if self.heaps.is_empty() {
            return 0;
        }
        let h = &mut self.heaps[idx];
        if h.next + aligned > h.end {
            return 0;
        }
        let va = h.next;
        h.next += aligned;
        // Zero the block (HeapAlloc without HEAP_ZERO_MEMORY is uninitialized in Windows, but
        // zeroing keeps guest behaviour deterministic and matches HEAP_ZERO_MEMORY callers).
        let _ = vmm.host_write_bytes(va, &vec![0u8; aligned as usize]);
        self.alloc_sizes.insert(va, aligned);
        va
    }

    fn heap_free(&mut self, ptr: u64) {
        if ptr == 0 {
            return;
        }
        if let Some(sz) = self.alloc_sizes.remove(&ptr) {
            self.free_blocks.push((ptr, sz));
        }
    }

    fn heap_block_size(&self, ptr: u64) -> u64 {
        self.alloc_sizes.get(&ptr).copied().unwrap_or(0)
    }

    /// `realloc`/`HeapReAlloc` semantics: new block, copy `min(old, new)`, free the old block.
    fn heap_realloc(&mut self, vmm: &mut VirtualMemoryManager, heap: u64, ptr: u64, size: u64) -> u64 {
        if ptr == 0 {
            return self.heap_alloc(vmm, heap, size);
        }
        if size == 0 {
            self.heap_free(ptr);
            return 0;
        }
        let old_size = self.heap_block_size(ptr);
        let va = self.heap_alloc(vmm, heap, size);
        if va == 0 {
            return 0;
        }
        let copy = old_size.min(size) as usize;
        if copy > 0 {
            let mut buf = vec![0u8; copy];
            if vmm.read_bytes(ptr, &mut buf).is_ok() {
                let _ = vmm.host_write_bytes(va, &buf);
            }
        }
        self.heap_free(ptr);
        va
    }

    /// Creates the writable guest cells for old-msvcrt *data* imports and returns
    /// `(symbol, cell_va)` pairs the loader must write into the IAT *instead of* code thunks.
    pub fn init_data_imports(
        &mut self,
        vmm: &mut VirtualMemoryManager,
    ) -> Vec<(String, u64)> {
        vmm.map_region(
            DATA_IMPORT_BASE,
            0x1_0000,
            PAGE_READWRITE,
            MEM_COMMIT,
            MEM_PRIVATE,
            true,
        );
        self.fmode_cell = DATA_IMPORT_BASE;
        self.commode_cell = DATA_IMPORT_BASE + 0x08;
        self.iob_base = DATA_IMPORT_BASE + 0x10;
        self.initenv_cell = DATA_IMPORT_BASE + 0x100;
        let initenv_vector = DATA_IMPORT_BASE + 0x200;
        // _fmode defaults to _O_TEXT (0x4000); the guest CRT overwrites it from its own
        // `_fmode` initializer during startup, which is the exact store that used to fault.
        let _ = vmm.write_u32(self.fmode_cell, 0x4000);
        let _ = vmm.write_u32(self.commode_cell, 0);
        // struct _iobuf (x64, 48 bytes): _flag @24, _file @28. _IOREAD=1, _IOWRT=2.
        let flags = [1u32, 2, 2];
        for i in 0..3u64 {
            let f = self.iob_base + i * OLD_FILE_SIZE;
            let _ = vmm.write_u32(f + 24, flags[i as usize]);
            let _ = vmm.write_u32(f + 28, i as u32);
        }
        // __initenv (`char **`) starts as an empty NULL-terminated vector; __getmainargs
        // repoints the cell at the materialised environment vector.
        let _ = vmm.write_u64(initenv_vector, 0);
        let _ = vmm.write_u64(self.initenv_cell, initenv_vector);
        vec![
            ("_fmode".to_string(), self.fmode_cell),
            ("_commode".to_string(), self.commode_cell),
            ("_iob".to_string(), self.iob_base),
            ("__initenv".to_string(), self.initenv_cell),
        ]
    }

    /// Index (0=stdin, 1=stdout, 2=stderr) of an old-msvcrt `FILE *`, when it points into
    /// the synthetic `_iob` array.
    fn iob_index(&self, ptr: u64) -> Option<usize> {
        if self.iob_base == 0 || ptr < self.iob_base {
            return None;
        }
        let off = ptr - self.iob_base;
        if off % OLD_FILE_SIZE == 0 && off / OLD_FILE_SIZE < 3 {
            Some((off / OLD_FILE_SIZE) as usize)
        } else {
            None
        }
    }

    pub fn set_exe_path(&mut self, path: &str) {
        self.exe_path = path.to_string();
    }

    fn module_file_name(&self) -> String {
        if !self.exe_path.is_empty() {
            return self.exe_path.clone();
        }
        let toks = self.argv_tokens();
        let arg0 = toks.first().cloned().unwrap_or_else(|| "test.exe".to_string());
        if arg0.contains('\\') || arg0.contains(':') {
            arg0.replace('/', "\\")
        } else {
            format!("{}\\{}", self.cwd, arg0)
        }
    }

    pub fn init_heaps(&mut self, vmm: &mut VirtualMemoryManager) {
        let region_base = 0x0000_0003_0000_0000u64;
        let region_size = 0x0000_0000_1000_0000u64; // 256 MB sparse VA (pages materialise on use)
        vmm.map_region(
            region_base,
            region_size,
            PAGE_READWRITE,
            MEM_COMMIT,
            MEM_PRIVATE,
            false,
        );
        self.heaps.push(HeapState {
            base: self.process_heap,
            next: region_base,
            end: region_base + region_size,
        });
    }

    // ------------------------------------------------------------- strings

    pub fn read_ansi(&mut self, vmm: &mut VirtualMemoryManager, addr: u64) -> String {
        if addr == 0 {
            return String::new();
        }
        let bytes = vmm.read_c_string(addr, 0x8000).unwrap_or_default();
        let wide = mb_to_wide(ANSI_CODEPAGE, &bytes);
        String::from_utf16_lossy(&wide)
    }

    pub fn read_wide(&mut self, vmm: &mut VirtualMemoryManager, addr: u64) -> String {
        if addr == 0 {
            return String::new();
        }
        let units = vmm.read_wide_string(addr, 0x8000).unwrap_or_default();
        String::from_utf16_lossy(&units)
    }

    fn write_ansi(&mut self, vmm: &mut VirtualMemoryManager, addr: u64, s: &str) -> Result<usize, ()> {
        let units: Vec<u16> = s.encode_utf16().collect();
        let (mut bytes, _) = wide_to_mb(ANSI_CODEPAGE, &units);
        bytes.push(0);
        vmm.write_bytes(addr, &bytes).map_err(|_| ())?;
        Ok(bytes.len() - 1)
    }

    fn write_wide(&mut self, vmm: &mut VirtualMemoryManager, addr: u64, s: &str) -> Result<usize, ()> {
        let units: Vec<u16> = s.encode_utf16().collect();
        let mut buf = Vec::with_capacity((units.len() + 1) * 2);
        for u in &units {
            buf.extend_from_slice(&u.to_le_bytes());
        }
        buf.extend_from_slice(&[0, 0]);
        vmm.write_bytes(addr, &buf).map_err(|_| ())?;
        Ok(units.len())
    }

    // ------------------------------------------------------------ env vars

    fn env_find(&self, name: &str) -> Option<usize> {
        self.env
            .iter()
            .position(|(k, _)| k.eq_ignore_ascii_case(name))
    }

    fn env_get(&self, name: &str) -> Option<&str> {
        self.env_find(name).map(|i| self.env[i].1.as_str())
    }

    fn env_set(&mut self, name: &str, value: Option<&str>) -> bool {
        if name.is_empty() {
            return false;
        }
        match value {
            None => {
                if let Some(i) = self.env_find(name) {
                    self.env.remove(i);
                }
                true
            }
            Some(v) => {
                if let Some(i) = self.env_find(name) {
                    self.env[i].1 = v.to_string();
                } else {
                    self.env.push((name.to_string(), v.to_string()));
                }
                true
            }
        }
    }

    /// Faithful port of wine's `RtlExpandEnvironmentStrings` (dlls/ntdll/env.c).
    ///
    /// Returns `(destination, required_length_including_terminator)`. The destination is `count`
    /// characters long and starts as the caller's current buffer, because the algorithm leaves
    /// parts of it untouched - and environ.c checks exactly that:
    ///
    /// * a literal run is copied character by character, and truncating it writes no terminator;
    /// * a `%VAR%` value is copied whole or not at all, and the terminator is planted where the
    ///   value would start when it does not fit;
    /// * the final terminator is only written while capacity remains.
    fn expand_env_into(&self, src: &[u16], count: usize, existing: &[u16]) -> (Vec<u16>, usize) {
        let mut dst: Vec<u16> = existing.to_vec();
        dst.resize(count.max(dst.len()), 0);
        dst.truncate(count);
        let mut remaining = count;
        let mut pos = 0usize;
        let mut total = 1usize; // the terminating NUL
        let pct = b'%' as u16;
        let mut i = 0usize;
        while i < src.len() {
            let (len, mut copy, units): (usize, usize, Vec<u16>);
            if src[i] != pct {
                let mut n = 0usize;
                while i + n < src.len() && src[i + n] != pct {
                    n += 1;
                }
                units = src[i..i + n].to_vec();
                i += n;
                len = n;
                copy = n;
            } else {
                let mut n = 1usize;
                while i + n < src.len() && src[i + n] != pct {
                    n += 1;
                }
                if i + n < src.len() {
                    let name = String::from_utf16_lossy(&src[i + 1..i + n]);
                    match self.env_get(&name) {
                        Some(val) => {
                            let value: Vec<u16> = val.encode_utf16().collect();
                            i += n + 1;
                            len = value.len();
                            copy = value.len();
                            if remaining <= copy {
                                copy = 0;
                            }
                            if remaining != 0 && count != 0 {
                                let idx = pos + copy;
                                if idx < dst.len() {
                                    dst[idx] = 0;
                                }
                            }
                            units = value;
                        }
                        None => {
                            units = src[i..i + n + 1].to_vec();
                            i += n + 1;
                            len = units.len();
                            copy = len;
                        }
                    }
                } else {
                    units = src[i..].to_vec();
                    i = src.len();
                    len = units.len();
                    copy = len;
                }
            }
            total += len;
            if remaining != 0 && count != 0 {
                let mut l = len;
                if remaining < l {
                    l = remaining;
                }
                if remaining <= copy {
                    copy = remaining - 1;
                }
                for k in 0..copy {
                    let idx = pos + k;
                    if idx < dst.len() && k < units.len() {
                        dst[idx] = units[k];
                    }
                }
                remaining -= l;
                pos += copy;
            }
        }
        if remaining != 0 && count != 0 && pos < dst.len() {
            dst[pos] = 0;
        }
        (dst, total)
    }

    fn expand_env(&self, src: &str) -> String {
        let units: Vec<u16> = src.encode_utf16().collect();
        let (dst, total) = self.expand_env_into(&units, units.len() + 1, &[]);
        let text = String::from_utf16_lossy(&dst);
        let _ = total;
        text.trim_end_matches('\0').to_string()
    }

    // --------------------------------------------------------------- atoms

    fn atom_add(&mut self, vmm: &mut VirtualMemoryManager, table: bool, ptr: u64, wide: bool) -> u64 {
        if let Some(a) = AtomTable::integer_atom(ptr) {
            return a;
        }
        let name = if wide {
            self.read_wide(vmm, ptr)
        } else {
            self.read_ansi(vmm, ptr)
        };
        if name.is_empty() || name.chars().count() > MAX_ATOM_LEN {
            self.set_last_error(ERROR_INVALID_PARAMETER);
            return 0;
        }
        let id = if table {
            self.atoms_global.add(&name)
        } else {
            self.atoms_local.add(&name)
        };
        id as u64
    }

    fn atom_find(&mut self, vmm: &mut VirtualMemoryManager, table: bool, ptr: u64, wide: bool) -> u64 {
        if let Some(a) = AtomTable::integer_atom(ptr) {
            return a;
        }
        let name = if wide {
            self.read_wide(vmm, ptr)
        } else {
            self.read_ansi(vmm, ptr)
        };
        if name.is_empty() || name.chars().count() > MAX_ATOM_LEN {
            return 0;
        }
        let id = if table {
            self.atoms_global.find(&name)
        } else {
            self.atoms_local.find(&name)
        };
        id as u64
    }

    /// Wine `GlobalGetAtomNameA` semantics.
    ///
    /// Two details matter to atom.c: the name *plus its NUL* has to fit (otherwise the call fails
    /// with ERROR_MORE_DATA and leaves the buffer untouched, atom.c:196-206), and atom 0 is an
    /// invalid parameter rather than an invalid handle (atom.c:198).
    fn atom_name_global(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        atom: u64,
        buffer: u64,
        count: u64,
    ) -> u64 {
        if (count as i32) <= 0 {
            self.set_last_error(ERROR_MORE_DATA);
            return 0;
        }
        if atom == 0 || atom > 0xFFFF {
            self.set_last_error(ERROR_INVALID_PARAMETER);
            return 0;
        }
        let name = if atom <= 0xBFFF {
            format!("#{}", atom)
        } else {
            match self.atoms_global.name_of(atom as u16) {
                Some(n) => n.to_string(),
                None => {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return 0;
                }
            }
        };
        let units: Vec<u16> = name.encode_utf16().collect();
        let (bytes, _) = wide_to_mb(ANSI_CODEPAGE, &units);
        let len = bytes.len() as u64;
        if len + 1 > count {
            // Truncation still writes `count - 1` characters plus the terminator and reports
            // failure (atom.c:205 expects "fooba\0" in a 6-byte buffer).
            let mut out = bytes[..bytes.len().min(count.saturating_sub(1) as usize)].to_vec();
            out.push(0);
            let _ = vmm.write_bytes(buffer, &out);
            self.set_last_error(ERROR_MORE_DATA);
            return 0;
        }
        let mut out = bytes;
        out.push(0);
        let _ = vmm.write_bytes(buffer, &out);
        len
    }

    /// Exact Wine `GetAtomNameA` semantics (returns the copied length on truncation).
    fn atom_name_local(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        atom: u64,
        buffer: u64,
        count: u64,
    ) -> u64 {
        if (count as i32) <= 0 {
            self.set_last_error(ERROR_MORE_DATA);
            return 0;
        }
        if atom == 0 || atom > 0xFFFF {
            self.set_last_error(ERROR_INVALID_PARAMETER);
            return 0;
        }
        let name = if atom <= 0xBFFF {
            format!("#{}", atom)
        } else {
            match self.atoms_local.name_of(atom as u16) {
                Some(n) => n.to_string(),
                None => {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return 0;
                }
            }
        };
        let units: Vec<u16> = name.encode_utf16().collect();
        let (bytes, _) = wide_to_mb(ANSI_CODEPAGE, &units);
        let len = bytes.len() as u64;
        let c = len.min(count - 1) as usize;
        let mut out = bytes[..c].to_vec();
        out.push(0);
        let _ = vmm.write_bytes(buffer, &out);
        if len >= count {
            self.set_last_error(ERROR_MORE_DATA);
            return c as u64;
        }
        len
    }

    fn atom_name_wide(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        global: bool,
        atom: u64,
        buffer: u64,
        count: u64,
    ) -> u64 {
        if (count as i32) <= 0 {
            self.set_last_error(ERROR_MORE_DATA);
            return 0;
        }
        if atom == 0 || atom > 0xFFFF {
            self.set_last_error(ERROR_INVALID_PARAMETER);
            return 0;
        }
        let name = if atom <= 0xBFFF {
            format!("#{}", atom)
        } else {
            let t = if global {
                self.atoms_global.name_of(atom as u16)
            } else {
                self.atoms_local.name_of(atom as u16)
            };
            match t {
                Some(n) => n.to_string(),
                None => {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return 0;
                }
            }
        };
        let units: Vec<u16> = name.encode_utf16().collect();
        let len = units.len() as u64;
        if !global {
            // `GetAtomNameW` truncates like its ANSI sibling: count-1 characters plus a terminator,
            // returning the copied count (atom.c:433-435).
            let n = len.min(count.saturating_sub(1)) as usize;
            let mut buf = Vec::with_capacity((n + 1) * 2);
            for u in &units[..n] {
                buf.extend_from_slice(&u.to_le_bytes());
            }
            buf.extend_from_slice(&[0, 0]);
            let _ = vmm.write_bytes(buffer, &buf);
            if len + 1 > count && n == 0 {
                // A one-character buffer cannot hold anything: that is the only truncation wine
                // reports as an error for this API (atom.c:530). A partial copy is silent.
                self.set_last_error(ERROR_MORE_DATA);
            }
            return n as u64;
        }
        // `GlobalGetAtomNameW` copies as many characters as fit *without* needing room for the
        // terminator, and only reports ERROR_MORE_DATA when it actually truncated
        // (atom.c:212-214, 273).
        let n = len.min(count) as usize;
        let mut buf = Vec::with_capacity((n + 1) * 2);
        for u in &units[..n] {
            buf.extend_from_slice(&u.to_le_bytes());
        }
        if (n as u64) < count {
            buf.extend_from_slice(&[0, 0]);
        }
        let _ = vmm.write_bytes(buffer, &buf);
        if (n as u64) < len {
            self.set_last_error(ERROR_MORE_DATA);
        }
        n as u64
    }

    fn drive_type(&self, path: &str) -> u32 {
        let bytes = path.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' {
            let letter = bytes[0].to_ascii_uppercase();
            // Wine treats a bare "C:" spec as the root of the volume too, so the trailing
            // backslash is optional. Only advertising DRIVE_FIXED for "C:\\" made
            // `GetDriveTypeA("C:")` answer DRIVE_NO_ROOT_DIR(1) and failed drive.c:64.
            return if letter == b'C' {
                DRIVE_FIXED
            } else {
                DRIVE_NO_ROOT_DIR
            };
        }
        DRIVE_NO_ROOT_DIR
    }

    pub fn run_threads_to_completion(&mut self, vmm: &mut VirtualMemoryManager) {
        // Cooperative scheduler: guest threads run through their entry points when the main
        // thread waits. The trampoline is installed by the emulator driver, which polls
        // `pending_thread_start()`.
        let _ = vmm;
    }

    pub fn take_next_runnable_thread(&mut self) -> Option<u64> {
        for t in self.threads.iter_mut() {
            if !t.started && !t.finished {
                t.started = true;
                return Some(t.entry);
            }
        }
        None
    }

    // ------------------------------------------------- OLEAUT32 BSTR / VARIANT

    fn bstr_alloc(&mut self, vmm: &mut VirtualMemoryManager, units: &[u16]) -> u64 {
        let byte_len = (units.len() * 2) as u32;
        let va = self.heap_alloc(vmm, self.process_heap, byte_len as u64 + 6);
        if va == 0 {
            return 0;
        }
        let _ = vmm.write_u32(va, byte_len);
        for (i, u) in units.iter().enumerate() {
            let _ = vmm.write_u16(va + 4 + (i as u64) * 2, *u);
        }
        let _ = vmm.write_u16(va + 4 + byte_len as u64, 0);
        va + 4
    }

    fn bstr_len_bytes(&mut self, vmm: &mut VirtualMemoryManager, ptr: u64) -> u32 {
        if ptr == 0 {
            return 0;
        }
        vmm.read_u32(ptr.wrapping_sub(4)).unwrap_or(0)
    }

    fn variant_clear(&mut self, vmm: &mut VirtualMemoryManager, p: u64) -> u64 {
        if p == 0 {
            return 0x8007_0057; // E_INVALIDARG
        }
        // VT_BSTR payloads come from the bump/freelist heap; freeing is a no-op there.
        let _ = vmm.write_bytes(p, &[0u8; 16]);
        0
    }

    fn variant_copy(&mut self, vmm: &mut VirtualMemoryManager, dst: u64, src: u64) -> u64 {
        if dst == 0 || src == 0 {
            return 0x8007_0057;
        }
        let mut raw = [0u8; 24];
        if vmm.read_bytes(src, &mut raw).is_err() {
            return 0x8007_0057;
        }
        let vt = u16::from_le_bytes([raw[0], raw[1]]);
        if dst != src {
            let _ = self.variant_clear(vmm, dst);
        }
        let _ = vmm.write_bytes(dst, &raw);
        if vt == 8 {
            // VT_BSTR: deep-copy the string so independent lifetimes do not alias.
            let bstr = u64::from_le_bytes(raw[8..16].try_into().unwrap());
            if bstr != 0 {
                let bytes = self.bstr_len_bytes(vmm, bstr);
                let chars = (bytes / 2) as usize;
                let mut units = vec![0u16; chars];
                for (i, slot) in units.iter_mut().enumerate() {
                    *slot = vmm.read_u16(bstr + (i as u64) * 2).unwrap_or(0);
                }
                let copy = self.bstr_alloc(vmm, &units);
                let _ = vmm.write_u64(dst + 8, copy);
            }
        }
        0
    }

    // ------------------------------------------------- find-file machinery

    fn wildcard_match(pattern: &str, name: &str) -> bool {
        let p: Vec<char> = pattern.chars().collect();
        let n: Vec<char> = name.chars().collect();
        // Classic two-pointer glob match with '*' backtracking, '?' single-char, ASCII-folded.
        let (mut pi, mut ni) = (0usize, 0usize);
        let (mut star, mut retry) = (usize::MAX, 0usize);
        while ni < n.len() {
            if pi < p.len()
                && (p[pi] == '?' || p[pi].eq_ignore_ascii_case(&n[ni]))
            {
                pi += 1;
                ni += 1;
            } else if pi < p.len() && p[pi] == '*' {
                star = pi;
                retry = ni;
                pi += 1;
            } else if star != usize::MAX {
                pi = star + 1;
                retry += 1;
                ni = retry;
            } else {
                return false;
            }
        }
        while pi < p.len() && p[pi] == '*' {
            pi += 1;
        }
        pi == p.len()
    }

    fn write_find_data(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        out: u64,
        wide: bool,
        entry: &FindEntry,
    ) {
        let mut buf = [0u8; 592];
        let attrs: u32 = if entry.is_dir { 0x10 } else { 0x80 };
        buf[0..4].copy_from_slice(&attrs.to_le_bytes());
        for off in [4usize, 12, 20] {
            buf[off..off + 8].copy_from_slice(&FIXED_FILETIME.to_le_bytes());
        }
        buf[28..32].copy_from_slice(&((entry.size >> 32) as u32).to_le_bytes());
        buf[32..36].copy_from_slice(&(entry.size as u32).to_le_bytes());
        if wide {
            for (i, u) in entry.name.encode_utf16().take(259).enumerate() {
                buf[44 + i * 2..44 + i * 2 + 2].copy_from_slice(&u.to_le_bytes());
            }
            let _ = vmm.write_bytes(out, &buf[..592]);
        } else {
            let (bytes, _) = wide_to_mb(
                ANSI_CODEPAGE,
                &entry.name.encode_utf16().collect::<Vec<_>>(),
            );
            let n = bytes.len().min(259);
            buf[44..44 + n].copy_from_slice(&bytes[..n]);
            let _ = vmm.write_bytes(out, &buf[..320]);
        }
    }

    /// Enumerates candidate entries for a find pattern. Returns `(entries, err)`.
    fn find_candidates(&mut self, raw: &str) -> (Vec<FindEntry>, u32) {
        let s = raw.replace('/', "\\");
        let (parent_raw, pattern) = match s.rfind('\\') {
            Some(i) => (&s[..i + 1], &s[i + 1..]),
            None => ("", s.as_str()),
        };
        let parent = if parent_raw.is_empty() {
            self.cwd.clone()
        } else if parent_raw.contains('?') || parent_raw.contains('*') {
            return (Vec::new(), ERROR_PATH_NOT_FOUND);
        } else {
            match self.canonical_path(parent_raw) {
                Ok(p) => p,
                Err(e) => return (Vec::new(), e),
            }
        };
        if !self.dir_exists(&parent) {
            return (Vec::new(), ERROR_PATH_NOT_FOUND);
        }
        let has_wild = pattern.contains('*') || pattern.contains('?');
        let mut entries: Vec<FindEntry> = Vec::new();
        for f in self.files.values() {
            let dir = Self::dir_of(&f.path);
            let same_dir = dir.eq_ignore_ascii_case(&parent)
                || (parent == "C:\\" && dir == "C:");
            if !same_dir || f.path.eq_ignore_ascii_case(&parent) {
                continue;
            }
            let name = f
                .path
                .rsplit('\\')
                .next()
                .unwrap_or(f.path.as_str())
                .to_string();
            let hit = if has_wild {
                Self::wildcard_match(pattern, &name)
                    || (pattern == "*.*" && Self::wildcard_match("*", &name))
            } else {
                name.eq_ignore_ascii_case(pattern)
            };
            if hit {
                entries.push(FindEntry {
                    name,
                    is_dir: f.is_directory,
                    size: f.data.len() as u64,
                });
            }
        }
        entries.sort_by(|a, b| a.name.to_ascii_uppercase().cmp(&b.name.to_ascii_uppercase()));
        if has_wild && (pattern == "*" || pattern == "*.*") {
            entries.insert(
                0,
                FindEntry { name: "..".to_string(), is_dir: true, size: 0 },
            );
            entries.insert(
                0,
                FindEntry { name: ".".to_string(), is_dir: true, size: 0 },
            );
        }
        (entries, 0)
    }

    // ------------------------------------------------- FILETIME conversions

    fn filetime_to_civil(ft: u64) -> (u16, u16, u16, u16, u16, u16, u16, u16) {
        // (year, month, day_of_week, day, hour, minute, second, millis), Sunday = 0.
        let total_ms = ft / 10_000;
        let millis = (total_ms % 1000) as u16;
        let secs = total_ms / 1000;
        let second = (secs % 60) as u16;
        let minute = ((secs / 60) % 60) as u16;
        let hour = ((secs / 3600) % 24) as u16;
        let days1601 = (secs / 86_400) as i64;
        // 1601-01-01 was a Monday; Sunday=0 so day 0 -> 1.
        let dow = ((days1601 + 1) % 7) as u16;
        // Howard Hinnant's civil_from_days (input: days since 1970-01-01).
        let z = (days1601 - 134_774) + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = (z - era * 146_097) as u64;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe as i64 + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = if m <= 2 { y + 1 } else { y };
        (year as u16, m as u16, dow, d as u16, hour, minute, second, millis)
    }

    fn civil_to_filetime(year: i64, month: u32, day: u32, hour: u32, min: u32, sec: u32) -> u64 {
        // Days since 1601-01-01 via civil-from-days inverse (Howard Hinnant / days_from_civil),
        // whose epoch (1970-01-01) is 134774 days after the FILETIME epoch.
        let y_adj = if month <= 2 { year - 1 } else { year };
        let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
        let yoe = (y_adj - era * 400) as u64;
        let mp = if month > 2 { month - 3 } else { month + 9 } as u64;
        let doy = (153 * mp + 2) / 5 + day as u64 - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days1970 = era * 146_097 + doe as i64 - 719_468;
        let days1601 = days1970 + 134_774;
        let secs = days1601 * 86_400 + hour as i64 * 3600 + min as i64 * 60 + sec as i64;
        (secs.max(0) as u64) * 10_000_000
    }

    // ---------------------------------------------------------- dispatch

    pub fn dispatch(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        dll: &str,
        symbol: &str,
        ordinal: u16,
        args: &[u64; 10],
        guest_rsp: u64,
        call_rip: u64,
    ) -> HleAction {
        *self.hle_calls.entry(symbol.to_string()).or_insert(0) += 1;
        let a0 = args[0];
        let a1 = args[1];
        let a2 = args[2];
        let a3 = args[3];
        let a4 = args[4];
        let a5 = args[5];
        let a6 = args[6];
        let a7 = args[7];
        let a8 = args[8];

        // Resolve well-known d3d12/dxgi entry points first.
        match (dll, symbol) {
            ("d3d12.dll", "D3D12CreateDevice") => {
                return HleAction::Return(
                    self.d3d12.d3d12_create_device(vmm, a0, a1 as u32, a2, a3) as u64
                )
            }
            ("d3d12.dll", "D3D12SerializeRootSignature") => {
                return HleAction::Return(
                    self.d3d12
                        .d3d12_serialize_root_signature(vmm, a0, a1 as u32, a2, a3) as u64,
                )
            }
            ("d3d12.dll", "D3D12GetDebugInterface") => {
                if a1 != 0 {
                    let _ = vmm.write_u64(a1, 0);
                }
                return HleAction::Return(0x8000_4002); // E_NOINTERFACE (no debug layer installed)
            }
            ("dxgi.dll", "CreateDXGIFactory")
            | ("dxgi.dll", "CreateDXGIFactory1")
            | ("dxgi.dll", "CreateDXGIFactory2") => {
                let (riid, out) = if symbol == "CreateDXGIFactory2" {
                    (a1, a2)
                } else {
                    (a0, a1)
                };
                return HleAction::Return(self.d3d12.create_dxgi_factory(vmm, riid, out) as u64);
            }
            // OLEAUT32 ordinal imports (7za.exe imports #2,#4,#6,#7,#9,#10). Ordinal -> name
            // mapping is the pinned Wine `dlls/oleaut32/oleaut32.spec` table.
            ("oleaut32.dll", "#2") | ("oleaut32.dll", "SysAllocString") => {
                let s = self.read_wide(vmm, a0);
                let units: Vec<u16> = s.encode_utf16().collect();
                return HleAction::Return(self.bstr_alloc(vmm, &units));
            }
            ("oleaut32.dll", "#4") | ("oleaut32.dll", "SysAllocStringLen") => {
                let n = a1 as u32 as usize;
                let mut units = vec![0u16; n];
                if a0 != 0 {
                    for (i, slot) in units.iter_mut().enumerate() {
                        *slot = vmm.read_u16(a0 + (i as u64) * 2).unwrap_or(0);
                    }
                }
                return HleAction::Return(self.bstr_alloc(vmm, &units));
            }
            ("oleaut32.dll", "#6") | ("oleaut32.dll", "SysFreeString") => {
                if a0 >= 4 {
                    self.heap_free(a0 - 4);
                }
                return HleAction::Return(0);
            }
            ("oleaut32.dll", "#7") | ("oleaut32.dll", "SysStringLen") => {
                return HleAction::Return((self.bstr_len_bytes(vmm, a0) / 2) as u64);
            }
            ("oleaut32.dll", "#8") | ("oleaut32.dll", "VariantInit") => {
                if a0 != 0 {
                    let _ = vmm.write_bytes(a0, &[0u8; 24]);
                }
                return HleAction::Return(0);
            }
            ("oleaut32.dll", "#9") | ("oleaut32.dll", "VariantClear") => {
                return HleAction::Return(self.variant_clear(vmm, a0));
            }
            ("oleaut32.dll", "#10") | ("oleaut32.dll", "VariantCopy") => {
                return HleAction::Return(self.variant_copy(vmm, a0, a1));
            }
            _ => {}
        }

        let result: u64 = match symbol {
            // ------------------------------------------------------- console
            "GetStdHandle" => {
                match a0 as u32 as i32 {
                    -10 => STDIN_HANDLE_VAL,
                    -11 => STDOUT_HANDLE_VAL,
                    -12 => STDERR_HANDLE_VAL,
                    _ => {
                        self.set_last_error(ERROR_INVALID_PARAMETER);
                        INVALID_HANDLE_VALUE
                    }
                }
            }
            "GetConsoleScreenBufferInfo" => {
                // The guest console is a redirected pipe, but a plausible 80x25 buffer keeps
                // callers that only probe dimensions on their happy path.
                if a0 == STDOUT_HANDLE_VAL || a0 == STDERR_HANDLE_VAL {
                    if a1 != 0 {
                        let mut info = [0u8; 22];
                        info[0..2].copy_from_slice(&80u16.to_le_bytes());
                        info[2..4].copy_from_slice(&25u16.to_le_bytes());
                        info[8..10].copy_from_slice(&7u16.to_le_bytes()); // wAttributes
                        info[14..16].copy_from_slice(&79u16.to_le_bytes()); // window right
                        info[16..18].copy_from_slice(&24u16.to_le_bytes()); // window bottom
                        info[18..20].copy_from_slice(&80u16.to_le_bytes());
                        info[20..22].copy_from_slice(&25u16.to_le_bytes());
                        let _ = vmm.write_bytes(a1, &info);
                    }
                    1
                } else {
                    self.set_last_error(ERROR_INVALID_HANDLE);
                    0
                }
            }
            "SetConsoleCtrlHandler" => 1,
            "SetFileApisToOEM" | "SetFileApisToANSI" => 0,
            "GetConsoleMode" => {
                self.set_last_error(ERROR_INVALID_HANDLE);
                0
            }
            "SetConsoleMode" => {
                self.set_last_error(ERROR_INVALID_HANDLE);
                0
            }

            // ------------------------------------------------------- errors
            "GetLastError" => self.last_error as u64,
            "SetLastError" => {
                self.last_error = a0 as u32;
                0
            }
            "SetErrorMode" => 0,
            "SetUnhandledExceptionFilter" => 0,

            // -------------------------------------------------------- atoms
            "GlobalAddAtomA" => self.atom_add(vmm, true, a0, false),
            "GlobalAddAtomW" => self.atom_add(vmm, true, a0, true),
            "GlobalFindAtomA" => self.atom_find(vmm, true, a0, false),
            "GlobalFindAtomW" => self.atom_find(vmm, true, a0, true),
            "GlobalGetAtomNameA" => self.atom_name_global(vmm, a0, a1, a2),
            "GlobalGetAtomNameW" => self.atom_name_wide(vmm, true, a0, a1, a2),
            "AddAtomA" => self.atom_add(vmm, false, a0, false),
            "AddAtomW" => self.atom_add(vmm, false, a0, true),
            "FindAtomA" => self.atom_find(vmm, false, a0, false),
            "FindAtomW" => self.atom_find(vmm, false, a0, true),
            "GetAtomNameA" => self.atom_name_local(vmm, a0, a1, a2),
            "GetAtomNameW" => self.atom_name_wide(vmm, false, a0, a1, a2),

            // -------------------------------------------------- codepage/i18n
            "GetACP" => ANSI_CODEPAGE as u64,
            "GetOEMCP" => ANSI_CODEPAGE as u64,
            "IsDBCSLeadByte" => 0,
            "GetCPInfo" => {
                // CPINFO { UINT MaxCharSize; BYTE DefaultChar[2]; BYTE LeadByte[12]; }
                if a1 == 0 {
                    0
                } else {
                    let mut buf = [0u8; 20];
                    buf[0..4].copy_from_slice(&1u32.to_le_bytes());
                    buf[4] = b'?';
                    let _ = vmm.write_bytes(a1, &buf);
                    1
                }
            }
            "GetCPInfoExW" => {
                // CPINFOEXW: MaxCharSize@0, DefaultChar@4, LeadByte@6, UnicodeDefaultChar@18,
                //             CodePage@20, CodePageName[260]@24 -> 544 bytes total
                if a2 == 0 {
                    0
                } else {
                    let mut buf = [0u8; 544];
                    buf[0..4].copy_from_slice(&1u32.to_le_bytes());
                    buf[4] = b'?';
                    buf[18..20].copy_from_slice(&(b'?' as u16).to_le_bytes());
                    buf[20..24].copy_from_slice(&ANSI_CODEPAGE.to_le_bytes());
                    for (i, ch) in "windows-1252".encode_utf16().enumerate() {
                        let off = 24 + i * 2;
                        buf[off..off + 2].copy_from_slice(&ch.to_le_bytes());
                    }
                    let _ = vmm.write_bytes(a2, &buf);
                    1
                }
            }
            // MultiByteToWideChar(CodePage, dwFlags, lpMultiByteStr, cbMultiByte,
            //                     lpWideCharStr, cchWideChar)
            //
            // `dwFlags` is the *second* argument. Reading the parameters one slot early made
            // `src` the flags word (always 0), so every conversion failed and returned 0 - which is
            // why the winetest's `my_btowc()` helper produced 0 for every byte (wsprintf.c:190).
            "MultiByteToWideChar" => {
                let codepage = a0 as u32;
                let src = a2;
                let srclen = a3 as i32;
                let dst = a4;
                let dstlen = a5 as i32;
                if src == 0 {
                    return HleAction::Return(0);
                }
                let need_units: Vec<u16> = {
                    let bytes = if srclen < 0 {
                        vmm.read_c_string(src, 0x8000).unwrap_or_default()
                    } else {
                        let mut b = vec![0u8; srclen as usize];
                        let _ = vmm.read_bytes(src, &mut b);
                        b
                    };
                    let mut u = mb_to_wide(codepage, &bytes);
                    if srclen < 0 {
                        u.push(0);
                    }
                    u
                };
                let needed = need_units.len();
                self.note(format!(
                    "K MultiByteToWideChar cp={codepage} src=0x{src:x} srclen={srclen} dst=0x{dst:x} dstlen={dstlen} needed={needed} first={:x}",
                    need_units.first().copied().unwrap_or(0)
                ));
                if dstlen == 0 || dst == 0 {
                    return HleAction::Return(needed as u64);
                }
                if (dstlen as usize) < needed {
                    self.set_last_error(ERROR_INSUFFICIENT_BUFFER);
                    return HleAction::Return(0);
                }
                let mut buf = Vec::with_capacity(needed * 2);
                for u in &need_units {
                    buf.extend_from_slice(&u.to_le_bytes());
                }
                let _ = vmm.write_bytes(dst, &buf);
                needed as u64
            }
            // WideCharToMultiByte(CodePage, dwFlags, lpWideCharStr, cchWideChar,
            //                     lpMultiByteStr, cbMultiByte, lpDefaultChar, lpUsedDefaultChar)
            "WideCharToMultiByte" => {
                let codepage = a0 as u32;
                let src = a2;
                let srclen = a3 as i32;
                let dst = a4;
                let dstlen = a5 as i32;
                if src == 0 {
                    return HleAction::Return(0);
                }
                let units: Vec<u16> = if srclen < 0 {
                    let mut u = vmm.read_wide_string(src, 0x8000).unwrap_or_default();
                    u.push(0);
                    u
                } else {
                    let mut b = vec![0u8; srclen as usize * 2];
                    let _ = vmm.read_bytes(src, &mut b);
                    b.chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect()
                };
                let (bytes, used_default) = wide_to_mb(codepage, &units);
                if dstlen == 0 || dst == 0 {
                    return HleAction::Return(bytes.len() as u64);
                }
                if (dstlen as usize) < bytes.len() {
                    self.set_last_error(ERROR_INSUFFICIENT_BUFFER);
                    return HleAction::Return(0);
                }
                let _ = vmm.write_bytes(dst, &bytes);
                if used_default && a7 != 0 {
                    let _ = vmm.write_u32(a7, 1);
                }
                bytes.len() as u64
            }

            // --------------------------------------------------- environment
            "GetEnvironmentVariableA" => {
                if a0 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let name = self.read_ansi(vmm, a0);
                if name.is_empty() {
                    self.set_last_error(ERROR_ENVVAR_NOT_FOUND);
                    return HleAction::Return(0);
                }
                match self.env_get(&name).map(|s| s.to_string()) {
                    None => {
                        // A missing variable leaves the caller's buffer untouched (environ.c:138).
                        self.set_last_error(ERROR_ENVVAR_NOT_FOUND);
                        0
                    }
                    Some(value) => {
                        let units: Vec<u16> = value.encode_utf16().collect();
                        let (bytes, _) = wide_to_mb(ANSI_CODEPAGE, &units);
                        let needed = bytes.len() + 1;
                        let size = a2 as u32 as usize;
                        if size == 0 {
                            return HleAction::Return(needed as u64);
                        }
                        if size < needed {
                            return HleAction::Return(needed as u64);
                        }
                        let mut out = bytes.clone();
                        out.push(0);
                        let _ = vmm.write_bytes(a1, &out);
                        bytes.len() as u64
                    }
                }
            }
            "GetEnvironmentVariableW" => {
                if a0 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let name = self.read_wide(vmm, a0);
                if name.is_empty() {
                    self.set_last_error(ERROR_ENVVAR_NOT_FOUND);
                    return HleAction::Return(0);
                }
                match self.env_get(&name).map(|s| s.to_string()) {
                    None => {
                        self.set_last_error(ERROR_ENVVAR_NOT_FOUND);
                        0
                    }
                    Some(value) => {
                        let units: Vec<u16> = value.encode_utf16().collect();
                        let needed = units.len() + 1;
                        let size = a2 as u32 as usize;
                        if size == 0 || size < needed {
                            return HleAction::Return(needed as u64);
                        }
                        let _ = self.write_wide(vmm, a1, &value);
                        units.len() as u64
                    }
                }
            }
            "SetEnvironmentVariableA" => {
                if a0 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let name = self.read_ansi(vmm, a0);
                let value = if a1 == 0 {
                    None
                } else {
                    Some(self.read_ansi(vmm, a1))
                };
                if self.env_set(&name, value.as_deref()) {
                    1
                } else {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    0
                }
            }
            "SetEnvironmentVariableW" => {
                if a0 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let name = self.read_wide(vmm, a0);
                let value = if a1 == 0 {
                    None
                } else {
                    Some(self.read_wide(vmm, a1))
                };
                if self.env_set(&name, value.as_deref()) {
                    1
                } else {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    0
                }
            }
            "GetEnvironmentStringsW" => {
                let mut blob: Vec<u8> = Vec::new();
                let mut entries = self.env.clone();
                entries.sort_by(|a, b| a.0.cmp(&b.0));
                for (k, v) in entries {
                    let s = format!("{}={}", k, v);
                    for u in s.encode_utf16() {
                        blob.extend_from_slice(&u.to_le_bytes());
                    }
                    blob.extend_from_slice(&[0, 0]);
                }
                blob.extend_from_slice(&[0, 0]);
                let cap = blob.len() as u64 + 16;
                let va = self.heap_alloc(vmm, self.process_heap, cap);
                if va == 0 {
                    return HleAction::Return(0);
                }
                let _ = vmm.host_write_bytes(va, &blob);
                va
            }
            "GetEnvironmentStringsA" => {
                let mut blob: Vec<u8> = Vec::new();
                let mut entries = self.env.clone();
                entries.sort_by(|a, b| a.0.cmp(&b.0));
                for (k, v) in entries {
                    let s = format!("{}={}", k, v);
                    let (bytes, _) = wide_to_mb(ANSI_CODEPAGE, &s.encode_utf16().collect::<Vec<_>>());
                    blob.extend_from_slice(&bytes);
                    blob.push(0);
                }
                blob.push(0);
                let cap = blob.len() as u64 + 16;
                let va = self.heap_alloc(vmm, self.process_heap, cap);
                if va == 0 {
                    return HleAction::Return(0);
                }
                let _ = vmm.host_write_bytes(va, &blob);
                va
            }
            "FreeEnvironmentStringsW" | "FreeEnvironmentStringsA" => 1,
            "ExpandEnvironmentStringsW" => {
                if a0 == 0 {
                    return HleAction::Return(if a1 == 0 || a2 == 0 { 1 } else { 0 });
                }
                let src: Vec<u16> = self.read_wide(vmm, a0).encode_utf16().collect();
                let count = a2 as u32 as usize;
                let existing: Vec<u16> = if a1 != 0 && count != 0 {
                    let mut raw = vec![0u8; count * 2];
                    let _ = vmm.read_bytes(a1, &mut raw);
                    raw.chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect()
                } else {
                    Vec::new()
                };
                let (dst, total) = self.expand_env_into(&src, count, &existing);
                if a1 != 0 && count != 0 {
                    let mut buf = Vec::with_capacity(count * 2);
                    for u in dst.iter().take(count) {
                        buf.extend_from_slice(&u.to_le_bytes());
                    }
                    let _ = vmm.write_bytes(a1, &buf);
                }
                total as u64
            }
            "ExpandEnvironmentStringsA" => {
                // kernelbase implements this on top of the wide call: expand fully, measure the
                // ANSI form (terminator included), then copy only if it fits - otherwise just
                // plant a NUL - and over-report by one byte when the buffer was too small.
                if a0 == 0 {
                    return HleAction::Return(if a1 == 0 || a2 == 0 { 1 } else { 0 });
                }
                let src_ansi = self.read_ansi(vmm, a0);
                let src_wide: Vec<u16> = mb_to_wide(ANSI_CODEPAGE, src_ansi.as_bytes());
                // Two passes, exactly like kernelbase: measure with a zero-length destination,
                // then materialise the full string. A single pass bounded by the *source* length
                // truncates any expansion that is longer than the format string.
                let (_, total) = self.expand_env_into(&src_wide, 0, &[]);
                let (full, _) = self.expand_env_into(&src_wide, total, &[]);
                let (bytes, _) = wide_to_mb(ANSI_CODEPAGE, &full[..total.min(full.len())]);
                let needed_a = bytes.len(); // includes the terminator
                let count = a2 as u32 as usize;
                if count > needed_a {
                    let _ = vmm.write_bytes(a1, &bytes);
                } else if a1 != 0 {
                    let _ = vmm.write_bytes(a1, &[0]);
                }
                if needed_a >= count {
                    (needed_a + 1) as u64
                } else {
                    needed_a as u64
                }
            }

            // ------------------------------------------------- tokens / profile
            //
            // environ.c:67-90 asks for the user profile directory through a process token. The
            // emulator has no security model, so the token is an opaque handle and every query
            // answers with the single local user.
            "OpenProcessToken" => {
                if a2 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let token = self.alloc_handle();
                let _ = vmm.write_u64(a2, token);
                1
            }
            "GetTokenInformation" => {
                // Only TOKEN_USER (1) is ever asked for; size it so the caller can proceed.
                if a4 == 0 {
                    self.set_last_error(ERROR_INSUFFICIENT_BUFFER);
                    return HleAction::Return(0);
                }
                let need = 32u32;
                if (a3 as u32) < need {
                    let _ = vmm.write_u32(a4, need);
                    self.set_last_error(ERROR_INSUFFICIENT_BUFFER);
                    return HleAction::Return(0);
                }
                let mut buf = [0u8; 32];
                // SID: revision 1, one sub-authority "BUILTIN\Users" style S-1-1-0.
                buf[0] = 1;
                buf[1] = 1;
                buf[7] = 0;
                let _ = vmm.write_bytes(a1, &buf);
                let _ = vmm.write_u32(a4, need);
                1
            }
            "GetUserProfileDirectoryA" | "GetUserProfileDirectoryW" => {
                let profile = "C:\\Users\\PORTHOLE";
                let wide = symbol.ends_with('W');
                let units: Vec<u16> = profile.encode_utf16().collect();
                let needed = if wide { units.len() + 1 } else { profile.len() + 1 };
                if a2 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let cap = vmm.read_u32(a2).unwrap_or(0) as usize;
                if cap < needed {
                    let _ = vmm.write_u32(a2, needed as u32);
                    self.set_last_error(ERROR_INSUFFICIENT_BUFFER);
                    return HleAction::Return(0);
                }
                let ok = if wide {
                    self.write_wide(vmm, a1, profile).is_ok()
                } else {
                    self.write_ansi(vmm, a1, profile).is_ok()
                };
                let _ = vmm.write_u32(a2, needed as u32);
                ok as u64
            }

            // -------------------------------------------------------- names
            "GetComputerNameA" => {
                let name = "PORTHOLE";
                if a1 == 0 {
                    return HleAction::Return(0);
                }
                let cap = vmm.read_u32(a1).unwrap_or(0) as usize;
                let needed = name.len();
                if cap < needed {
                    let _ = vmm.write_u32(a1, needed as u32);
                    self.set_last_error(ERROR_BUFFER_OVERFLOW);
                    return HleAction::Return(0);
                }
                let _ = self.write_ansi(vmm, a0, name);
                let _ = vmm.write_u32(a1, needed as u32);
                1
            }
            "GetComputerNameW" => {
                let name = "PORTHOLE";
                if a1 == 0 {
                    return HleAction::Return(0);
                }
                let cap = vmm.read_u32(a1).unwrap_or(0) as usize;
                let needed = name.len();
                if cap < needed {
                    let _ = vmm.write_u32(a1, needed as u32);
                    self.set_last_error(ERROR_BUFFER_OVERFLOW);
                    return HleAction::Return(0);
                }
                let _ = self.write_wide(vmm, a0, name);
                let _ = vmm.write_u32(a1, needed as u32);
                1
            }

            // ---------------------------------------------------- directories
            "GetWindowsDirectoryA" => self.get_dir_api(vmm, a0, a1, 0),
            "GetWindowsDirectoryW" => self.get_dir_api(vmm, a0, a1, 1),
            "GetSystemDirectoryA" => self.get_dir_api(vmm, a0, a1, 2),
            "GetSystemDirectoryW" => self.get_dir_api(vmm, a0, a1, 3),
            // GetTempPath/GetCurrentDirectory take `(nBufferLength, lpBuffer)` — length first,
            // unlike GetWindowsDirectory/GetSystemDirectory. The previous arms treated arg0 as
            // the buffer pointer and wrote the path at address `MAX_PATH` (a silent no-op into
            // unmapped memory), leaving the caller's buffer untouched. That single swap cascaded
            // into 14 of the Wine `directory` failures: every later path was built by appending
            // to a stale buffer that still ended in '*'.
            "GetTempPathA" => {
                let path = "C:\\Users\\PORTHOLE\\Temp\\";
                let need = path.len() + 1;
                if a1 == 0 || (a0 as usize) < need {
                    return HleAction::Return(need as u64);
                }
                let _ = self.write_ansi(vmm, a1, path);
                path.len() as u64
            }
            "GetTempPathW" => {
                let path = "C:\\Users\\PORTHOLE\\Temp\\";
                let need = path.len() + 1;
                if a1 == 0 || (a0 as usize) < need {
                    return HleAction::Return(need as u64);
                }
                let _ = self.write_wide(vmm, a1, path);
                path.len() as u64
            }
            "GetCurrentDirectoryA" => {
                let dir = self.cwd.clone();
                if a1 == 0 || (a0 as usize) <= dir.len() {
                    return HleAction::Return(dir.len() as u64 + 1);
                }
                let _ = self.write_ansi(vmm, a1, &dir);
                dir.len() as u64
            }
            "GetCurrentDirectoryW" => {
                let dir = self.cwd.clone();
                let chars = dir.encode_utf16().count();
                if a1 == 0 || (a0 as usize) <= chars {
                    return HleAction::Return(chars as u64 + 1);
                }
                let _ = self.write_wide(vmm, a1, &dir);
                chars as u64
            }
            "SetCurrentDirectoryA" | "SetCurrentDirectoryW" => {
                let raw = if symbol.ends_with('A') {
                    self.read_ansi(vmm, a0)
                } else {
                    self.read_wide(vmm, a0)
                };
                if raw.is_empty() {
                    self.set_last_error(ERROR_PATH_NOT_FOUND);
                    return HleAction::Return(0);
                }
                match self.canonical_path(&raw) {
                    Err(e) => {
                        self.set_last_error(e);
                        0
                    }
                    Ok(path) => {
                        let ok = self.dir_exists(&path);
                        self.note(format!(
                            "K SetCurrentDirectory raw={raw:?} path={path:?} exists={ok}"
                        ));
                        if ok {
                            self.cwd = path;
                            self.write_curdir(vmm);
                            1
                        } else {
                            // Wine distinguishes a missing leaf (FILE_NOT_FOUND) from a missing
                            // intermediate directory (PATH_NOT_FOUND).
                            let parent = Self::dir_of(&path);
                            self.set_last_error(if self.dir_exists(&parent) {
                                ERROR_FILE_NOT_FOUND
                            } else {
                                ERROR_PATH_NOT_FOUND
                            });
                            0
                        }
                    }
                }
            }
            "CreateDirectoryA" | "CreateDirectoryW" => {
                let raw = if symbol.ends_with('A') {
                    self.read_ansi(vmm, a0)
                } else {
                    self.read_wide(vmm, a0)
                };
                match self.canonical_path(&raw) {
                    Err(e) => {
                        self.set_last_error(e);
                        0
                    }
                    Ok(path) => {
                        let parent = Self::dir_of(&path);
                        let outcome = if self.dir_exists(&path) {
                            "already-exists"
                        } else if self.is_root(&path) {
                            "root-denied"
                        } else if !self.dir_exists(&parent) {
                            "no-parent"
                        } else {
                            "created"
                        };
                        self.note(format!(
                            "K CreateDirectoryA raw={raw:?} cwd={:?} path={path:?} parent={parent:?} -> {outcome}",
                            self.cwd
                        ));
                        if outcome == "already-exists" {
                            self.set_last_error(ERROR_ALREADY_EXISTS);
                            return HleAction::Return(0);
                        }
                        if outcome == "root-denied" {
                            self.set_last_error(ERROR_ACCESS_DENIED);
                            return HleAction::Return(0);
                        }
                        if outcome == "no-parent" {
                            self.set_last_error(ERROR_PATH_NOT_FOUND);
                            return HleAction::Return(0);
                        }
                        if self.lookup_file(&path).is_some() {
                            self.set_last_error(ERROR_ALREADY_EXISTS);
                            return HleAction::Return(0);
                        }
                        self.vfs_insert_directory(&path);
                        1
                    }
                }
            }
            "RemoveDirectoryA" | "RemoveDirectoryW" => {
                let raw = if symbol.ends_with('A') {
                    self.read_ansi(vmm, a0)
                } else {
                    self.read_wide(vmm, a0)
                };
                match self.canonical_path(&raw) {
                    Err(e) => {
                        self.set_last_error(e);
                        0
                    }
                    Ok(path) => {
                        if self.cwd.eq_ignore_ascii_case(&path) {
                            self.set_last_error(ERROR_SHARING_VIOLATION);
                            return HleAction::Return(0);
                        }
                        let has_children = self
                            .files
                            .values()
                            .any(|f| !f.path.eq_ignore_ascii_case(&path) && f.path.to_ascii_uppercase().starts_with(&format!("{}\\", path.to_ascii_uppercase())));
                        if !self.dir_exists(&path) || has_children {
                            self.set_last_error(if self.dir_exists(&path) {
                                ERROR_SHARING_VIOLATION
                            } else {
                                ERROR_PATH_NOT_FOUND
                            });
                            return HleAction::Return(0);
                        }
                        self.files.remove(&path.to_ascii_uppercase());
                        1
                    }
                }
            }

            // ---------------------------------------------------------- drives
            "GetLogicalDrives" => 1u64 << 2, // C: only
            "GetDriveTypeA" | "GetDriveTypeW" => {
                let raw = if symbol.ends_with('A') {
                    self.read_ansi(vmm, a0)
                } else {
                    self.read_wide(vmm, a0)
                };
                self.drive_type(&raw) as u64
            }
            "GetDiskFreeSpaceA" | "GetDiskFreeSpaceW" => {
                // A NULL path means "the root of the current drive", which succeeds; only the
                // empty string is an error (drive.c:146).
                let null_path = a0 == 0;
                let raw = if null_path {
                    "\\".to_string()
                } else if symbol.ends_with('A') {
                    self.read_ansi(vmm, a0)
                } else {
                    self.read_wide(vmm, a0)
                };
                let is_volume_guid = raw.starts_with("\\\\?\\") || raw.starts_with("\\??\\");
                let trimmed = raw.trim_end_matches('\\');
                let valid = null_path
                    || is_volume_guid
                    || trimmed.is_empty() && !raw.is_empty()
                    || trimmed.eq_ignore_ascii_case("c:")
                    || raw == "\\"
                    || raw == "/";
                if raw.is_empty() || !valid {
                    self.set_last_error(if raw.is_empty() {
                        ERROR_PATH_NOT_FOUND
                    } else {
                        ERROR_PATH_NOT_FOUND
                    });
                    return HleAction::Return(0);
                }
                if a1 != 0 {
                    let _ = vmm.write_u32(a1, 8);
                }
                if a2 != 0 {
                    let _ = vmm.write_u32(a2, 512);
                }
                if a3 != 0 {
                    let _ = vmm.write_u32(a3, 700);
                }
                if a4 != 0 {
                    let _ = vmm.write_u32(a4, 1000);
                }
                1
            }
            "GetDiskFreeSpaceExA" => {
                // PULARGE_INTEGER free, total, total_free
                if a1 != 0 {
                    let _ = vmm.write_u64(a1, 700 * 8 * 512);
                }
                if a2 != 0 {
                    let _ = vmm.write_u64(a2, 1000 * 8 * 512);
                }
                if a3 != 0 {
                    let _ = vmm.write_u64(a3, 1000 * 8 * 512);
                }
                1
            }
            "GetVolumeNameForVolumeMountPointA" | "GetVolumeNameForVolumeMountPointW" => {
                let name = "\\\\?\\Volume{PORTHOLE-C}\\";
                let need = name.len() + 1;
                if (a2 as usize) < need {
                    self.set_last_error(ERROR_INSUFFICIENT_BUFFER);
                    return HleAction::Return(0);
                }
                let ok = if symbol.ends_with('A') {
                    self.write_ansi(vmm, a1, name).is_ok()
                } else {
                    self.write_wide(vmm, a1, name).is_ok()
                };
                if ok {
                    1
                } else {
                    0
                }
            }

            // ------------------------------------------------------- power
            "GetSystemPowerStatus" => {
                if a0 != 0 {
                    // SYSTEM_POWER_STATUS { BYTE ACLineStatus; BYTE BatteryFlag;
                    // BYTE BatteryLifePercent; BYTE SystemStatusFlag; DWORD BatteryLifeTime;
                    // DWORD BatteryFullLifeTime; } = 12 bytes
                    let mut buf = [0u8; 12];
                    buf[0] = 1; // AC_LINE_ONLINE
                    buf[1] = 128; // BATTERY_FLAG_NO_BATTERY
                    buf[2] = 255; // BATTERY_PERCENTAGE_UNKNOWN
                    buf[3] = 0;
                    buf[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
                    buf[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
                    let _ = vmm.write_bytes(a0, &buf);
                }
                1
            }

            // ------------------------------------------------------- version
            "GetVersion" => 0x0A00_0000u64, // NT 10.0, high bit clear

            // --------------------------------------------------------- time
            "GetTickCount" | "GetTickCount64" => {
                self.ticks = self.ticks.wrapping_add(1);
                self.ticks
            }
            "Sleep" | "SleepEx" => 0,

            // -------------------------------------------------------- memory
            "GetProcessHeap" => self.process_heap,
            "HeapCreate" => {
                let base = self.alloc_handle();
                self.heaps.push(HeapState {
                    base,
                    next: 0,
                    end: 0,
                });
                // Lazily backed by VirtualAlloc pages when first used.
                base
            }
            "HeapAlloc" => {
                let idx = self.heaps.iter().position(|h| h.base == a0);
                if let Some(i) = idx {
                    if self.heaps[i].next == 0 {
                        let size = 0x0000_0000_0010_0000u64;
                        let va = vmm.virtual_alloc(0, size, MEM_COMMIT, PAGE_READWRITE);
                        self.heaps[i].next = va;
                        self.heaps[i].end = va + size;
                    }
                }
                self.heap_alloc(vmm, a0, a1)
            }
            "HeapFree" => {
                self.heap_free(a2);
                1
            }
            "HeapReAlloc" => self.heap_realloc(vmm, a0, a2, a3),
            "HeapSize" => self.heap_block_size(a2),
            "VirtualAlloc" => {
                let addr = vmm.virtual_alloc(a0, a1, a2 as u32, a3 as u32);
                if addr == 0 {
                    self.set_last_error(ERROR_NOT_ENOUGH_MEMORY);
                }
                addr
            }
            "VirtualFree" => {
                if vmm.virtual_free(a0, a1, a2 as u32) {
                    1
                } else {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    0
                }
            }
            "VirtualProtect" => {
                if a3 == 0 {
                    return HleAction::Return(0);
                }
                match vmm.virtual_protect(a0, a1, a2 as u32) {
                    Some(old) => {
                        let _ = vmm.write_u32(a3, old);
                        1
                    }
                    None => {
                        self.set_last_error(ERROR_INVALID_ADDRESS);
                        0
                    }
                }
            }
            "VirtualQuery" => {
                // MEMORY_BASIC_INFORMATION: BaseAddress@0, AllocationBase@8, AllocationProtect@16,
                // PartitionId@20, RegionSize@24, State@32, Protect@36, Type@40 => 48 bytes
                if a2 < 48 || a1 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let mut buf = [0u8; 48];
                if let Some(reg) = vmm.find_region(a0) {
                    let base = reg.base;
                    let size = reg.size;
                    let state = reg.state;
                    let protect = reg.protect;
                    let mem_type = reg.mem_type;
                    buf[0..8].copy_from_slice(&base.to_le_bytes());
                    buf[8..16].copy_from_slice(&base.to_le_bytes());
                    buf[16..20].copy_from_slice(&reg.allocation_protect.to_le_bytes());
                    buf[24..32].copy_from_slice(&size.to_le_bytes());
                    buf[32..36].copy_from_slice(&state.to_le_bytes());
                    buf[36..40].copy_from_slice(&protect.to_le_bytes());
                    buf[40..44].copy_from_slice(&mem_type.to_le_bytes());
                }
                let _ = vmm.write_bytes(a1, &buf);
                48
            }

            // -------------------------------------------------------- files
            "CreateFileW" | "CreateFileA" => {
                let path_raw = if symbol.ends_with('W') {
                    self.read_wide(vmm, a0)
                } else {
                    self.read_ansi(vmm, a0)
                };
                let create_disposition = a4 as u32;
                match self.canonical_path(&path_raw) {
                    Err(e) => {
                        self.set_last_error(e);
                        INVALID_HANDLE_VALUE
                    }
                    Ok(path) => {
                        if self.dir_exists(&path) {
                            // Directories can be opened read-only; report success with a dir handle.
                            let key = path.to_ascii_uppercase();
                            if let Some(f) = self.files.get_mut(&key) {
                                f.handle_count += 1;
                            }
                            let h = self.alloc_handle();
                            self.handle_map.insert(h, path.to_ascii_uppercase());
                            return HleAction::Return(h);
                        }
                        let exists = self.lookup_file(&path).is_some();
                        // CREATE_NEW=1, CREATE_ALWAYS=2, OPEN_EXISTING=3, OPEN_ALWAYS=4, TRUNCATE_EXISTING=5
                        if create_disposition == 1 && exists {
                            self.set_last_error(ERROR_FILE_NOT_FOUND);
                            return HleAction::Return(INVALID_HANDLE_VALUE);
                        }
                        if create_disposition == 3 && !exists {
                            self.set_last_error(ERROR_FILE_NOT_FOUND);
                            return HleAction::Return(INVALID_HANDLE_VALUE);
                        }
                        if create_disposition == 5 && !exists {
                            self.set_last_error(ERROR_FILE_NOT_FOUND);
                            return HleAction::Return(INVALID_HANDLE_VALUE);
                        }
                        if !exists && !self.parent_exists(&path) {
                            self.set_last_error(ERROR_PATH_NOT_FOUND);
                            return HleAction::Return(INVALID_HANDLE_VALUE);
                        }
                        let truncate = create_disposition == 2 || create_disposition == 5;
                        let key = path.to_ascii_uppercase();
                        let handle_key = key.clone();
                        let entry = self.files.entry(key).or_insert_with(|| GuestFile {
                            path: path.clone(),
                            data: Vec::new(),
                            position: 0,
                            writable: true,
                            is_directory: false,
                            handle_count: 0,
                        });
                        if truncate {
                            entry.data.clear();
                        }
                        entry.position = 0;
                        entry.handle_count += 1;
                        let handle = self.alloc_handle();
                        self.handle_map.insert(handle, handle_key);
                        handle
                    }
                }
            }
            "ReadFile" => {
                match self.handle_path(a0) {
                    Some(key) => {
                        let (chunk, pos) = {
                            let f = &self.files[&key];
                            let start = f.position as usize;
                            let end = (start + a2 as usize).min(f.data.len());
                            (f.data[start.min(end)..end].to_vec(), end)
                        };
                        if a1 != 0 && !chunk.is_empty() {
                            let _ = vmm.write_bytes(a1, &chunk);
                        }
                        if a3 != 0 {
                            let _ = vmm.write_u32(a3, chunk.len() as u32);
                        }
                        if let Some(f) = self.files.get_mut(&key) {
                            f.position = pos as u64;
                        }
                        1
                    }
                    None => {
                        self.set_last_error(ERROR_INVALID_HANDLE);
                        0
                    }
                }
            }
            "WriteFile" => match (a0 == STDOUT_HANDLE_VAL || a0 == STDERR_HANDLE_VAL)
                .then_some(())
            {
                Some(()) => {
                    let mut bytes = vec![0u8; a2 as usize];
                    if a1 == 0 || vmm.read_bytes(a1, &mut bytes).is_ok() {
                        self.stdout.extend_from_slice(&bytes);
                        if a3 != 0 {
                            let _ = vmm.write_u32(a3, bytes.len() as u32);
                        }
                        1
                    } else {
                        self.set_last_error(ERROR_INVALID_PARAMETER);
                        0
                    }
                }
                None => match self.handle_path(a0) {
                Some(key) => {
                    let mut bytes = vec![0u8; a2 as usize];
                    let read_ok = a1 == 0 || vmm.read_bytes(a1, &mut bytes).is_ok();
                    if read_ok {
                        if let Some(f) = self.files.get_mut(&key) {
                            let pos = f.position as usize;
                            if pos > f.data.len() {
                                f.data.resize(pos, 0);
                            }
                            if f.data.len() < pos + bytes.len() {
                                f.data.resize(pos + bytes.len(), 0);
                            }
                            f.data[pos..pos + bytes.len()].copy_from_slice(&bytes);
                            f.position = (pos + bytes.len()) as u64;
                        }
                        if a3 != 0 {
                            let _ = vmm.write_u32(a3, bytes.len() as u32);
                        }
                        1
                    } else {
                        self.set_last_error(ERROR_INVALID_PARAMETER);
                        0
                    }
                }
                None => {
                    self.set_last_error(ERROR_INVALID_HANDLE);
                    0
                }
                },
            },
            "SetEndOfFile" => match self.handle_path(a0) {
                Some(key) => {
                    if let Some(f) = self.files.get_mut(&key) {
                        let pos = f.position as usize;
                        f.data.resize(pos, 0);
                    }
                    1
                }
                None => {
                    self.set_last_error(ERROR_INVALID_HANDLE);
                    0
                }
            },
            "SetFileTime" => {
                if self.handle_path(a0).is_some()
                    || a0 == STDIN_HANDLE_VAL
                    || a0 == STDOUT_HANDLE_VAL
                    || a0 == STDERR_HANDLE_VAL
                {
                    1
                } else {
                    self.set_last_error(ERROR_INVALID_HANDLE);
                    0
                }
            }
            "GetFileInformationByHandle" => match self.handle_path(a0) {
                Some(key) => {
                    let (is_dir, size) = {
                        let f = &self.files[&key];
                        (f.is_directory, f.data.len() as u64)
                    };
                    if a1 != 0 {
                        let mut info = [0u8; 52];
                        let attrs: u32 = if is_dir { 0x10 } else { 0x80 };
                        info[0..4].copy_from_slice(&attrs.to_le_bytes());
                        for off in [4usize, 12, 20] {
                            info[off..off + 8].copy_from_slice(&FIXED_FILETIME.to_le_bytes());
                        }
                        info[28..32].copy_from_slice(&0xC0DE_0001u32.to_le_bytes());
                        info[32..36].copy_from_slice(&((size >> 32) as u32).to_le_bytes());
                        info[36..40].copy_from_slice(&(size as u32).to_le_bytes());
                        info[40..44].copy_from_slice(&1u32.to_le_bytes()); // nNumberOfLinks
                        let _ = vmm.write_bytes(a1, &info);
                    }
                    1
                }
                None => {
                    self.set_last_error(ERROR_INVALID_HANDLE);
                    0
                }
            },
            "SetFilePointer" => match self.handle_path(a0) {
                Some(key) => {
                    let new_pos = {
                        let f = &self.files[&key];
                        match a3 as u32 {
                            0 => a1 as u32 as u64, // FILE_BEGIN
                            1 => (f.position as i64 + a1 as u32 as i32 as i64).max(0) as u64,
                            _ => (f.data.len() as i64 + a1 as u32 as i32 as i64).max(0) as u64,
                        }
                    };
                    if let Some(f) = self.files.get_mut(&key) {
                        f.position = new_pos;
                    }
                    new_pos & 0xFFFF_FFFF
                }
                None => {
                    self.set_last_error(ERROR_INVALID_HANDLE);
                    0xFFFF_FFFF
                }
            },
            "GetFileSize" => match self.handle_path(a0) {
                Some(key) => {
                    let len = self.files[&key].data.len() as u32;
                    if a1 != 0 {
                        let _ = vmm.write_u32(a1, 0);
                    }
                    len as u64
                }
                None => {
                    self.set_last_error(ERROR_INVALID_HANDLE);
                    0xFFFF_FFFF
                }
            },
            "CloseHandle" => {
                self.close_handle(a0)
            }
            "FindFirstFileW" | "FindFirstFileA" => {
                let wide = symbol.ends_with('W');
                let raw = if wide {
                    self.read_wide(vmm, a0)
                } else {
                    self.read_ansi(vmm, a0)
                };
                let (entries, err) = self.find_candidates(&raw);
                if entries.is_empty() {
                    self.set_last_error(if err != 0 { err } else { ERROR_FILE_NOT_FOUND });
                    return HleAction::Return(INVALID_HANDLE_VALUE);
                }
                if a1 != 0 {
                    self.write_find_data(vmm, a1, wide, &entries[0].clone());
                }
                let h = self.alloc_handle();
                self.find_searches.insert(h, FindSearch { entries, next: 1 });
                h
            }
            "FindNextFileW" | "FindNextFileA" => {
                let wide = symbol.ends_with('W');
                let entry = match self.find_searches.get_mut(&a0) {
                    Some(s) if s.next < s.entries.len() => {
                        let e = s.entries[s.next].clone();
                        s.next += 1;
                        e
                    }
                    Some(_) => {
                        self.set_last_error(ERROR_NO_MORE_FILES);
                        return HleAction::Return(0);
                    }
                    None => {
                        self.set_last_error(ERROR_INVALID_HANDLE);
                        return HleAction::Return(0);
                    }
                };
                if a1 != 0 {
                    self.write_find_data(vmm, a1, wide, &entry);
                }
                1
            }
            "FindClose" => {
                if self.find_searches.remove(&a0).is_some() {
                    1
                } else {
                    self.set_last_error(ERROR_INVALID_HANDLE);
                    0
                }
            }
            "GetFileAttributesW" | "GetFileAttributesA" => {
                let raw = if symbol.ends_with('W') {
                    self.read_wide(vmm, a0)
                } else {
                    self.read_ansi(vmm, a0)
                };
                match self.canonical_path(&raw) {
                    Err(e) => {
                        self.set_last_error(e);
                        INVALID_FILE_ATTRIBUTES as u64
                    }
                    Ok(path) => {
                        if self.is_root(&path) {
                            0x10
                        } else if let Some(f) = self.lookup_file(&path) {
                            if f.is_directory { 0x10 } else { 0x80 }
                        } else {
                            self.set_last_error(if self.parent_exists(&path) {
                                ERROR_FILE_NOT_FOUND
                            } else {
                                ERROR_PATH_NOT_FOUND
                            });
                            INVALID_FILE_ATTRIBUTES as u64
                        }
                    }
                }
            }
            "SetFileAttributesW" | "SetFileAttributesA" => {
                let raw = if symbol.ends_with('W') {
                    self.read_wide(vmm, a0)
                } else {
                    self.read_ansi(vmm, a0)
                };
                match self.canonical_path(&raw) {
                    Err(e) => {
                        self.set_last_error(e);
                        0
                    }
                    Ok(path) => {
                        if self.is_root(&path) || self.lookup_file(&path).is_some() {
                            1
                        } else {
                            self.set_last_error(if self.parent_exists(&path) {
                                ERROR_FILE_NOT_FOUND
                            } else {
                                ERROR_PATH_NOT_FOUND
                            });
                            0
                        }
                    }
                }
            }
            "DeleteFileW" | "DeleteFileA" => {
                let raw = if symbol.ends_with('W') {
                    self.read_wide(vmm, a0)
                } else {
                    self.read_ansi(vmm, a0)
                };
                match self.canonical_path(&raw) {
                    Err(e) => {
                        self.set_last_error(e);
                        0
                    }
                    Ok(path) => {
                        let is_dir = self.lookup_file(&path).map(|f| f.is_directory);
                        match is_dir {
                            Some(true) => {
                                self.set_last_error(ERROR_ACCESS_DENIED);
                                0
                            }
                            Some(false) => {
                                self.files.remove(&path.to_ascii_uppercase());
                                1
                            }
                            None => {
                                self.set_last_error(if self.parent_exists(&path) {
                                    ERROR_FILE_NOT_FOUND
                                } else {
                                    ERROR_PATH_NOT_FOUND
                                });
                                0
                            }
                        }
                    }
                }
            }
            "MoveFileW" | "MoveFileA" | "MoveFileExW" | "MoveFileExA" => {
                let wide = symbol.ends_with('W');
                let src_raw = if wide { self.read_wide(vmm, a0) } else { self.read_ansi(vmm, a0) };
                let dst_raw = if wide { self.read_wide(vmm, a1) } else { self.read_ansi(vmm, a1) };
                let flags = if symbol.starts_with("MoveFileEx") { a2 as u32 } else { 0 };
                let src = match self.canonical_path(&src_raw) {
                    Ok(p) => p,
                    Err(e) => {
                        self.set_last_error(e);
                        return HleAction::Return(0);
                    }
                };
                let dst = match self.canonical_path(&dst_raw) {
                    Ok(p) => p,
                    Err(e) => {
                        self.set_last_error(e);
                        return HleAction::Return(0);
                    }
                };
                if self.lookup_file(&src).is_none() {
                    self.set_last_error(if self.parent_exists(&src) {
                        ERROR_FILE_NOT_FOUND
                    } else {
                        ERROR_PATH_NOT_FOUND
                    });
                    return HleAction::Return(0);
                }
                if self.lookup_file(&dst).is_some() && (flags & 1) == 0 {
                    self.set_last_error(ERROR_ALREADY_EXISTS);
                    return HleAction::Return(0);
                }
                if !self.parent_exists(&dst) {
                    self.set_last_error(ERROR_PATH_NOT_FOUND);
                    return HleAction::Return(0);
                }
                let src_key = src.to_ascii_uppercase();
                let dst_key = dst.to_ascii_uppercase();
                if let Some(mut f) = self.files.remove(&src_key) {
                    f.path = dst.clone();
                    self.files.insert(dst_key.clone(), f);
                    for key in self.handle_map.values_mut() {
                        if *key == src_key {
                            *key = dst_key.clone();
                        }
                    }
                }
                1
            }
            "CreateFileMappingW" | "CreateFileMappingA" => {
                let size = ((a3 & 0xFFFF_FFFF) << 32) | (a4 & 0xFFFF_FFFF);
                let file_key = if a0 == INVALID_HANDLE_VALUE {
                    None
                } else {
                    self.handle_path(a0)
                };
                let real_size = if size != 0 {
                    size
                } else {
                    file_key
                        .as_ref()
                        .map(|k| self.files[k].data.len() as u64)
                        .unwrap_or(0)
                };
                if real_size == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let va = self.next_mapping_va;
                let span = (real_size + 0xFFFF) & !0xFFFF;
                self.next_mapping_va = va + span + 0x1_0000;
                vmm.map_region(va, span, PAGE_READWRITE, MEM_COMMIT, MEM_PRIVATE, false);
                if let Some(key) = file_key.clone() {
                    let data = self.files[&key].data.clone();
                    if !data.is_empty() {
                        let _ = vmm.host_write_bytes(va, &data[..data.len().min(real_size as usize)]);
                    }
                }
                let h = self.alloc_handle();
                self.file_mappings.insert(
                    h,
                    FileMapping { file_key, size: real_size, va },
                );
                h
            }
            "OpenFileMappingW" | "OpenFileMappingA" => {
                self.set_last_error(ERROR_FILE_NOT_FOUND);
                0
            }
            "MapViewOfFile" => {
                match self.file_mappings.get(&a0) {
                    Some(m) => {
                        let off = ((a2 & 0xFFFF_FFFF) << 32) | (a3 & 0xFFFF_FFFF);
                        m.va + off
                    }
                    None => {
                        self.set_last_error(ERROR_INVALID_HANDLE);
                        0
                    }
                }
            }
            "UnmapViewOfFile" => {
                let found = self
                    .file_mappings
                    .values()
                    .find(|m| a0 >= m.va && a0 < m.va + m.size.max(1))
                    .cloned();
                match found {
                    Some(m) => {
                        if let Some(key) = m.file_key {
                            let mut buf = vec![0u8; m.size as usize];
                            if vmm.read_bytes(m.va, &mut buf).is_ok() {
                                if let Some(f) = self.files.get_mut(&key) {
                                    f.data = buf;
                                }
                            }
                        }
                        1
                    }
                    None => {
                        self.set_last_error(ERROR_INVALID_ADDRESS);
                        0
                    }
                }
            }

            // ------------------------------------------------- system information
            "GetSystemInfo" => {
                if a0 != 0 {
                    let mut info = [0u8; 48];
                    info[0..2].copy_from_slice(&9u16.to_le_bytes()); // PROCESSOR_ARCHITECTURE_AMD64
                    info[4..8].copy_from_slice(&4096u32.to_le_bytes());
                    info[8..16].copy_from_slice(&0x1_0000u64.to_le_bytes());
                    info[16..24].copy_from_slice(&0x0000_7FFF_FFFE_FFFFu64.to_le_bytes());
                    info[24..32].copy_from_slice(&1u64.to_le_bytes()); // active processor mask
                    info[32..36].copy_from_slice(&1u32.to_le_bytes()); // number of processors
                    info[36..40].copy_from_slice(&8664u32.to_le_bytes());
                    info[40..44].copy_from_slice(&0x1_0000u32.to_le_bytes()); // alloc granularity
                    info[44..46].copy_from_slice(&6u16.to_le_bytes());
                    let _ = vmm.write_bytes(a0, &info);
                }
                0
            }
            "GlobalMemoryStatusEx" => {
                if a0 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let mut st = [0u8; 64];
                st[0..4].copy_from_slice(&64u32.to_le_bytes());
                st[4..8].copy_from_slice(&30u32.to_le_bytes()); // dwMemoryLoad
                let gib: u64 = 1 << 30;
                st[8..16].copy_from_slice(&(4 * gib).to_le_bytes());
                st[16..24].copy_from_slice(&(3 * gib).to_le_bytes());
                st[24..32].copy_from_slice(&(8 * gib).to_le_bytes());
                st[32..40].copy_from_slice(&(6 * gib).to_le_bytes());
                st[40..48].copy_from_slice(&0x0000_7FF0_0000_0000u64.to_le_bytes());
                st[48..56].copy_from_slice(&0x0000_7FE0_0000_0000u64.to_le_bytes());
                let _ = vmm.write_bytes(a0, &st);
                1
            }
            "GetVersionExW" | "GetVersionExA" => {
                if a0 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let size = vmm.read_u32(a0).unwrap_or(0);
                if size < 20 {
                    self.set_last_error(ERROR_INSUFFICIENT_BUFFER);
                    return HleAction::Return(0);
                }
                let _ = vmm.write_u32(a0 + 4, 10);
                let _ = vmm.write_u32(a0 + 8, 0);
                let _ = vmm.write_u32(a0 + 12, 19045);
                let _ = vmm.write_u32(a0 + 16, 2); // VER_PLATFORM_WIN32_NT
                if symbol.ends_with('W') {
                    let _ = vmm.write_u16(a0 + 20, 0);
                } else {
                    let _ = vmm.write_u8(a0 + 20, 0);
                }
                1
            }
            "IsProcessorFeaturePresent" => {
                match a0 as u32 {
                    3 | 6 | 10 | 13 => 1, // MMX / SSE / SSE2 / SSE3
                    _ => 0,
                }
            }
            "QueryPerformanceFrequency" => {
                if a0 != 0 {
                    let _ = vmm.write_u64(a0, 10_000_000);
                }
                1
            }
            "QueryPerformanceCounter" => {
                self.qpc_ticks = self.qpc_ticks.wrapping_add(10_000);
                if a0 != 0 {
                    let _ = vmm.write_u64(a0, self.qpc_ticks);
                }
                1
            }
            "GetProcessTimes" => {
                for (i, ptr) in [a1, a2, a3, a4].into_iter().enumerate() {
                    if ptr != 0 {
                        let _ = vmm.write_u64(ptr, if i == 0 { FIXED_FILETIME } else { 0 });
                    }
                }
                1
            }
            "GetSystemTimeAsFileTime" => {
                if a0 != 0 {
                    let _ = vmm.write_u64(a0, FIXED_FILETIME);
                }
                0
            }
            "FileTimeToSystemTime" => {
                if a0 == 0 || a1 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let ft = vmm.read_u64(a0).unwrap_or(0);
                let (y, mo, dow, d, h, mi, s, ms) = Self::filetime_to_civil(ft);
                let fields = [y, mo, dow, d, h, mi, s, ms];
                for (i, v) in fields.into_iter().enumerate() {
                    let _ = vmm.write_u16(a1 + (i as u64) * 2, v);
                }
                1
            }
            "FileTimeToDosDateTime" => {
                if a0 == 0 || a1 == 0 || a2 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let ft = vmm.read_u64(a0).unwrap_or(0);
                let (y, mo, _dow, d, h, mi, s, _ms) = Self::filetime_to_civil(ft);
                if !(1980..=2107).contains(&(y as i32)) {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let dos_date = (((y - 1980) as u16) << 9) | (mo << 5) | d;
                let dos_time = (h << 11) | (mi << 5) | (s / 2);
                let _ = vmm.write_u16(a1, dos_date);
                let _ = vmm.write_u16(a2, dos_time);
                1
            }
            "DosDateTimeToFileTime" => {
                if a2 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let date = a0 as u32;
                let time = a1 as u32;
                let year = 1980 + ((date >> 9) & 0x7F) as i64;
                let month = (date >> 5) & 0xF;
                let day = date & 0x1F;
                let hour = (time >> 11) & 0x1F;
                let min = (time >> 5) & 0x3F;
                let sec = (time & 0x1F) * 2;
                let ft = Self::civil_to_filetime(year, month, day, hour, min, sec);
                let _ = vmm.write_u64(a2, ft);
                1
            }
            "FileTimeToLocalFileTime" | "LocalFileTimeToFileTime" => {
                if a0 == 0 || a1 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let ft = vmm.read_u64(a0).unwrap_or(0);
                let _ = vmm.write_u64(a1, ft); // guest zone is UTC by construction
                1
            }
            "CompareFileTime" => {
                let l = if a0 != 0 { vmm.read_u64(a0).unwrap_or(0) } else { 0 };
                let r = if a1 != 0 { vmm.read_u64(a1).unwrap_or(0) } else { 0 };
                match l.cmp(&r) {
                    std::cmp::Ordering::Less => (-1i64) as u64,
                    std::cmp::Ordering::Equal => 0,
                    std::cmp::Ordering::Greater => 1,
                }
            }
            "GetProcessAffinityMask" => {
                if a1 != 0 {
                    let _ = vmm.write_u64(a1, 1);
                }
                if a2 != 0 {
                    let _ = vmm.write_u64(a2, 1);
                }
                1
            }
            "SetProcessAffinityMask" => 1,
            "SetThreadAffinityMask" => 1,
            "ResumeThread" => 1,
            "LocalFree" => {
                self.heap_free(a0);
                0
            }
            "GetLogicalDriveStringsW" | "GetLogicalDriveStringsA" => {
                let wide = symbol.ends_with('W');
                let required: u64 = 5; // "C:\\" + NUL + final NUL
                if a1 == 0 || a0 < required {
                    return HleAction::Return(required);
                }
                if wide {
                    let units: [u16; 5] = [b'C' as u16, b':' as u16, b'\\' as u16, 0, 0];
                    for (i, u) in units.iter().enumerate() {
                        let _ = vmm.write_u16(a1 + (i as u64) * 2, *u);
                    }
                } else {
                    let _ = vmm.write_bytes(a1, b"C:\\\0\0");
                }
                4
            }
            "DeviceIoControl" => {
                if a6 != 0 {
                    let _ = vmm.write_u32(a6, 0);
                }
                self.set_last_error(ERROR_NOT_SUPPORTED);
                0
            }
            "FormatMessageW" | "FormatMessageA" => {
                let wide = symbol.ends_with('W');
                let msg = format!("Windows error {}", a2 as u32);
                let chars = msg.chars().count() as u64;
                if (a0 as u32) & 0x100 != 0 {
                    // FORMAT_MESSAGE_ALLOCATE_BUFFER
                    let bytes = if wide { (chars + 1) * 2 } else { chars + 1 };
                    let va = self.heap_alloc(vmm, self.process_heap, bytes);
                    if va == 0 || a4 == 0 {
                        self.set_last_error(ERROR_NOT_ENOUGH_MEMORY);
                        return HleAction::Return(0);
                    }
                    if wide {
                        let _ = self.write_wide(vmm, va, &msg);
                    } else {
                        let _ = self.write_ansi(vmm, va, &msg);
                    }
                    let _ = vmm.write_u64(a4, va);
                    chars
                } else if a4 != 0 && a5 > chars {
                    if wide {
                        let _ = self.write_wide(vmm, a4, &msg);
                    } else {
                        let _ = self.write_ansi(vmm, a4, &msg);
                    }
                    chars
                } else {
                    self.set_last_error(ERROR_INSUFFICIENT_BUFFER);
                    0
                }
            }
            "GetModuleFileNameW" | "GetModuleFileNameA" => {
                let wide = symbol.ends_with('W');
                let path = if a0 == 0 || a0 == self.image_base() {
                    self.module_file_name()
                } else {
                    match self.modules.iter().find(|(_, &va)| va == a0) {
                        Some((name, _)) => format!("C:\\Windows\\System32\\{}", name),
                        None => {
                            self.set_last_error(ERROR_MOD_NOT_FOUND);
                            return HleAction::Return(0);
                        }
                    }
                };
                if a1 == 0 || a2 == 0 {
                    self.set_last_error(ERROR_INSUFFICIENT_BUFFER);
                    return HleAction::Return(0);
                }
                if wide {
                    let units: Vec<u16> = path.encode_utf16().collect();
                    if (a2 as usize) > units.len() {
                        let _ = self.write_wide(vmm, a1, &path);
                        units.len() as u64
                    } else {
                        for i in 0..(a2 as usize - 1) {
                            let _ = vmm.write_u16(a1 + (i as u64) * 2, units[i]);
                        }
                        let _ = vmm.write_u16(a1 + (a2 - 1) * 2, 0);
                        self.set_last_error(ERROR_INSUFFICIENT_BUFFER);
                        a2
                    }
                } else {
                    let (bytes, _) =
                        wide_to_mb(ANSI_CODEPAGE, &path.encode_utf16().collect::<Vec<_>>());
                    if (a2 as usize) > bytes.len() {
                        let _ = self.write_ansi(vmm, a1, &path);
                        bytes.len() as u64
                    } else {
                        let _ = vmm.write_bytes(a1, &bytes[..(a2 as usize - 1)]);
                        let _ = vmm.write_u8(a1 + a2 - 1, 0);
                        self.set_last_error(ERROR_INSUFFICIENT_BUFFER);
                        a2
                    }
                }
            }
            "GetComputerNameExW" | "GetComputerNameExA" => {
                let wide = symbol.ends_with('W');
                let value: &str = match a0 as u32 {
                    2 | 6 => "",          // DnsDomain (no domain)
                    1 | 5 | 3 | 7 => "porthole", // DnsHostname / DnsFullyQualified
                    _ => "PORTHOLE",      // NetBIOS and anything else
                };
                if a2 == 0 {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    return HleAction::Return(0);
                }
                let cap = vmm.read_u32(a2).unwrap_or(0) as usize;
                let needed = value.encode_utf16().count() + 1; // including NUL (environ.c)
                if a1 == 0 || cap < needed {
                    let _ = vmm.write_u32(a2, needed as u32);
                    self.set_last_error(ERROR_MORE_DATA);
                    return HleAction::Return(0);
                }
                if wide {
                    let _ = self.write_wide(vmm, a1, value);
                } else {
                    let _ = self.write_ansi(vmm, a1, value);
                }
                let _ = vmm.write_u32(a2, (needed - 1) as u32);
                1
            }
            "NtQueryObject" => {
                // NtQueryObject(Handle=a0, ObjectInformationClass=a1, ObjectInformation=a2,
                // Length=a3, ReturnLength=a4). Only ObjectBasicInformation (0) is modelled:
                // 56 bytes on x64, Attributes @0, GrantedAccess @4, HandleCount @8,
                // PointerCount @12.
                if a1 != 0 {
                    return HleAction::Return(0xC000_0003u64); // STATUS_INVALID_INFO_CLASS
                }
                if a4 != 0 {
                    let _ = vmm.write_u32(a4, 56);
                }
                if a3 < 56 {
                    return HleAction::Return(0xC000_0004u64); // STATUS_INFO_LENGTH_MISMATCH
                }
                let granted: u32 = if a0 == CURDIR_HANDLE {
                    0x0010_0020 // FILE_TRAVERSE | SYNCHRONIZE (directory.c TEST_GRANTED_ACCESS)
                } else {
                    0x0012_019F // generic file read/write access set
                };
                let mut info = [0u8; 56];
                info[4..8].copy_from_slice(&granted.to_le_bytes());
                info[8..12].copy_from_slice(&1u32.to_le_bytes());
                info[12..16].copy_from_slice(&1u32.to_le_bytes());
                let _ = vmm.write_bytes(a2, &info);
                0
            }
            // ------------------------------------------------- registry (read-only misses)
            "RegOpenKeyExW" | "RegOpenKeyExA" | "RegOpenKeyW" | "RegOpenKeyA" => {
                if a4 != 0 {
                    let _ = vmm.write_u64(a4, 0);
                }
                ERROR_FILE_NOT_FOUND as u64
            }
            "RegQueryValueExW" | "RegQueryValueExA" | "RegQueryValueW" | "RegQueryValueA" => {
                ERROR_FILE_NOT_FOUND as u64
            }
            "RegCloseKey" => 0,
            // ------------------------------------------------- advapi32 security surface
            "SystemFunction036" => {
                // RtlGenRandom: deterministic xorshift fill (guest uses it for temp names/IVs).
                let mut state = 0x9E37_79B9_7F4A_7C15u64 ^ (self.qpc_ticks << 1) ^ (a1 << 7);
                let n = (a1 as usize).min(1 << 20);
                let mut buf = vec![0u8; n];
                for b in buf.iter_mut() {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    *b = (state >> 32) as u8;
                }
                if a0 != 0 && n > 0 {
                    let _ = vmm.write_bytes(a0, &buf);
                }
                1
            }
            "LookupPrivilegeValueW" | "LookupPrivilegeValueA" => {
                if a2 != 0 {
                    let _ = vmm.write_u32(a2, 1);
                    let _ = vmm.write_u32(a2 + 4, 0);
                }
                1
            }
            "AdjustTokenPrivileges" => {
                self.set_last_error(ERROR_SUCCESS);
                1
            }
            "GetFileSecurityW" | "SetFileSecurityW" | "GetFileSecurityA" | "SetFileSecurityA" => {
                self.set_last_error(ERROR_NOT_SUPPORTED);
                0
            }
            // ------------------------------------------------- semaphores / events (open)
            "CreateSemaphoreW" | "CreateSemaphoreA" => {
                let h = self.alloc_handle();
                self.semaphores.insert(h, a1 as u32 as i32);
                h
            }
            "ReleaseSemaphore" => {
                match self.semaphores.get_mut(&a0) {
                    Some(count) => {
                        let prev = *count;
                        *count += a1 as u32 as i32;
                        if a2 != 0 {
                            let _ = vmm.write_u32(a2, prev as u32);
                        }
                        1
                    }
                    None => {
                        self.set_last_error(ERROR_INVALID_HANDLE);
                        0
                    }
                }
            }
            "OpenEventW" | "OpenEventA" => {
                self.set_last_error(ERROR_FILE_NOT_FOUND);
                0
            }

            // ------------------------------------------------------- threads
            "GetCurrentProcess" => 0xFFFF_FFFF_FFFF_FFFF,
            "GetCurrentProcessId" => 0x1000,
            "GetCurrentThread" => 0xFFFF_FFFF_FFFF_FFFE,
            "GetCurrentThreadId" => 0x1004,
            "CreateThread" => {
                let entry = a2;
                let param = a3;
                let handle = self.alloc_handle();
                let tls_signal = self.alloc_handle();
                let base = 0x0000_0000_0300_0000u64 + (self.threads.len() as u64) * 0x0000_0000_0010_0000;
                let top = base + 0x0000_0000_0008_0000;
                self.threads.push(GuestThread {
                    handle,
                    teb_addr: 0,
                    stack_top: top,
                    stack_base: base,
                    entry,
                    param,
                    exit_code: STILL_ACTIVE,
                    finished: false,
                    started: false,
                    signal_handle: tls_signal,
                });
                if a5 != 0 {
                    let _ = vmm.write_u32(a5, 0x2000 + self.threads.len() as u32);
                }
                handle
            }
            "GetExitCodeThread" => {
                if let Some(t) = self.threads.iter().find(|t| t.handle == a0) {
                    if a1 != 0 {
                        let _ = vmm.write_u32(a1, t.exit_code);
                    }
                    1
                } else {
                    1
                }
            }
            "GetExitCodeProcess" => {
                let code = match self.exit_code {
                    Some(c) => c,
                    None => STILL_ACTIVE,
                };
                if a1 != 0 {
                    let _ = vmm.write_u32(a1, code);
                }
                1
            }
            "ExitProcess" | "ExitThread" => {
                if symbol == "ExitProcess" {
                    self.exit_code = Some(a0 as u32);
                    return HleAction::ExitProcess(a0 as u32);
                }
                0
            }
            "TlsAlloc" => {
                for (i, slot) in self.tls_slots.iter_mut().enumerate() {
                    if slot.is_none() {
                        *slot = Some(0);
                        return HleAction::Return(i as u64);
                    }
                }
                0xFFFF_FFFF
            }
            "TlsGetValue" => self
                .tls_slots
                .get(a0 as usize)
                .copied()
                .flatten()
                .unwrap_or(0),
            "TlsSetValue" => {
                if let Some(slot) = self.tls_slots.get_mut(a0 as usize) {
                    *slot = Some(a1);
                    1
                } else {
                    self.set_last_error(ERROR_INVALID_PARAMETER);
                    0
                }
            }
            "TlsFree" => {
                if let Some(slot) = self.tls_slots.get_mut(a0 as usize) {
                    *slot = None;
                    1
                } else {
                    0
                }
            }

            // -------------------------------------------------- sync primitives
            "CreateEventA" | "CreateEventW" => {
                let manual = a1 as u32 != 0;
                let initial = a2 as u32 != 0;
                let h = self.alloc_handle();
                self.waitables.insert(
                    h,
                    Waitable {
                        signaled: initial,
                        manual_reset: manual,
                    },
                );
                h
            }
            "CreateMutexA" | "CreateMutexW" => {
                let h = self.alloc_handle();
                self.waitables.insert(
                    h,
                    Waitable {
                        signaled: a1 as u32 != 0,
                        manual_reset: false,
                    },
                );
                h
            }
            "ReleaseMutex" => {
                if let Some(w) = self.waitables.get_mut(&a0) {
                    w.signaled = true;
                }
                1
            }
            "SetEvent" => {
                if let Some(w) = self.waitables.get_mut(&a0) {
                    w.signaled = true;
                    1
                } else {
                    0
                }
            }
            "ResetEvent" => {
                if let Some(w) = self.waitables.get_mut(&a0) {
                    w.signaled = false;
                    1
                } else {
                    0
                }
            }
            "WaitForSingleObject" => {
                if a0 == 0xFFFF_FFFF_FFFF_FFFF || a0 == 0xFFFF_FFFF_FFFF_FFFE {
                    return HleAction::Return(WAIT_OBJECT_0 as u64);
                }
                if let Some(count) = self.semaphores.get_mut(&a0) {
                    if *count > 0 {
                        *count -= 1;
                        return HleAction::Return(WAIT_OBJECT_0 as u64);
                    }
                    // No second thread exists to release this semaphore in the single-thread
                    // driver; reporting WAIT_TIMEOUT keeps the stall visible instead of
                    // silently succeeding desynchronised.
                    self.note(format!(
                        "K WaitForSingleObject semaphore 0x{a0:x} at zero count would block (timeout={a1})"
                    ));
                    return HleAction::Return(WAIT_TIMEOUT as u64);
                }
                if let Some(w) = self.waitables.get_mut(&a0) {
                    if w.signaled {
                        if !w.manual_reset {
                            w.signaled = false;
                        }
                        return HleAction::Return(WAIT_OBJECT_0 as u64);
                    }
                }
                // A guest thread handle: run pending threads cooperatively, then report signaled.
                if self.threads.iter().any(|t| t.handle == a0) {
                    if self.run_pending_threads_for(vmm, a0) {
                        return HleAction::Return(WAIT_OBJECT_0 as u64);
                    }
                }
                WAIT_OBJECT_0 as u64
            }
            "WaitForMultipleObjects" => {
                let count = (a0 as usize).min(64);
                let array = a1;
                let wait_all = a2 as u32 != 0;
                let mut handles = [0u64; 64];
                for i in 0..count {
                    handles[i] = vmm.read_u64(array + (i as u64) * 8).unwrap_or(0);
                }
                let any_thread = handles[..count]
                    .iter()
                    .any(|&h| self.threads.iter().any(|t| t.handle == h));
                if any_thread {
                    self.run_all_pending_threads(vmm);
                }
                if wait_all {
                    WAIT_OBJECT_0 as u64
                } else {
                    WAIT_OBJECT_0 as u64
                }
            }
            "InitializeCriticalSection" => {
                self.crit_sections.insert(a0, 0);
                0
            }
            "EnterCriticalSection" => {
                let e = self.crit_sections.entry(a0).or_insert(0);
                *e += 1;
                0
            }
            "LeaveCriticalSection" => {
                if let Some(e) = self.crit_sections.get_mut(&a0) {
                    *e = e.saturating_sub(1);
                }
                0
            }
            "DeleteCriticalSection" => {
                self.crit_sections.remove(&a0);
                0
            }

            // ------------------------------------------------------- modules
            "GetModuleHandleA" | "GetModuleHandleW" => {
                if a0 == 0 {
                    return HleAction::Return(self.image_base());
                }
                let name = if symbol.ends_with('A') {
                    self.read_ansi(vmm, a0)
                } else {
                    self.read_wide(vmm, a0)
                };
                self.module_handle(&name)
            }
            "LoadLibraryA" | "LoadLibraryW" | "LoadLibraryExA" | "LoadLibraryExW" => {
                let name = if symbol.contains('A') {
                    self.read_ansi(vmm, a0)
                } else {
                    self.read_wide(vmm, a0)
                };
                // dxcore.dll is intentionally not implemented: the d3d12 test then skips the
                // DXCore adapter path instead of exercising a stub.
                if name.to_ascii_lowercase().starts_with("dxcore") {
                    self.set_last_error(ERROR_MOD_NOT_FOUND);
                    return HleAction::Return(0);
                }
                if name.eq_ignore_ascii_case("userenv.dll") {
                    self.set_last_error(ERROR_MOD_NOT_FOUND);
                    return HleAction::Return(0);
                }
                self.module_handle(&name)
            }
            "FreeLibrary" => 1,
            "GetProcAddress" => {
                let hmod = a0;
                let (name, ord) = if a1 < 0x1_0000 {
                    (String::new(), a1 as u16)
                } else {
                    (self.read_ansi(vmm, a1), 0)
                };
                self.resolve_proc_address(vmm, hmod, &name, ord)
            }

            // --------------------------------------------------------- console
            "_fileno" => 1,
            "_isatty" => 0,
            "_get_osfhandle" => {
                let h = self.alloc_handle();
                h
            }
            "fflush" | "setvbuf" | "_set_new_mode" | "_set_app_type"
            | "_set_invalid_parameter_handler" | "signal" | "_fpreset"
            | "__setusermatherr" | "_configure_narrow_argv" | "_configure_wide_argv"
            | "_initialize_narrow_environment" | "_initialize_wide_environment"
            | "_crt_atexit" | "_crt_at_quick_exit" | "_tzset" => 0,
            "_initterm" | "_initterm_e" => {
                // Iterate the constructor table, calling each non-null pointer.
                //
                // The handler is re-entered through the same thunk after every upcalled
                // constructor returns, and the constructor is free to clobber RCX/RDX, so the
                // in-flight frame (not the argument registers) is the source of truth while an
                // iteration is suspended.
                if let Some(UpcallState::Initterm {
                    next_slot,
                    end: saved_end,
                    resume_rip,
                    ..
                }) = self.upcall_stack.last().cloned()
                {
                    if let Some((slot, target)) =
                        self.find_next_initterm_fn(vmm, next_slot, saved_end)
                    {
                        if let Some(UpcallState::Initterm { next_slot: ns, .. }) =
                            self.upcall_stack.last_mut()
                        {
                            *ns = slot + 8;
                        }
                        return HleAction::Upcall {
                            target,
                            resume_rip,
                            rax: 0,
                        };
                    }
                    self.upcall_stack.pop();
                    return HleAction::Return(0);
                }
                let start = a0;
                let end = a1;
                if start == 0 || end <= start {
                    return HleAction::Return(0);
                }
                if let Some((slot, target)) = self.find_next_initterm_fn(vmm, start, end) {
                    self.note(format!(
                        "K _initterm start=0x{start:x} end=0x{end:x} slot=0x{slot:x} target=0x{target:x}"
                    ));
                    self.upcall_stack.push(UpcallState::Initterm {
                        start,
                        next_slot: slot + 8,
                        end,
                        resume_rip: call_rip,
                    });
                    return HleAction::Upcall {
                        target,
                        resume_rip: call_rip,
                        rax: 0,
                    };
                }
                0
            }
            "__acrt_iob_func" => {
                // Return stable unique FILE* sentinels for stdin/stdout/stderr (index in a1).
                let idx = a0 & 3;
                0x0000_7FFE_0003_0000u64 + idx * 0x100
            }
            "__stdio_common_vfprintf" | "__stdio_common_vfprintf_s" => {
                // (options, stream, format, locale, arglist) -> chars written
                self.vfprintf(vmm, a2, a4)
            }
            "__stdio_common_vfwprintf" | "__stdio_common_vfwprintf_s" => {
                self.vfwprintf(vmm, a2, a4)
            }
            "__stdio_common_vsprintf" | "__stdio_common_vsprintf_s" => {
                // (options, buffer, size, format, locale, arglist)
                let text = self.format_ansi(vmm, a3, a5);
                let mut bytes = text.clone();
                bytes.push(0);
                if a1 != 0 && a2 > 0 {
                    let cap = a2 as usize;
                    let n = bytes.len().min(cap);
                    let _ = vmm.write_bytes(a1, &bytes[..n]);
                }
                text.len() as u64
            }
            "fwrite" => {
                // size_t fwrite(const void *ptr=a0, size_t size=a1, size_t count=a2, FILE *stream=a3)
                let total = a1.wrapping_mul(a2) as usize;
                if a0 != 0 && total > 0 {
                    let mut buf = vec![0u8; total];
                    if vmm.read_bytes(a0, &mut buf).is_ok() {
                        self.stdout.extend_from_slice(&buf);
                    }
                }
                a2
            }
            "puts" => {
                let s = self.read_ansi(vmm, a0);
                self.stdout.extend_from_slice(s.as_bytes());
                self.stdout.push(b'\n');
                0
            }
            "_exit" | "exit" | "abort" | "_cexit" | "_c_exit" | "quick_exit" => {
                if symbol == "exit" || symbol == "_exit" {
                    self.exit_code = Some(a0 as u32);
                    return HleAction::ExitProcess(a0 as u32);
                }
                if symbol == "abort" {
                    self.exit_code = Some(3);
                    return HleAction::ExitProcess(3);
                }
                0
            }
            "_errno" | "__p__commode" | "__p__fmode" => {
                let va = self.heap_alloc(vmm, self.process_heap, 8);
                if va != 0 {
                    let _ = vmm.write_u32(va, 0);
                }
                va
            }
            "__p___argc" => {
                let (argc, _, _) = self.ensure_crt_argv(vmm);
                argc
            }
            // `__p___argv` returns a `char***`: the address of the `__argv` *variable*, which in
            // turn holds the address of the NULL-terminated vector. The caller dereferences it
            // once (`mov (%rax),%rax` at 0x425510 in user32_test), so returning the vector
            // directly makes the guest treat argv[0]'s characters ("test.exe") as a pointer.
            "__p___argv" => {
                let (_, argv, _) = self.ensure_crt_argv(vmm);
                argv
            }
            "__p___wargv" => {
                let (_, _, wargv) = self.ensure_crt_argv(vmm);
                wargv
            }
            "__p__environ" => {
                self.ensure_crt_argv(vmm);
                self.crt_environ_var
            }
            "__p__wenviron" => {
                self.ensure_crt_argv(vmm);
                self.crt_wenviron_var
            }
            // ------------------------------------------- old-msvcrt startup (7za)
            "__set_app_type" => {
                self.app_type = a0 as u32;
                0
            }
            "__getmainargs" => {
                // int __getmainargs(int *pargc, char ***pargv, char ***penvp, int doWildcard,
                //                   _startupinfo *startInfo)
                let (argc_ptr, argv_var, _) = self.ensure_crt_argv(vmm);
                let argc = if argc_ptr != 0 {
                    vmm.read_u32(argc_ptr).unwrap_or(0)
                } else {
                    0
                };
                let argv = if argv_var != 0 {
                    vmm.read_u64(argv_var).unwrap_or(0)
                } else {
                    0
                };
                let envp = if self.crt_environ_var != 0 {
                    vmm.read_u64(self.crt_environ_var).unwrap_or(0)
                } else {
                    0
                };
                if a0 != 0 {
                    let _ = vmm.write_u32(a0, argc);
                }
                if a1 != 0 {
                    let _ = vmm.write_u64(a1, argv);
                }
                if a2 != 0 {
                    let _ = vmm.write_u64(a2, envp);
                }
                if self.initenv_cell != 0 {
                    let _ = vmm.write_u64(self.initenv_cell, envp);
                }
                if a4 != 0 {
                    let _ = vmm.write_u32(a4, 0); // _startupinfo.newmode
                }
                0
            }
            "_onexit" => {
                if a0 != 0 {
                    self.atexit_funcs.push(a0);
                }
                a0
            }
            "__dllonexit" => {
                // __dllonexit(func, **pbegin, **pend): append `func` to the caller's onexit
                // table (growing it when full), mirroring Wine's MSVCRT___dllonexit contract.
                if a0 != 0 {
                    self.atexit_funcs.push(a0);
                }
                if a1 != 0 && a2 != 0 && a0 != 0 {
                    let begin = vmm.read_u64(a1).unwrap_or(0);
                    let end = vmm.read_u64(a2).unwrap_or(0);
                    let mut placed = false;
                    if begin != 0 && end > begin {
                        let mut p = begin;
                        while p < end {
                            if vmm.read_u64(p).unwrap_or(1) == 0 {
                                let _ = vmm.write_u64(p, a0);
                                placed = true;
                                break;
                            }
                            p += 8;
                        }
                    }
                    if !placed {
                        let old_count = if end > begin { (end - begin) / 8 } else { 0 };
                        let new_count = old_count + 32;
                        let table = self.heap_alloc(vmm, self.process_heap, new_count * 8 + 8);
                        if table != 0 {
                            for i in 0..old_count {
                                let v = vmm.read_u64(begin + i * 8).unwrap_or(0);
                                let _ = vmm.write_u64(table + i * 8, v);
                            }
                            let _ = vmm.write_u64(table + old_count * 8, a0);
                            let _ = vmm.write_u64(a1, table);
                            // `end` tracks one past the last registered entry in the
                            // growing-table convention used by the MSVC CRT.
                            let _ = vmm.write_u64(a2, table + (old_count + 1) * 8);
                        }
                    }
                }
                a0
            }
            "_beginthreadex" => {
                // uintptr_t _beginthreadex(void *sec, unsigned stack, unsigned (__stdcall *start)(void*),
                //                          void *arg, unsigned initflag, unsigned *thrdaddr)
                let entry = a2;
                let param = a3;
                let handle = self.alloc_handle();
                let base = 0x0000_0000_0300_0000u64
                    + (self.threads.len() as u64) * 0x0000_0000_0010_0000;
                let top = base + 0x0000_0000_0008_0000;
                self.threads.push(GuestThread {
                    handle,
                    teb_addr: 0,
                    stack_top: top,
                    stack_base: base,
                    entry,
                    param,
                    exit_code: STILL_ACTIVE,
                    finished: false,
                    started: false,
                    signal_handle: 0,
                });
                if a5 != 0 {
                    let _ = vmm.write_u32(a5, 0x3000 + self.threads.len() as u32);
                }
                self.note(format!(
                    "K _beginthreadex entry=0x{entry:x} param=0x{param:x} handle=0x{handle:x} (thread body not scheduled)"
                ));
                handle
            }
            "_XcptFilter" => 0, // EXCEPTION_CONTINUE_SEARCH for the CRT's purposes
            "__C_specific_handler" | "__CxxFrameHandler" | "__CxxFrameHandler3" => 1, // ContinueSearch
            "_CxxThrowException" => {
                // Named hard blocker: guest C++ exception unwind is not implemented. Fail
                // loudly with the MSVC C++ exception code instead of pretending success.
                self.note(format!(
                    "K CXX_THROW object=0x{a0:x} throwinfo=0x{a1:x}: C++ exception unwind not implemented"
                ));
                self.record_unimplemented("_CxxThrowException(unwind)");
                return HleAction::ExitProcess(0xE06D_7363);
            }
            "_purecall" => {
                self.note("K _purecall: pure virtual call in guest".to_string());
                return HleAction::ExitProcess(3);
            }
            "?terminate@@YAXXZ" => {
                self.note("K std::terminate called by guest".to_string());
                return HleAction::ExitProcess(3);
            }
            "??1type_info@@UEAA@XZ" => a0, // type_info dtor: `this` in rcx, nothing to release
            // ------------------------------------------- old-msvcrt memory/string
            "memcpy" => {
                let n = a2 as usize;
                let mut remaining = n;
                let mut off = 0usize;
                while remaining > 0 {
                    let chunk = remaining.min(1 << 20);
                    let mut buf = vec![0u8; chunk];
                    if a1 != 0 && vmm.read_bytes(a1 + off as u64, &mut buf).is_err() {
                        break;
                    }
                    if a0 != 0 && vmm.write_bytes(a0 + off as u64, &buf).is_err() {
                        break;
                    }
                    off += chunk;
                    remaining -= chunk;
                }
                a0
            }
            "memmove" => {
                let n = a2 as usize;
                if n > 0 && a1 != 0 {
                    let mut buf = vec![0u8; n];
                    if vmm.read_bytes(a1, &mut buf).is_ok() && a0 != 0 {
                        let _ = vmm.write_bytes(a0, &buf);
                    }
                }
                a0
            }
            "memset" => {
                let n = a2 as usize;
                if n > 0 && a0 != 0 {
                    let byte = a1 as u8;
                    let mut remaining = n;
                    let mut off = 0usize;
                    while remaining > 0 {
                        let chunk = remaining.min(1 << 20);
                        let buf = vec![byte; chunk];
                        if vmm.write_bytes(a0 + off as u64, &buf).is_err() {
                            break;
                        }
                        off += chunk;
                        remaining -= chunk;
                    }
                }
                a0
            }
            "memcmp" => {
                let n = a2 as usize;
                let mut l = vec![0u8; n];
                let mut r = vec![0u8; n];
                let _ = vmm.read_bytes(a0, &mut l);
                let _ = vmm.read_bytes(a1, &mut r);
                match l.cmp(&r) {
                    std::cmp::Ordering::Less => (-1i64) as u64,
                    std::cmp::Ordering::Equal => 0,
                    std::cmp::Ordering::Greater => 1,
                }
            }
            "wcsstr" => {
                let hay = vmm.read_wide_string(a0, 0x8000).unwrap_or_default();
                let needle = vmm.read_wide_string(a1, 0x8000).unwrap_or_default();
                if needle.is_empty() {
                    return HleAction::Return(a0);
                }
                let found = hay
                    .windows(needle.len())
                    .position(|w| w == needle.as_slice());
                match found {
                    Some(i) => a0 + (i as u64) * 2,
                    None => 0,
                }
            }
            // ------------------------------------------- old-msvcrt stdio over _iob
            "fputs" => {
                let s = self.read_ansi(vmm, a0);
                if a1 == 0 || self.iob_index(a1) != Some(0) {
                    self.stdout.extend_from_slice(s.as_bytes());
                }
                0
            }
            "fputc" => {
                if a1 == 0 || self.iob_index(a1) != Some(0) {
                    self.stdout.push(a0 as u8);
                }
                a0 & 0xFF
            }
            "fgetc" => (-1i64) as u64, // EOF
            "fclose" => 0,
            "GetCommandLineA" => {
                let (a, _) = self.ensure_command_line_buffers(vmm);
                a
            }
            "GetCommandLineW" => {
                let (_, w) = self.ensure_command_line_buffers(vmm);
                w
            }
            // ------------------------------------------------------------ C strings
            //
            // These are the most heavily used imports of a static MinGW/ucrt binary, and a *wrong*
            // return value here is worse than a missing one: the original stub returned 0 for
            // every symbol, so `strcmp` reported "equal" for all comparisons and winetest's
            // `main` took its `--list` branch instead of running the requested subtest.
            "strlen" => {
                let bytes = vmm.read_c_string(a0, 0x10000).unwrap_or_default();
                bytes.len() as u64
            }
            "strcmp" => {
                let l = vmm.read_c_string(a0, 0x10000).unwrap_or_default();
                let r = vmm.read_c_string(a1, 0x10000).unwrap_or_default();
                match l.cmp(&r) {
                    std::cmp::Ordering::Less => (-1i64) as u64,
                    std::cmp::Ordering::Equal => 0,
                    std::cmp::Ordering::Greater => 1,
                }
            }
            "strncmp" => {
                let l = vmm.read_c_string(a0, 0x10000).unwrap_or_default();
                let r = vmm.read_c_string(a1, 0x10000).unwrap_or_default();
                let n = a2 as usize;
                let l = &l[..l.len().min(n)];
                let r = &r[..r.len().min(n)];
                match l.cmp(r) {
                    std::cmp::Ordering::Less => (-1i64) as u64,
                    std::cmp::Ordering::Equal => 0,
                    std::cmp::Ordering::Greater => 1,
                }
            }
            "strcpy" | "strcpy_s" => {
                let src = vmm.read_c_string(a1, 0x10000).unwrap_or_default();
                let mut out = src;
                out.push(0);
                let _ = vmm.write_bytes(a0, &out);
                a0
            }
            "strncpy" => {
                let src = vmm.read_c_string(a1, 0x10000).unwrap_or_default();
                let n = a2 as usize;
                let mut out = vec![0u8; n];
                for (i, b) in src.iter().take(n).enumerate() {
                    out[i] = *b;
                }
                let _ = vmm.write_bytes(a0, &out);
                a0
            }
            "strcat" => {
                let dst = vmm.read_c_string(a0, 0x10000).unwrap_or_default();
                let src = vmm.read_c_string(a1, 0x10000).unwrap_or_default();
                let mut out = dst;
                out.extend_from_slice(&src);
                out.push(0);
                let _ = vmm.write_bytes(a0, &out);
                a0
            }
            "strchr" => {
                let c = a1 as u8;
                let bytes = vmm.read_c_string(a0, 0x10000).unwrap_or_default();
                match bytes.iter().position(|b| *b == c) {
                    Some(i) => a0 + i as u64,
                    None => {
                        if c == 0 {
                            a0 + bytes.len() as u64
                        } else {
                            0
                        }
                    }
                }
            }
            "strrchr" => {
                let c = a1 as u8;
                let bytes = vmm.read_c_string(a0, 0x10000).unwrap_or_default();
                match bytes.iter().rposition(|b| *b == c) {
                    Some(i) => a0 + i as u64,
                    None => 0,
                }
            }
            "_stricmp" | "strcasecmp" => {
                let l = vmm.read_c_string(a0, 0x10000).unwrap_or_default();
                let r = vmm.read_c_string(a1, 0x10000).unwrap_or_default();
                let l = String::from_utf8_lossy(&l).to_ascii_lowercase();
                let r = String::from_utf8_lossy(&r).to_ascii_lowercase();
                match l.cmp(&r) {
                    std::cmp::Ordering::Less => (-1i64) as u64,
                    std::cmp::Ordering::Equal => 0,
                    std::cmp::Ordering::Greater => 1,
                }
            }
            "_strdup" => {
                let src = vmm.read_c_string(a0, 0x10000).unwrap_or_default();
                let len = src.len() as u64 + 1;
                let va = self.crt_alloc(vmm, "malloc", len, 0);
                if va != 0 {
                    let _ = vmm.write_bytes(va, &src);
                    let _ = vmm.write_u8(va + len - 1, 0);
                }
                va
            }
            "wcscmp" => {
                let l = vmm.read_wide_string(a0, 0x8000).unwrap_or_default();
                let r = vmm.read_wide_string(a1, 0x8000).unwrap_or_default();
                match l.cmp(&r) {
                    std::cmp::Ordering::Less => (-1i64) as u64,
                    std::cmp::Ordering::Equal => 0,
                    std::cmp::Ordering::Greater => 1,
                }
            }
            "wcscpy" => {
                let src = vmm.read_wide_string(a1, 0x8000).unwrap_or_default();
                let mut out = Vec::with_capacity(src.len() * 2 + 2);
                for unit in &src {
                    out.extend_from_slice(&unit.to_le_bytes());
                }
                out.extend_from_slice(&0u16.to_le_bytes());
                let _ = vmm.write_bytes(a0, &out);
                a0
            }
            "__daylight" | "__timezone" => {
                if self.timezone_daylight == 0 {
                    let va = self.crt_alloc(vmm, "malloc", 4, 0);
                    let _ = vmm.write_u32(va, 0);
                    self.timezone_daylight = if va == 0 { 1 } else { va };
                }
                self.timezone_daylight
            }
            "__tzname" => {
                if self.tzname_ptr == 0 {
                    let va = self.crt_alloc(vmm, "malloc", 16, 0);
                    let _ = vmm.write_bytes(va, &[0u8; 16]);
                    self.tzname_ptr = if va == 0 { 1 } else { va };
                }
                self.tzname_ptr
            }
            "free" | "cfree" => {
                self.heap_free(a0);
                0
            }
            "__setusermatherr" | "frexp" | "atoi" | "malloc" | "calloc" | "realloc" => {
                self.crt_alloc(vmm, symbol, a0, a1)
            }

            // ------------------------------------------------------ user32/gdi32
            "wsprintfA" => self.wsprintf(vmm, a0, a1, args, guest_rsp, false),
            "wsprintfW" => self.wsprintf(vmm, a0, a1, args, guest_rsp, true),
            "wvsprintfA" => self.vfprintf_to(vmm, a0, a1, a2, false),
            "wvsprintfW" => self.vfprintf_to(vmm, a0, a1, a2, true),
            "CharUpperA" => self.char_case(vmm, a0, true, true),
            "CharLowerA" => self.char_case(vmm, a0, true, false),
            "CharUpperW" => self.char_case(vmm, a0, false, true),
            "CharLowerW" => self.char_case(vmm, a0, false, false),
            "CharPrevA" => self.char_prev(vmm, a0, a1, 0),
            "CharPrevExA" => self.char_prev(vmm, a1, a2, a0),
            "CharNextA" => a1.wrapping_add(1),
            "SetRect" => {
                if a0 == 0 {
                    return HleAction::Return(0);
                }
                let _ = vmm.write_bytes(
                    a0,
                    &[
                        (a1 as u32).to_le_bytes(),
                        (a2 as u32).to_le_bytes(),
                        (a3 as u32).to_le_bytes(),
                        (a4 as u32).to_le_bytes(),
                    ]
                    .concat(),
                );
                1
            }
            "SetRectEmpty" => {
                if a0 == 0 {
                    return HleAction::Return(0);
                }
                let _ = vmm.write_bytes(a0, &[0u8; 16]);
                1
            }
            "CopyRect" => {
                if a0 == 0 || a1 == 0 {
                    return HleAction::Return(0);
                }
                let mut buf = [0u8; 16];
                let _ = vmm.read_bytes(a1, &mut buf);
                let _ = vmm.write_bytes(a0, &buf);
                1
            }
            "IsRectEmpty" => {
                if a0 == 0 {
                    return HleAction::Return(1);
                }
                let l = vmm.read_u32(a0).unwrap_or(0) as i32;
                let t = vmm.read_u32(a0 + 4).unwrap_or(0) as i32;
                let r = vmm.read_u32(a0 + 8).unwrap_or(0) as i32;
                let b = vmm.read_u32(a0 + 12).unwrap_or(0) as i32;
                ((r - l) <= 0 || (b - t) <= 0) as u64
            }
            "EqualRect" => {
                if a0 == 0 || a1 == 0 {
                    return HleAction::Return(0);
                }
                let mut x = [0u8; 16];
                let mut y = [0u8; 16];
                let _ = vmm.read_bytes(a0, &mut x);
                let _ = vmm.read_bytes(a1, &mut y);
                (x == y) as u64
            }
            "SubtractRect" => self.subtract_rect(vmm, a0, a1, a2),
            "InflateRect" => {
                if a0 == 0 {
                    return HleAction::Return(0);
                }
                let l = vmm.read_u32(a0).unwrap_or(0) as i32 - a1 as u32 as i32;
                let t = vmm.read_u32(a0 + 4).unwrap_or(0) as i32 - a2 as u32 as i32;
                let r = vmm.read_u32(a0 + 8).unwrap_or(0) as i32 + a1 as u32 as i32;
                let b = vmm.read_u32(a0 + 12).unwrap_or(0) as i32 + a2 as u32 as i32;
                let _ = vmm.write_u32(a0, l as u32);
                let _ = vmm.write_u32(a0 + 4, t as u32);
                let _ = vmm.write_u32(a0 + 8, r as u32);
                let _ = vmm.write_u32(a0 + 12, b as u32);
                1
            }
            "OffsetRect" => {
                if a0 == 0 {
                    return HleAction::Return(0);
                }
                let dx = a1 as u32 as i32;
                let dy = a2 as u32 as i32;
                for off in [0u64, 4, 8, 12] {
                    let v = vmm.read_u32(a0 + off).unwrap_or(0) as i32
                        + if off < 8 { dx } else { dx };
                    let v2 = if off < 8 { v } else { v };
                    let val = if off == 0 || off == 8 {
                        v2
                    } else {
                        vmm.read_u32(a0 + off).unwrap_or(0) as i32 + dy
                    };
                    let _ = vmm.write_u32(a0 + off, val as u32);
                }
                1
            }
            "GetClientRect" => {
                if a1 == 0 {
                    return HleAction::Return(0);
                }
                let (w, h) = self.window_client_size(a0).unwrap_or((256, 256));
                let _ = vmm.write_u32(a1, 0);
                let _ = vmm.write_u32(a1 + 4, 0);
                let _ = vmm.write_u32(a1 + 8, w);
                let _ = vmm.write_u32(a1 + 12, h);
                1
            }
            "MoveWindow" => 1,
            "CreateWindowExA" | "CreateWindowExW" => self.create_window(vmm),
            "DestroyWindow" => 1,
            "GetDesktopWindow" => crate::d3d12_hle::DESKTOP_HWND,
            "GetDC" => {
                let h = self.alloc_handle();
                h
            }
            "ReleaseDC" => 1,
            "CreateCompatibleDC" => self.alloc_handle(),
            "DeleteDC" => 1,
            "CreateBitmap" => {
                let bmp = self.alloc_handle();
                let handle_id = (bmp & 0xFFFF) as u32;
                self.bitmaps.insert(bmp, Bitmap {
                    width: a0 as u32,
                    height: a1 as u32,
                    planes: a2 as u32,
                    bpp: a3 as u32,
                    bits_ptr: a4,
                    selected_in: 0,
                    cleared: false,
                    pixels: None,
                    base_color: 0x00FF_FFFF,
                    fill_rect: None,
                });
                let _ = handle_id;
                bmp
            }
            "SelectObject" => {
                if self.bitmaps.contains_key(&a1) {
                    self.selected_bitmap.insert(a0, a1);
                } else {
                    self.note_dc_brush(a0, a1);
                }
                1
            }
            "GetStockObject" => match a0 as u32 {
                0 => 0x8000_0000_0000_0004,  // WHITE_BRUSH
                4 => 0x8000_0000_0000_0000,  // BLACK_BRUSH
                _ => 0x8000_0000_0000_0000,
            },
            "DeleteObject" => 1,
            "FillRect" => self.fill_rect(vmm, a0, a1, a2),
            "GetPixel" => self.get_pixel(vmm, a0, a1 as i32, a2 as i32),
            "SetPixel" => 0,
            "_C_specific_handler" => 0,
            "IsBadStringPtrA" | "IsBadStringPtrW" | "IsBadReadPtr" | "IsBadWritePtr" => 0,
            "lstrlenA" => self.read_ansi(vmm, a0).len() as u64,
            "lstrlenW" => self.read_wide(vmm, a0).chars().count() as u64,
            "lstrcpyA" | "lstrcpyW" | "lstrcatA" | "lstrcatW" => {
                let wide = symbol.ends_with('W');
                let dst = if symbol.starts_with("lstrcpy") {
                    a0
                } else {
                    a0
                };
                let src_str = if wide {
                    self.read_wide(vmm, a1)
                } else {
                    self.read_ansi(vmm, a1)
                };
                let base = if symbol.starts_with("lstrcat") {
                    if wide {
                        self.read_wide(vmm, a0)
                    } else {
                        self.read_ansi(vmm, a0)
                    }
                } else {
                    String::new()
                };
                let combined = format!("{}{}", base, src_str);
                let ok = if wide {
                    self.write_wide(vmm, dst, &combined).is_ok()
                } else {
                    self.write_ansi(vmm, dst, &combined).is_ok()
                };
                if ok {
                    dst
                } else {
                    0
                }
            }
            "lstrcmpA" => self.lstrcmp(vmm, a0, a1, false),
            "lstrcmpW" => self.lstrcmp(vmm, a0, a1, true),
            "lstrcmpiA" => self.lstrcmp(vmm, a0, a1, false),
            "lstrcmpiW" => self.lstrcmp(vmm, a0, a1, true),

            // ----------------------------------------------- d3d12 / dxgi objects
            _ => {
                let _ = (a4, a5, a6, a7, a8, ordinal);
                self.record_unimplemented(symbol);
                self.set_last_error(ERROR_CALL_NOT_IMPLEMENTED);
                0
            }
        };

        HleAction::Return(result)
    }

    // ------------------------------------------------------------- helpers

    fn image_base(&self) -> u64 {
        self.modules.get("kernel32.dll").copied().unwrap_or(0)
    }

    fn module_handle(&mut self, name: &str) -> u64 {
        if name.is_empty() {
            return self.image_base();
        }
        let lower = name.to_ascii_lowercase();
        let key = if lower.ends_with(".dll") {
            lower
        } else {
            format!("{}.dll", lower)
        };
        if let Some(&va) = self.modules.get(&key) {
            return va;
        }
        if key.starts_with("api-ms-win-crt") || key == "ucrtbase.dll" || key == "msvcrt.dll" {
            return 0x7FFE_1000_8000;
        }
        self.set_last_error(ERROR_MOD_NOT_FOUND);
        0
    }

    fn resolve_proc_address(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        hmod: u64,
        name: &str,
        ordinal: u16,
    ) -> u64 {
        let dll = self
            .modules
            .iter()
            .find(|(_, &va)| va == hmod)
            .map(|(k, _)| k.clone())
            .unwrap_or_default();
        // Every distinct (dll, symbol) pair maps to a stable, *callable* thunk.
        //
        // Three invariants matter here:
        //  * sequential allocation instead of `hash % 4096`, because a hash collision silently
        //    returned the stub of an unrelated export;
        //  * a pool disjoint from the import stubs, so a resolved pointer can never land on an
        //    `__imp_` entry;
        //  * the thunk is registered in `import_thunks`, otherwise `run_slice` sees an address in
        //    the HLE region that resolves to no (dll, symbol) and reports `unmapped thunk` - which
        //    is exactly how the `environ`/`drive`/`directory` winetests died.
        let key = if !name.is_empty() {
            name.to_string()
        } else {
            format!("#{}", ordinal)
        };
        let pair = (dll.clone(), key.clone());
        if let Some(&existing) = self.export_thunks.get(&pair) {
            return existing;
        }
        let mut thunk = if self.export_thunk_next == 0 {
            EXPORT_THUNK_BASE
        } else {
            self.export_thunk_next
        };
        if thunk + THUNK_STRIDE > EXPORT_THUNK_END {
            thunk = EXPORT_THUNK_BASE;
        }
        self.export_thunk_next = thunk + THUNK_STRIDE;
        let _ = vmm.write_u8(thunk, 0xC3);
        self.export_thunks.insert(pair, thunk);
        self.import_thunks
            .insert(thunk, (dll, key, ordinal));
        thunk
    }

    fn write_curdir(&mut self, vmm: &mut VirtualMemoryManager) {
        let dir = self.cwd.clone();
        let units: Vec<u16> = dir.encode_utf16().collect();
        let mut buf = Vec::with_capacity((units.len() + 1) * 2);
        for u in &units {
            buf.extend_from_slice(&u.to_le_bytes());
        }
        buf.extend_from_slice(&[0, 0]);
        let _ = vmm.host_write_bytes(crate::pe64::CURDIR_BUF_ADDR, &buf);
        // Real RTL_USER_PROCESS_PARAMETERS CURDIR offsets (see pe64.rs).
        let _ = vmm.write_u16(PROC_PARAMS_ADDR + 0x38, (units.len() * 2) as u16);
        let _ = vmm.write_u16(PROC_PARAMS_ADDR + 0x3A, 520);
        let _ = vmm.write_u64(PROC_PARAMS_ADDR + 0x40, crate::pe64::CURDIR_BUF_ADDR);
        let _ = vmm.write_u64(PROC_PARAMS_ADDR + 0x48, self.cwd_handle);
        let _ = (PEB_ADDR, MAIN_TEB_ADDR, MAIN_STACK_BOTTOM, MAIN_STACK_TOP, THREAD_EXIT_THUNK_ADDR);
    }

    fn get_dir_api(&mut self, vmm: &mut VirtualMemoryManager, buf: u64, size: u64, kind: u32) -> u64 {
        let path = match kind {
            0 | 1 => "C:\\Windows",
            _ => "C:\\Windows\\System32",
        };
        let need_with_nul = path.len() + 1;
        if buf == 0 || size == 0 {
            return need_with_nul as u64;
        }
        if (size as usize) <= path.len() {
            // Buffer too small: leave it untouched and report the required size (with NUL).
            return need_with_nul as u64;
        }
        let ok = if kind % 2 == 0 {
            self.write_ansi(vmm, buf, path).is_ok()
        } else {
            self.write_wide(vmm, buf, path).is_ok()
        };
        if !ok {
            return 0;
        }
        path.len() as u64
    }

    fn handle_path(&self, handle: u64) -> Option<String> {
        self.handle_map.get(&handle).cloned()
    }

    fn close_handle(&mut self, handle: u64) -> u64 {
        self.find_searches.remove(&handle);
        self.semaphores.remove(&handle);
        self.file_mappings.remove(&handle);
        if let Some(key) = self.handle_map.remove(&handle) {
            if let Some(f) = self.files.get_mut(&key) {
                f.handle_count = f.handle_count.saturating_sub(1);
            }
            self.waitables.remove(&handle);
            self.bitmaps.remove(&handle);
            1
        } else if self.waitables.remove(&handle).is_some() {
            1
        } else {
            1
        }
    }

    fn crt_alloc(&mut self, vmm: &mut VirtualMemoryManager, symbol: &str, a0: u64, a1: u64) -> u64 {
        match symbol {
            "malloc" => self.heap_alloc(vmm, self.process_heap, a0),
            "realloc" => self.heap_realloc(vmm, self.process_heap, a0, a1),
            "atoi" => {
                let s = self.read_ansi(vmm, a0);
                let t = s.trim_start();
                let mut value: i64 = 0;
                let mut sign: i64 = 1;
                let mut chars = t.chars().peekable();
                if let Some(&c) = chars.peek() {
                    if c == '-' {
                        sign = -1;
                        chars.next();
                    } else if c == '+' {
                        chars.next();
                    }
                }
                for c in chars {
                    if !c.is_ascii_digit() {
                        break;
                    }
                    value = value.wrapping_mul(10) + (c as i64 - '0' as i64);
                }
                (sign * value) as u64
            }
            "calloc" => {
                let total = a0.saturating_mul(a1);
                let va = self.heap_alloc(vmm, self.process_heap, total);
                if va != 0 && total > 0 && total < (1 << 24) {
                    let _ = vmm.host_write_bytes(va, &vec![0u8; total as usize]);
                }
                va
            }
            "frexp" => {
                // frexp(value, &exp): value arrives in XMM0, not in these GPR slots.
                0
            }
            _ => 0,
        }
    }

    fn format_ansi(&mut self, vmm: &mut VirtualMemoryManager, fmt_ptr: u64, va_list_ptr: u64) -> Vec<u8> {
        if fmt_ptr == 0 {
            return Vec::new();
        }
        let raw = vmm.read_c_string(fmt_ptr, 0x8000).unwrap_or_default();
        let fmt_units = mb_to_wide(ANSI_CODEPAGE, &raw);
        let mut va = VaSlotReader::from_va_list_ptr(vmm, va_list_ptr, 64);
        let out = format_win64_printf(vmm, &fmt_units, &mut va, false, false);
        let (bytes, _) = wide_to_mb(ANSI_CODEPAGE, &out);
        bytes
    }

    fn format_wide(&mut self, vmm: &mut VirtualMemoryManager, fmt_ptr: u64, va_list_ptr: u64) -> Vec<u16> {
        if fmt_ptr == 0 {
            return Vec::new();
        }
        let fmt_units = vmm.read_wide_string(fmt_ptr, 0x8000).unwrap_or_default();
        let mut va = VaSlotReader::from_va_list_ptr(vmm, va_list_ptr, 64);
        format_win64_printf(vmm, &fmt_units, &mut va, true, false)
    }

    fn vfprintf(&mut self, vmm: &mut VirtualMemoryManager, fmt_ptr: u64, va_list_ptr: u64) -> u64 {
        let bytes = self.format_ansi(vmm, fmt_ptr, va_list_ptr);
        self.stdout.extend_from_slice(&bytes);
        bytes.len() as u64
    }

    fn vfwprintf(&mut self, vmm: &mut VirtualMemoryManager, fmt_ptr: u64, va_list_ptr: u64) -> u64 {
        let units = self.format_wide(vmm, fmt_ptr, va_list_ptr);
        let (bytes, _) = wide_to_mb(ANSI_CODEPAGE, &units);
        self.stdout.extend_from_slice(&bytes);
        units.len() as u64
    }

    fn vfprintf_to(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        buffer: u64,
        fmt_ptr: u64,
        va_list_ptr: u64,
        wide: bool,
    ) -> u64 {
        if wide {
            let units = self.format_wide(vmm, fmt_ptr, va_list_ptr);
            let mut buf = Vec::with_capacity((units.len() + 1) * 2);
            for u in &units {
                buf.extend_from_slice(&u.to_le_bytes());
            }
            buf.extend_from_slice(&[0, 0]);
            let _ = vmm.write_bytes(buffer, &buf);
            units.len() as u64
        } else {
            let bytes = self.format_ansi(vmm, fmt_ptr, va_list_ptr);
            let mut buf = bytes.clone();
            buf.push(0);
            let _ = vmm.write_bytes(buffer, &buf);
            bytes.len() as u64
        }
    }

    /// `wsprintfA/W` are DWORD-returning variadic functions; on x64 all varargs live in
    /// 8-byte stack slots starting at `[rsp + 0x28]` (return address + 32-byte shadow space).
    fn wsprintf(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        buffer: u64,
        fmt_ptr: u64,
        args: &[u64; 10],
        guest_rsp: u64,
        wide: bool,
    ) -> u64 {
        // x64 variadic convention: `buffer` arrives in RCX and `fmt_ptr` in RDX, so the *first two*
        // varargs live in R8/R9 and only the third onwards are stack slots at [rsp+0x28].
        // Reading just the stack dropped both register varargs, which made every single-argument
        // wsprintfA format a zero ("%010d", -12345 -> "0000000000") and return 1.
        let mut slots: Vec<u64> = Vec::with_capacity(32);
        slots.push(args[2]);
        slots.push(args[3]);
        slots.extend_from_slice(&args[4..10]);
        let stack_base = guest_rsp + 0x28;
        for i in 0..26u64 {
            slots.push(vmm.read_u64(stack_base + (6 + i) * 8).unwrap_or(0));
        }
        let mut va = VaSlotReader::from_varargs_slice(&slots);
        if wide {
            let fmt_units = vmm.read_wide_string(fmt_ptr, 0x4000).unwrap_or_default();
            let out = format_win64_printf(vmm, &fmt_units, &mut va, true, true);
            let mut buf = Vec::with_capacity((out.len() + 1) * 2);
            for u in &out {
                buf.extend_from_slice(&u.to_le_bytes());
            }
            buf.extend_from_slice(&[0, 0]);
            let _ = vmm.write_bytes(buffer, &buf);
            out.len() as u64
        } else {
            let raw = vmm.read_c_string(fmt_ptr, 0x4000).unwrap_or_default();
            let fmt_units = mb_to_wide(ANSI_CODEPAGE, &raw);
            let out = format_win64_printf(vmm, &fmt_units, &mut va, false, true);
            let (bytes, _) = wide_to_mb(ANSI_CODEPAGE, &out);
            let mut buf = bytes.clone();
            buf.push(0);
            let _ = vmm.write_bytes(buffer, &buf);
            bytes.len() as u64
        }
    }

    fn char_case(&mut self, vmm: &mut VirtualMemoryManager, arg: u64, ansi: bool, upper: bool) -> u64 {
        if arg < 0x1_0000 {
            // 16-bit character request: keep the result within 16 bits.
            let b = arg as u8;
            let mapped = if ansi {
                if upper {
                    b.to_ascii_uppercase()
                } else {
                    b.to_ascii_lowercase()
                }
            } else {
                b
            };
            return mapped as u64;
        }
        let s = if ansi {
            self.read_ansi(vmm, arg)
        } else {
            self.read_wide(vmm, arg)
        };
        let converted: String = if upper {
            s.to_uppercase()
        } else {
            s.to_lowercase()
        };
        let ok = if ansi {
            self.write_ansi(vmm, arg, &converted).is_ok()
        } else {
            self.write_wide(vmm, arg, &converted).is_ok()
        };
        if ok {
            arg
        } else {
            0
        }
    }

    fn char_prev(&mut self, vmm: &mut VirtualMemoryManager, start: u64, current: u64, codepage: u64) -> u64 {
        if current == 0 {
            return 0;
        }
        // CharPrevA/CharPrevExA saturate at the start of the buffer: when `current` is the first
        // byte the answer is `current` itself, not the byte before the string
        // (wsprintf.c:318/323 caught the off-by-one at CHAR_MAX offset -1).
        if start == 0 {
            return current.wrapping_sub(1);
        }
        if current <= start {
            return current;
        }
        if codepage != 0 {
            // DBCS aware: GBK (936), Big5 (950), Shift-JIS (932/949) lead byte ranges.
            let lead_ranges: &[(u8, u8)] = match codepage {
                932 => &[(0x81, 0x9F), (0xE0, 0xFC)],
                936 => &[(0x81, 0xFE)],
                949 => &[(0x81, 0xFE)],
                950 => &[(0x81, 0xFE)],
                _ => &[],
            };
            let mut p = start;
            while p < current {
                let b = vmm.read_u8(p).unwrap_or(0);
                let is_lead = lead_ranges.iter().any(|&(lo, hi)| b >= lo && b <= hi);
                let step = if is_lead { 2 } else { 1 };
                if p + step >= current {
                    return p;
                }
                p += step;
            }
            return if current > start { current - 1 } else { start };
        }
        current - 1
    }

    fn lstrcmp(&mut self, vmm: &mut VirtualMemoryManager, a: u64, b: u64, wide: bool) -> u64 {
        let sa = if wide { self.read_wide(vmm, a) } else { self.read_ansi(vmm, a) };
        let sb = if wide { self.read_wide(vmm, b) } else { self.read_ansi(vmm, b) };
        let ord = sa.cmp(&sb);
        let v: i64 = match ord {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        };
        v as u64
    }

    fn subtract_rect(&mut self, vmm: &mut VirtualMemoryManager, dst: u64, s1: u64, s2: u64) -> u64 {
        if dst == 0 || s1 == 0 || s2 == 0 {
            return 0;
        }
        let read = |out: &mut VirtualMemoryManager, p: u64| -> (i32, i32, i32, i32) {
            (
                out.read_u32(p).unwrap_or(0) as i32,
                out.read_u32(p + 4).unwrap_or(0) as i32,
                out.read_u32(p + 8).unwrap_or(0) as i32,
                out.read_u32(p + 12).unwrap_or(0) as i32,
            )
        };
        let (l1, t1, rr1, b1) = read(vmm, s1);
        let (l2, t2, rr2, b2) = read(vmm, s2);
        let write = |out: &mut VirtualMemoryManager, rect: (i32, i32, i32, i32)| {
            let _ = out.write_u32(dst, rect.0 as u32);
            let _ = out.write_u32(dst + 4, rect.1 as u32);
            let _ = out.write_u32(dst + 8, rect.2 as u32);
            let _ = out.write_u32(dst + 12, rect.3 as u32);
        };
        // No intersection -> source unchanged.
        if rr2 <= l1 || l2 >= rr1 || b2 <= t1 || t2 >= b1 {
            write(vmm, (l1, t1, rr1, b1));
            return 1;
        }
        // Fully contained -> empty result, FALSE.
        if l2 <= l1 && t2 <= t1 && rr2 >= rr1 && b2 >= b1 {
            return 0;
        }
        // Partial overlap -> trim horizontally first (Wine behaviour).
        if l2 > l1 && l2 < rr1 {
            write(vmm, (l1, t1, l2, b1));
            return 1;
        }
        if rr2 < rr1 && rr2 > l1 {
            write(vmm, (rr2, t1, rr1, b1));
            return 1;
        }
        if t2 > t1 && t2 < b1 {
            write(vmm, (l1, t1, rr1, t2));
            return 1;
        }
        if b2 < b1 && b2 > t1 {
            write(vmm, (l1, b2, rr1, b1));
            return 1;
        }
        write(vmm, (l1, t1, rr1, b1));
        1
    }

    fn create_window(&mut self, _vmm: &mut VirtualMemoryManager) -> u64 {
        let hwnd = 0x0000_0000_0002_0000u64 + self.windows.len() as u64 * 0x10;
        self.windows.push((hwnd, 256, 256));
        hwnd
    }

    fn window_client_size(&self, hwnd: u64) -> Option<(u32, u32)> {
        self.windows
            .iter()
            .find(|(h, _, _)| *h == hwnd)
            .map(|(_, w, h)| (*w, *h))
    }

    fn stock_brush(&self) -> u64 {
        0x0000_0000_0000_0001
    }

    fn fill_rect(&mut self, vmm: &mut VirtualMemoryManager, hdc: u64, rect: u64, brush: u64) -> u64 {
        let (l, t, r, b) = if rect != 0 {
            (
                vmm.read_u32(rect).unwrap_or(0) as i32,
                vmm.read_u32(rect + 4).unwrap_or(0) as i32,
                vmm.read_u32(rect + 8).unwrap_or(0) as i32,
                vmm.read_u32(rect + 12).unwrap_or(0) as i32,
            )
        } else {
            return 1;
        };
        // Determine the colour: brush 0 means "use the DC's current brush". After
        // SelectObject(hdcmem, GetStockObject(BLACK_BRUSH)) the DC brush is black.
        let black = brush == 0 || brush == 0x8000_0000_0000_0000;
        let color = if black { 0u32 } else { 0x00FF_FFFF };
        let dc_brush = self.dc_brush.get(&hdc).copied().unwrap_or(0x00FF_FFFF);
        let final_color = if brush == 0 { dc_brush } else { color };
        if let Some(bmp_key) = self.selected_bitmap.get(&hdc).copied() {
            if let Some(bmp) = self.bitmaps.get_mut(&bmp_key) {
                if !bmp.cleared {
                    // The bitmap was created from caller memory (white fill); start from it.
                    bmp.cleared = true;
                    bmp.pixels = None;
                    bmp.base_color = 0x00FF_FFFF;
                }
                bmp.fill_rect = Some((l, t, r, b, final_color));
            }
        }
        1
    }

    fn get_pixel(&mut self, _vmm: &mut VirtualMemoryManager, hdc: u64, x: i32, y: i32) -> u64 {
        if let Some(bmp_key) = self.selected_bitmap.get(&hdc).copied() {
            if let Some(bmp) = self.bitmaps.get(&bmp_key) {
                if let Some((l, t, r, b, color)) = bmp.fill_rect {
                    if x >= l && x < r && y >= t && y < b {
                        return color as u64;
                    }
                }
                return 0x00FF_FFFF;
            }
        }
        0xFFFF_FFFF
    }
}

fn d3d12_hle_hash(dll: &str, symbol: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in dll.bytes().chain(std::iter::once(b'!')).chain(symbol.bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

#[derive(Debug, Clone)]
struct Bitmap {
    width: u32,
    height: u32,
    planes: u32,
    bpp: u32,
    bits_ptr: u64,
    selected_in: u64,
    cleared: bool,
    pixels: Option<Vec<u8>>,
    base_color: u32,
    fill_rect: Option<(i32, i32, i32, i32, u32)>,
}

// Fields kept outside `dispatch` for clarity; grouped in a second impl block.
impl Win32Kernel {
    /// Initializes the file/handle/window side tables after construction.

    /// Sets the command line the guest CRT sees. `argc`/`argv` are derived from it exactly like
    /// the Windows loader does, so a winetest binary can be started as `<image> <test_name>`.
    pub fn set_command_line(&mut self, line: &str) {
        self.command_line = line.to_string();
        self.crt_argc_ptr = 0;
        self.crt_argv_var = 0;
        self.crt_wargv_var = 0;
        self.command_line_a = 0;
        self.command_line_w = 0;
    }

    fn argv_tokens(&self) -> Vec<String> {
        let mut toks: Vec<String> = self
            .command_line
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        if toks.is_empty() {
            toks.push("test.exe".to_string());
        }
        toks
    }

    fn build_argv_vector(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        tokens: &[String],
        wide: bool,
    ) -> u64 {
        let argc = tokens.len() as u64;
        let var = self.heap_alloc(vmm, self.process_heap, 8);
        let arr = self.heap_alloc(vmm, self.process_heap, (argc + 1) * 8);
        for (i, tok) in tokens.iter().enumerate() {
            let bytes = if wide {
                (tok.chars().count() as u64 + 1) * 2 + 2
            } else {
                tok.len() as u64 + 2
            };
            let slot = self.heap_alloc(vmm, self.process_heap, bytes);
            if slot != 0 {
                if wide {
                    let _ = self.write_wide(vmm, slot, tok);
                } else {
                    let _ = self.write_ansi(vmm, slot, tok);
                }
            }
            if arr != 0 {
                let _ = vmm.write_u64(arr + i as u64 * 8, slot);
            }
        }
        if arr != 0 {
            let _ = vmm.write_u64(arr + argc * 8, 0);
        }
        if var != 0 {
            let _ = vmm.write_u64(var, arr);
        }
        var
    }

    fn build_empty_env_vector(&mut self, vmm: &mut VirtualMemoryManager) -> u64 {
        let var = self.heap_alloc(vmm, self.process_heap, 8);
        let arr = self.heap_alloc(vmm, self.process_heap, 8);
        if arr != 0 {
            let _ = vmm.write_u64(arr, 0);
        }
        if var != 0 {
            let _ = vmm.write_u64(var, arr);
        }
        var
    }

    /// Materialises `_environ` as `var -> arr -> ["K=V", ..., NULL]` from the live env table.
    fn build_env_vector(&mut self, vmm: &mut VirtualMemoryManager, wide: bool) -> u64 {
        let mut entries = self.env.clone();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let items: Vec<String> = entries
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        self.build_argv_vector(vmm, &items, wide)
    }

    /// Lazily materialises `__argc`, `__argv`, `__wargv` and the environment variables.
    fn ensure_crt_argv(&mut self, vmm: &mut VirtualMemoryManager) -> (u64, u64, u64) {
        if self.crt_argc_ptr != 0 {
            return (self.crt_argc_ptr, self.crt_argv_var, self.crt_wargv_var);
        }
        let tokens = self.argv_tokens();
        let argc_ptr = self.heap_alloc(vmm, self.process_heap, 8);
        if argc_ptr != 0 {
            let _ = vmm.write_u32(argc_ptr, tokens.len() as u32);
        }
        let argv_var = self.build_argv_vector(vmm, &tokens, false);
        let wargv_var = self.build_argv_vector(vmm, &tokens, true);
        self.crt_environ_var = self.build_env_vector(vmm, false);
        self.crt_wenviron_var = self.build_env_vector(vmm, true);
        self.crt_argc_ptr = argc_ptr;
        self.crt_argv_var = argv_var;
        self.crt_wargv_var = wargv_var;
        (argc_ptr, argv_var, wargv_var)
    }

    fn ensure_command_line_buffers(&mut self, vmm: &mut VirtualMemoryManager) -> (u64, u64) {
        if self.command_line_a != 0 {
            return (self.command_line_a, self.command_line_w);
        }
        let line = self.command_line.clone();
        let a = self.heap_alloc(vmm, self.process_heap, line.len() as u64 + 2);
        if a != 0 {
            let _ = self.write_ansi(vmm, a, &line);
        }
        let w = self.heap_alloc(
            vmm,
            self.process_heap,
            (line.chars().count() as u64 + 1) * 2 + 2,
        );
        if w != 0 {
            let _ = self.write_wide(vmm, w, &line);
        }
        self.command_line_a = a;
        self.command_line_w = w;
        (a, w)
    }
    pub fn init_runtime_tables(&mut self) {
        self.init_modules();
        self.bitmaps.clear();
        self.dc_brush.clear();
        self.selected_bitmap.clear();
        self.windows.clear();
        self.handle_map.clear();
        self.export_thunks.clear();
        self.export_thunk_next = 0;
    }

    pub fn handle_map_snapshot(&self) -> Vec<(u64, String)> {
        self.handle_map.iter().map(|(k, v)| (*k, v.clone())).collect()
    }

    pub fn register_handle(&mut self, handle: u64, path: String) {
        self.handle_map.insert(handle, path);
    }

    pub fn note_selected_bitmap(&mut self, hdc: u64, bitmap: u64) {
        self.selected_bitmap.insert(hdc, bitmap);
    }

    pub fn note_dc_brush(&mut self, hdc: u64, brush: u64) {
        let color = if brush >= 0x8000_0000_0000_0000 {
            0
        } else {
            0x00FF_FFFF
        };
        self.dc_brush.insert(hdc, color);
    }

    pub fn remember_import_thunk(&mut self, thunk: u64, dll: &str, symbol: &str, ordinal: u16) {
        self.import_thunks
            .insert(thunk, (dll.to_string(), symbol.to_string(), ordinal));
    }

    pub fn lookup_import_thunk(&self, thunk: u64) -> Option<(String, String, u16)> {
        self.import_thunks.get(&thunk).cloned()
    }

    pub fn window_sizes(&self) -> Vec<(u64, u32, u32)> {
        self.windows.clone()
    }

    pub fn drain_stdout(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.stdout)
    }

    pub fn pending_upcall(&self) -> Option<UpcallState> {
        self.upcall_stack.last().cloned()
    }

    /// Called when the guest returned into the upcall sentinel. Either call the next guest
    /// constructor or resume the interrupted HLE stub; `None` only when no upcall is in flight
    /// (i.e. the process entry point itself returned).
    pub fn finish_upcall(&mut self, vmm: &mut VirtualMemoryManager) -> Option<UpcallStep> {
        match self.upcall_stack.last().cloned() {
            Some(UpcallState::Initterm {
                next_slot,
                end,
                resume_rip,
                ..
            }) => {
                let found = self.find_next_initterm_fn(vmm, next_slot, end);
                self.note(format!(
                    "K _initterm resume from=0x{next_slot:x} end=0x{end:x} found={found:?}"
                ));
                if let Some((slot, next)) = found {
                    if let Some(UpcallState::Initterm { next_slot: ns, .. }) =
                        self.upcall_stack.last_mut()
                    {
                        *ns = slot + 8;
                    }
                    return Some(UpcallStep::Call(next));
                }

                // Keep the frame: the re-entered `_initterm` handler needs it to know that the
                // iteration is finished (and pops it itself before returning).
                Some(UpcallStep::Resume(resume_rip))
            }
            None => None,
        }
    }

    /// Scans a CRT initializer table (`__xc_a`..`__xc_z`) for the next callable entry.
    ///
    /// Returns `(slot_va, function_va)`; the caller must advance the cursor with `slot_va + 8`.
    ///
    /// The earlier version advanced with `function_va + 8`, i.e. it used the *callee's* address as
    /// the table cursor. After the first constructor (`pre_c_init` at `0x401000`) that pointed into
    /// `.text`, and the 8 instruction bytes at `0x401008` were read as a function pointer
    /// (`0x0001_00c7_0002_701c`), which is exactly the `0x100c70002701c` the guest jumped to.
    /// Entries that do not land in a mapped region are skipped instead of being called.
    /// True when `addr` is backed by a mapped region the CPU may execute from.
    ///
    /// `find_region(...).is_some()` is not enough: the VMM keeps unmapped-but-reserved slots, so a
    /// garbage "function pointer" taken out of instruction bytes passed the old check.
    fn is_executable(vmm: &VirtualMemoryManager, addr: u64) -> bool {
        match vmm.find_region(addr) {
            Some(reg) => matches!(reg.protect, 0x10 | 0x20 | 0x40 | 0x80),
            None => false,
        }
    }

    fn find_next_initterm_fn(
        &self,
        vmm: &mut VirtualMemoryManager,
        from: u64,
        end: u64,
    ) -> Option<(u64, u64)> {
        // A wild `end` (the API is also reachable with a garbage table) would walk the scan into
        // unrelated `.rdata` and "find" instruction bytes as a function pointer, so the window is
        // clamped and the scan is capped.
        let end = end.min(from.saturating_add(0x1_0000));
        let mut p = from;
        let mut scanned = 0u32;
        while p + 8 <= end && scanned < 1024 {
            scanned += 1;
            let fn_ptr = match vmm.read_u64(p) {
                Ok(v) => v,
                Err(_) => return None,
            };
            if fn_ptr != 0 && Self::is_executable(vmm, fn_ptr) {
                return Some((p, fn_ptr));
            }
            p += 8;
        }
        None
    }

    fn run_pending_threads_for(&mut self, _vmm: &mut VirtualMemoryManager, _handle: u64) -> bool {
        false
    }

    fn run_all_pending_threads(&mut self, _vmm: &mut VirtualMemoryManager) {}
}
