use std::collections::{BTreeMap, HashMap, HashSet};

pub const PAGE_SIZE: usize = 4096;
pub const PAGE_MASK: u64 = 0xFFF;
pub const PAGE_SHIFT: u32 = 12;

pub const MEM_COMMIT: u32 = 0x0000_1000;
pub const MEM_RESERVE: u32 = 0x0000_2000;
pub const MEM_DECOMMIT: u32 = 0x0000_4000;
pub const MEM_RELEASE: u32 = 0x0000_8000;
pub const MEM_PRIVATE: u32 = 0x0002_0000;
pub const MEM_IMAGE: u32 = 0x0100_0000;

pub const PAGE_NOACCESS: u32 = 0x01;
pub const PAGE_READONLY: u32 = 0x02;
pub const PAGE_READWRITE: u32 = 0x04;
pub const PAGE_WRITECOPY: u32 = 0x08;
pub const PAGE_EXECUTE: u32 = 0x10;
pub const PAGE_EXECUTE_READ: u32 = 0x20;
pub const PAGE_EXECUTE_READWRITE: u32 = 0x40;
pub const PAGE_EXECUTE_WRITECOPY: u32 = 0x80;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryTrap {
    /// Guest touched a committed page that was evicted to NVMe swap storage.
    PageFault(u64),
    /// Guest touched an unmapped or access-protected virtual address.
    AccessViolation(u64),
}

#[derive(Debug, Clone)]
pub struct VmaRegion {
    pub base: u64,
    pub size: u64,
    pub allocation_base: u64,
    pub allocation_protect: u32,
    pub protect: u32,
    pub state: u32,
    pub mem_type: u32,
}

#[derive(Debug, Clone)]
pub struct EvictedPage {
    pub page_base: u64,
    pub data: Vec<u8>,
}

struct PageEntry {
    data: Vec<u8>,
    dirty: bool,
    pinned: bool,
    last_used_gen: u64,
}

/// One observed store inside the watched VA window (see [`VirtualMemoryManager::set_write_watch`]).
///
/// `rip` is the guest instruction pointer that was executing when the store happened, supplied by
/// the CPU driver through [`VirtualMemoryManager::current_rip`]. This turns the VMM into a
/// data-breakpoint engine: it answers "who overwrote this stack slot, with what value".
#[derive(Debug, Clone, Copy)]
pub struct WatchEvent {
    pub rip: u64,
    pub addr: u64,
    pub len: u64,
    pub value: u64,
    /// `true` when the store came from loader/HLE privileged code rather than a guest instruction.
    pub host: bool,
}

/// Phase 2: NVMe-backed VirtualMemoryManager.
///
/// Manages a 64-bit sparse virtual address space (supporting 16 GB–64 GB+ guest VA ranges)
/// backed by an in-Wasm LRU page cache (`HashMap<u64, Vec<u8>>` semantics) and an eviction/fault
/// queue bridged to `FileSystemDirectoryHandle` swap shards on the host NVMe drive.
pub struct VirtualMemoryManager {
    page_cache: HashMap<u64, PageEntry>,
    swapped_out_pages: HashSet<u64>,
    evicted_dirty_pages: Vec<EvictedPage>,
    page_write_epochs: HashMap<u64, u32>,
    regions: BTreeMap<u64, VmaRegion>,
    max_resident_pages: usize,
    access_gen: u64,
    next_dynamic_va: u64,
    pub pages_evicted: u64,
    pub pages_faulted_in: u64,
    pub dirty_pages_queued: u64,
    /// Guest RIP stamped onto [`WatchEvent`]s; maintained by the execution driver.
    pub current_rip: u64,
    watch_ranges: Vec<(u64, u64)>,
    watch_len: usize,
    pub watch_log: Vec<WatchEvent>,
}

impl VirtualMemoryManager {
    pub fn new(max_resident_pages: usize) -> Self {
        Self {
            page_cache: HashMap::new(),
            swapped_out_pages: HashSet::new(),
            evicted_dirty_pages: Vec::new(),
            page_write_epochs: HashMap::new(),
            regions: BTreeMap::new(),
            max_resident_pages: max_resident_pages.max(64),
            access_gen: 1,
            // Dynamic VirtualAlloc(NULL, ...) starts above 16 GB to exercise true 64-bit VA space
            next_dynamic_va: 0x0000_0004_4000_0000,
            pages_evicted: 0,
            pages_faulted_in: 0,
            dirty_pages_queued: 0,
            current_rip: 0,
            watch_ranges: Vec::new(),
            watch_len: 0,
            watch_log: Vec::new(),
        }
    }

    /// Arms a data breakpoint over `[lo, hi)`. Every overlapping store is appended to
    /// [`Self::watch_log`] (capped at `capacity` entries) with the value written and the RIP that
    /// wrote it. `capacity == 0` disables the watch.
    pub fn set_write_watch(&mut self, lo: u64, hi: u64, capacity: usize) {
        self.watch_ranges.clear();
        self.watch_ranges.push((lo, hi));
        self.watch_len = capacity;
        self.watch_log.clear();
        self.watch_log.reserve(capacity.min(4096));
    }

    /// Adds another watched window without disturbing the existing ones (stack + globals + heap).
    pub fn add_write_watch(&mut self, lo: u64, hi: u64, capacity: usize) {
        self.watch_ranges.push((lo, hi));
        self.watch_len = self.watch_len.max(capacity);
    }

    pub fn clear_write_watch(&mut self) {
        self.watch_ranges.clear();
        self.watch_len = 0;
        self.watch_log.clear();
    }

    #[inline]
    fn note_write(&mut self, addr: u64, data: &[u8], host: bool) {
        if self.watch_len == 0 || self.watch_log.len() >= self.watch_len {
            return;
        }
        let end = addr.wrapping_add(data.len() as u64);
        let hit = self
            .watch_ranges
            .iter()
            .any(|&(lo, hi)| end > lo && addr < hi);
        if !hit {
            return;
        }
        let mut head = [0u8; 8];
        let n = data.len().min(8);
        head[..n].copy_from_slice(&data[..n]);
        self.watch_log.push(WatchEvent {
            rip: self.current_rip,
            addr,
            len: data.len() as u64,
            value: u64::from_le_bytes(head),
            host,
        });
    }

    /// Human-readable residency/protection report for one page, used by fault snapshots.
    pub fn describe_page(&self, addr: u64) -> String {
        let page_base = Self::align_down(addr);
        let region = self.find_region(page_base);
        let resident = self.page_cache.get(&page_base).map(|e| {
            format!(
                "resident dirty={} pinned={} gen={}",
                e.dirty, e.pinned, e.last_used_gen
            )
        });
        format!(
            "page=0x{:x} region={} swapped={} resident={} epoch={}",
            page_base,
            match region {
                Some(r) => format!(
                    "0x{:x}+0x{:x} state=0x{:x} prot=0x{:x} type=0x{:x}",
                    r.base, r.size, r.state, r.protect, r.mem_type
                ),
                None => "UNMAPPED".to_string(),
            },
            self.swapped_out_pages.contains(&page_base),
            resident.unwrap_or_else(|| "absent".to_string()),
            self.page_write_epoch(page_base)
        )
    }

    pub fn set_max_resident_pages(&mut self, max_pages: usize) {
        self.max_resident_pages = max_pages.max(64);
        self.evict_if_needed(None);
    }

    pub fn max_resident_pages(&self) -> usize {
        self.max_resident_pages
    }

    pub fn resident_page_count(&self) -> usize {
        self.page_cache.len()
    }

    pub fn swapped_page_count(&self) -> usize {
        self.swapped_out_pages.len()
    }

    #[inline]
    pub fn is_page_swapped(&self, page_base: u64) -> bool {
        self.swapped_out_pages.contains(&(page_base & !PAGE_MASK))
    }

    #[inline]
    pub fn align_down(addr: u64) -> u64 {
        addr & !PAGE_MASK
    }

    #[inline]
    pub fn align_up(size: u64) -> u64 {
        if size == 0 {
            PAGE_SIZE as u64
        } else {
            (size + PAGE_MASK) & !PAGE_MASK
        }
    }

    #[inline]
    pub fn page_write_epoch(&self, page_base: u64) -> u32 {
        self.page_write_epochs
            .get(&(page_base & !PAGE_MASK))
            .copied()
            .unwrap_or(0)
    }

    #[inline]
    fn bump_gen(&mut self) -> u64 {
        self.access_gen = self.access_gen.wrapping_add(1);
        self.access_gen
    }

    #[inline]
    fn bump_write_epoch(&mut self, page_base: u64) {
        let e = self.page_write_epochs.entry(page_base).or_insert(0);
        *e = e.wrapping_add(1);
    }

    pub fn map_region(
        &mut self,
        base: u64,
        size: u64,
        protect: u32,
        state: u32,
        mem_type: u32,
        pinned: bool,
    ) {
        let aligned_base = Self::align_down(base);
        let end = Self::align_up(base.saturating_add(size));
        let aligned_size = end.saturating_sub(aligned_base).max(PAGE_SIZE as u64);
        self.regions.insert(
            aligned_base,
            VmaRegion {
                base: aligned_base,
                size: aligned_size,
                allocation_base: aligned_base,
                allocation_protect: protect,
                protect,
                state,
                mem_type,
            },
        );
        if pinned && (state & MEM_COMMIT) != 0 {
            let mut page = aligned_base;
            while page < aligned_base + aligned_size {
                let gen = self.bump_gen();
                let entry = self.page_cache.entry(page).or_insert_with(|| PageEntry {
                    data: vec![0u8; PAGE_SIZE],
                    dirty: false,
                    pinned: true,
                    last_used_gen: gen,
                });
                entry.pinned = true;
                entry.last_used_gen = gen;
                page += PAGE_SIZE as u64;
            }
        }
    }

    pub fn virtual_alloc(
        &mut self,
        requested_addr: u64,
        size: u64,
        alloc_type: u32,
        protect: u32,
    ) -> u64 {
        if size == 0 {
            return 0;
        }
        let aligned_size = Self::align_up(size);
        let commit = (alloc_type & MEM_COMMIT) != 0;
        let reserve = (alloc_type & MEM_RESERVE) != 0;
        if !commit && !reserve {
            return 0;
        }

        if requested_addr != 0 {
            let aligned_addr = if reserve {
                requested_addr & !0xFFFF
            } else {
                Self::align_down(requested_addr)
            };

            // Check if committing inside an existing reserved/committed region
            if let Some((&reg_base, existing)) = self.regions.range(..=aligned_addr).next_back() {
                let reg_end = reg_base.saturating_add(existing.size);
                if aligned_addr >= reg_base && aligned_addr.saturating_add(aligned_size) <= reg_end {
                    if reserve && existing.state != 0 {
                        // Cannot re-reserve an already reserved range unless also committing same base
                        if !commit || aligned_addr != reg_base {
                            return 0;
                        }
                    }
                    let mut updated = existing.clone();
                    if commit {
                        updated.state = MEM_COMMIT;
                    }
                    if protect != 0 {
                        updated.protect = protect;
                    }
                    self.regions.insert(reg_base, updated);
                    return aligned_addr;
                }
            }

            // Check overlap with next region
            if let Some((&next_base, _)) = self.regions.range(aligned_addr..).next() {
                if aligned_addr.saturating_add(aligned_size) > next_base {
                    return 0;
                }
            }

            let state = if commit { MEM_COMMIT } else { MEM_RESERVE };
            self.regions.insert(
                aligned_addr,
                VmaRegion {
                    base: aligned_addr,
                    size: aligned_size,
                    allocation_base: aligned_addr,
                    allocation_protect: protect,
                    protect,
                    state,
                    mem_type: MEM_PRIVATE,
                },
            );
            return aligned_addr;
        }

        // Dynamic allocation on 64 KB Win32 allocation granularity boundary
        let mut candidate = (self.next_dynamic_va + 0xFFFF) & !0xFFFF;
        loop {
            let candidate_end = candidate.saturating_add(aligned_size);
            let mut conflict_end = None;
            if let Some((&prev_base, prev_reg)) = self.regions.range(..=candidate).next_back() {
                let prev_end = prev_base.saturating_add(prev_reg.size);
                if prev_end > candidate {
                    conflict_end = Some(prev_end);
                }
            }
            if conflict_end.is_none() {
                if let Some((&next_base, next_reg)) = self.regions.range(candidate..).next() {
                    if next_base < candidate_end {
                        conflict_end = Some(next_base.saturating_add(next_reg.size));
                    }
                }
            }
            if let Some(end) = conflict_end {
                candidate = (end + 0xFFFF) & !0xFFFF;
                continue;
            }
            break;
        }

        self.next_dynamic_va = ((candidate + aligned_size) + 0xFFFF) & !0xFFFF;
        let state = if commit { MEM_COMMIT } else { MEM_RESERVE };
        self.regions.insert(
            candidate,
            VmaRegion {
                base: candidate,
                size: aligned_size,
                allocation_base: candidate,
                allocation_protect: protect,
                protect,
                state,
                mem_type: MEM_PRIVATE,
            },
        );
        candidate
    }

    pub fn virtual_free(&mut self, addr: u64, size: u64, free_type: u32) -> bool {
        let aligned = Self::align_down(addr);
        if (free_type & MEM_RELEASE) != 0 {
            if size != 0 {
                return false;
            }
            if let Some(reg) = self.regions.remove(&aligned) {
                let mut page = reg.base;
                while page < reg.base + reg.size {
                    self.page_cache.remove(&page);
                    self.swapped_out_pages.remove(&page);
                    page += PAGE_SIZE as u64;
                }
                return true;
            }
            return false;
        }
        if (free_type & MEM_DECOMMIT) != 0 {
            if let Some((&reg_base, reg)) = self.regions.range(..=aligned).next_back() {
                if aligned < reg_base + reg.size {
                    let decommit_len = if size == 0 {
                        reg.size - (aligned - reg_base)
                    } else {
                        Self::align_up(size)
                    };
                    let mut page = aligned;
                    while page < aligned.saturating_add(decommit_len) && page < reg_base + reg.size {
                        self.page_cache.remove(&page);
                        self.swapped_out_pages.remove(&page);
                        page += PAGE_SIZE as u64;
                    }
                    return true;
                }
            }
        }
        false
    }

    pub fn virtual_protect(&mut self, addr: u64, _size: u64, new_protect: u32) -> Option<u32> {
        let aligned = Self::align_down(addr);
        if let Some((_, reg)) = self.regions.range_mut(..=aligned).next_back() {
            if aligned < reg.base + reg.size {
                let old = reg.protect;
                reg.protect = new_protect;
                return Some(old);
            }
        }
        None
    }

    pub fn find_region(&self, addr: u64) -> Option<&VmaRegion> {
        let aligned = Self::align_down(addr);
        if let Some((_, reg)) = self.regions.range(..=aligned).next_back() {
            if aligned < reg.base + reg.size {
                return Some(reg);
            }
        }
        None
    }

    fn check_committed(&self, page_base: u64, is_write: bool) -> Result<(), MemoryTrap> {
        if let Some(reg) = self.find_region(page_base) {
            if (reg.state & MEM_COMMIT) == 0 || reg.protect == PAGE_NOACCESS {
                return Err(MemoryTrap::AccessViolation(page_base));
            }
            if is_write
                && (reg.protect == PAGE_READONLY || reg.protect == PAGE_EXECUTE_READ || reg.protect == PAGE_EXECUTE)
            {
                // Allow HLE/loader writes via host_write_bytes; guest writes respect protection
                return Err(MemoryTrap::AccessViolation(page_base));
            }
            Ok(())
        } else {
            Err(MemoryTrap::AccessViolation(page_base))
        }
    }

    fn evict_if_needed(&mut self, protected_page: Option<u64>) {
        while self.page_cache.len() > self.max_resident_pages {
            let before = self.page_cache.len();
            self.evict_if_needed_locked(protected_page);
            if self.page_cache.len() == before {
                break;
            }
        }
    }

    /// Evicts exactly one unpinned LRU page (no-op when every resident page is pinned).
    fn evict_if_needed_locked(&mut self, protected_page: Option<u64>) {
        let mut oldest_key: Option<u64> = None;
        let mut oldest_gen = u64::MAX;
        for (&k, entry) in &self.page_cache {
            if entry.pinned || Some(k) == protected_page {
                continue;
            }
            if entry.last_used_gen < oldest_gen {
                oldest_gen = entry.last_used_gen;
                oldest_key = Some(k);
            }
        }
        let Some(victim_base) = oldest_key else {
            return;
        };
        if let Some(victim) = self.page_cache.remove(&victim_base) {
            self.pages_evicted += 1;
            self.swapped_out_pages.insert(victim_base);
            if victim.dirty {
                self.dirty_pages_queued += 1;
                self.evicted_dirty_pages.push(EvictedPage {
                    page_base: victim_base,
                    data: victim.data,
                });
            }
        }
    }

    /// Evicts LRU pages until a new page fits inside the configured RAM budget.
    fn make_room_for_insert(&mut self, protected_page: Option<u64>) {
        while self.page_cache.len() >= self.max_resident_pages {
            let before = self.page_cache.len();
            self.evict_if_needed_locked(protected_page);
            if self.page_cache.len() == before {
                break;
            }
        }
    }

    fn ensure_page_mut(
        &mut self,
        page_base: u64,
        mark_dirty: bool,
        enforce_protect: bool,
        protected_peer: Option<u64>,
    ) -> Result<&mut [u8], MemoryTrap> {
        if enforce_protect {
            self.check_committed(page_base, mark_dirty)?;
        }
        if self.swapped_out_pages.contains(&page_base) {
            return Err(MemoryTrap::PageFault(page_base));
        }

        let gen = self.bump_gen();
        if !self.page_cache.contains_key(&page_base) {
            self.make_room_for_insert(protected_peer);
            let gen2 = self.bump_gen();
            self.page_cache.insert(
                page_base,
                PageEntry {
                    data: vec![0u8; PAGE_SIZE],
                    dirty: mark_dirty,
                    pinned: false,
                    last_used_gen: gen2,
                },
            );
        }
        if mark_dirty {
            self.bump_write_epoch(page_base);
        }
        let entry = self.page_cache.get_mut(&page_base).unwrap();
        entry.last_used_gen = gen;
        if mark_dirty {
            entry.dirty = true;
        }
        Ok(&mut entry.data)
    }

    /// Phase 2 required interface: `read_page(addr: u64) -> [u8; 4096]` (trap-aware).
    pub fn read_page(&mut self, addr: u64) -> Result<[u8; PAGE_SIZE], MemoryTrap> {
        let page_base = Self::align_down(addr);
        let slice = self.ensure_page_mut(page_base, false, true, None)?;
        let mut out = [0u8; PAGE_SIZE];
        out.copy_from_slice(slice);
        Ok(out)
    }

    /// Phase 2 required interface: `write_page(addr: u64, data: [u8; 4096])` (trap-aware).
    pub fn write_page(&mut self, addr: u64, data: [u8; PAGE_SIZE]) -> Result<(), MemoryTrap> {
        let page_base = Self::align_down(addr);
        self.check_committed(page_base, true)?;
        // Writing an entire 4 KB page overwrites any swapped contents without needing read-before-write.
        self.swapped_out_pages.remove(&page_base);
        if !self.page_cache.contains_key(&page_base) {
            self.make_room_for_insert(None);
        }
        let gen = self.bump_gen();
        self.bump_write_epoch(page_base);
        let entry = self.page_cache.entry(page_base).or_insert_with(|| PageEntry {
            data: vec![0u8; PAGE_SIZE],
            dirty: true,
            pinned: false,
            last_used_gen: gen,
        });
        entry.data.copy_from_slice(&data);
        entry.dirty = true;
        entry.last_used_gen = gen;
        Ok(())
    }

    /// Supplies a 4 KB page fetched asynchronously from the NVMe swap shard after `MemoryTrap::PageFault`.
    pub fn supply_faulted_page(&mut self, addr: u64, data: &[u8]) {
        let page_base = Self::align_down(addr);
        self.swapped_out_pages.remove(&page_base);
        if !self.page_cache.contains_key(&page_base) {
            self.make_room_for_insert(None);
        }
        let gen = self.bump_gen();
        let mut page_vec = vec![0u8; PAGE_SIZE];
        let copy_len = data.len().min(PAGE_SIZE);
        page_vec[..copy_len].copy_from_slice(&data[..copy_len]);
        self.page_cache.insert(
            page_base,
            PageEntry {
                data: page_vec,
                dirty: false,
                pinned: false,
                last_used_gen: gen,
            },
        );
        self.pages_faulted_in += 1;
    }

    /// Drains dirty pages evicted from the LRU cache (or explicitly flushed) so the JS host
    /// can persist them asynchronously to NVMe swap shards via `FileSystemWritableFileStream`.
    pub fn drain_evicted_dirty_pages(&mut self) -> Vec<EvictedPage> {
        std::mem::take(&mut self.evicted_dirty_pages)
    }

    /// Collects resident dirty pages for periodic background checkpointing without evicting them.
    pub fn checkpoint_dirty_pages(&mut self, max_pages: usize) -> Vec<EvictedPage> {
        let mut out = Vec::new();
        for (&page_base, entry) in self.page_cache.iter_mut() {
            if entry.dirty && !entry.pinned {
                entry.dirty = false;
                self.dirty_pages_queued += 1;
                out.push(EvictedPage {
                    page_base,
                    data: entry.data.clone(),
                });
                if out.len() >= max_pages {
                    break;
                }
            }
        }
        out
    }

    /// Pre-checks that an entire `[addr, addr + len)` range can be read/written without faulting,
    /// ensuring multi-page accesses never partially mutate guest memory before raising `PageFault`.
    pub fn preflight_range(&mut self, addr: u64, len: usize, is_write: bool) -> Result<(), MemoryTrap> {
        if len == 0 {
            return Ok(());
        }
        let first_page = Self::align_down(addr);
        let last_page = Self::align_down(addr.wrapping_add((len - 1) as u64));
        let mut p = first_page;
        loop {
            self.check_committed(p, is_write)?;
            if self.swapped_out_pages.contains(&p) {
                return Err(MemoryTrap::PageFault(p));
            }
            if p == last_page {
                break;
            }
            p = p.wrapping_add(PAGE_SIZE as u64);
        }
        Ok(())
    }

    pub fn read_bytes(&mut self, addr: u64, out: &mut [u8]) -> Result<(), MemoryTrap> {
        if out.is_empty() {
            return Ok(());
        }
        let first_page = Self::align_down(addr);
        let last_page = Self::align_down(addr.wrapping_add((out.len() - 1) as u64));
        if first_page == last_page {
            let off = (addr & PAGE_MASK) as usize;
            let page = self.ensure_page_mut(first_page, false, true, None)?;
            out.copy_from_slice(&page[off..off + out.len()]);
            return Ok(());
        }
        self.preflight_range(addr, out.len(), false)?;
        let mut cursor = 0usize;
        while cursor < out.len() {
            let cur_va = addr.wrapping_add(cursor as u64);
            let page_base = Self::align_down(cur_va);
            let off = (cur_va & PAGE_MASK) as usize;
            let chunk = (PAGE_SIZE - off).min(out.len() - cursor);
            let page = self.ensure_page_mut(page_base, false, true, Some(first_page))?;
            out[cursor..cursor + chunk].copy_from_slice(&page[off..off + chunk]);
            cursor += chunk;
        }
        Ok(())
    }

    pub fn write_bytes(&mut self, addr: u64, data: &[u8]) -> Result<(), MemoryTrap> {
        if data.is_empty() {
            return Ok(());
        }
        self.note_write(addr, data, false);
        let first_page = Self::align_down(addr);
        let last_page = Self::align_down(addr.wrapping_add((data.len() - 1) as u64));
        if first_page == last_page {
            let off = (addr & PAGE_MASK) as usize;
            let page = self.ensure_page_mut(first_page, true, true, None)?;
            page[off..off + data.len()].copy_from_slice(data);
            return Ok(());
        }
        self.preflight_range(addr, data.len(), true)?;
        let mut cursor = 0usize;
        while cursor < data.len() {
            let cur_va = addr.wrapping_add(cursor as u64);
            let page_base = Self::align_down(cur_va);
            let off = (cur_va & PAGE_MASK) as usize;
            let chunk = (PAGE_SIZE - off).min(data.len() - cursor);
            let page = self.ensure_page_mut(page_base, true, true, Some(first_page))?;
            page[off..off + chunk].copy_from_slice(&data[cursor..cursor + chunk]);
            cursor += chunk;
        }
        Ok(())
    }

    /// Loader/HLE privileged write (bypasses guest read-only page flags when populating PE `.rdata`/`.text`).
    pub fn host_write_bytes(&mut self, addr: u64, data: &[u8]) -> Result<(), MemoryTrap> {
        if !data.is_empty() {
            self.note_write(addr, data, true);
        }
        let mut cursor = 0usize;
        while cursor < data.len() {
            let cur_va = addr.wrapping_add(cursor as u64);
            let page_base = Self::align_down(cur_va);
            if self.swapped_out_pages.contains(&page_base) {
                return Err(MemoryTrap::PageFault(page_base));
            }
            let off = (cur_va & PAGE_MASK) as usize;
            let chunk = (PAGE_SIZE - off).min(data.len() - cursor);
            let page = self.ensure_page_mut(page_base, true, false, None)?;
            page[off..off + chunk].copy_from_slice(&data[cursor..cursor + chunk]);
            cursor += chunk;
        }
        Ok(())
    }

    pub fn host_read_bytes(&mut self, addr: u64, out: &mut [u8]) -> Result<(), MemoryTrap> {
        let mut cursor = 0usize;
        while cursor < out.len() {
            let cur_va = addr.wrapping_add(cursor as u64);
            let page_base = Self::align_down(cur_va);
            if self.swapped_out_pages.contains(&page_base) {
                return Err(MemoryTrap::PageFault(page_base));
            }
            let off = (cur_va & PAGE_MASK) as usize;
            let chunk = (PAGE_SIZE - off).min(out.len() - cursor);
            let page = self.ensure_page_mut(page_base, false, false, None)?;
            out[cursor..cursor + chunk].copy_from_slice(&page[off..off + chunk]);
            cursor += chunk;
        }
        Ok(())
    }

    #[inline]
    pub fn read_u8(&mut self, addr: u64) -> Result<u8, MemoryTrap> {
        let mut b = [0u8; 1];
        self.read_bytes(addr, &mut b)?;
        Ok(b[0])
    }

    #[inline]
    pub fn read_u16(&mut self, addr: u64) -> Result<u16, MemoryTrap> {
        let mut b = [0u8; 2];
        self.read_bytes(addr, &mut b)?;
        Ok(u16::from_le_bytes(b))
    }

    #[inline]
    pub fn read_u32(&mut self, addr: u64) -> Result<u32, MemoryTrap> {
        let mut b = [0u8; 4];
        self.read_bytes(addr, &mut b)?;
        Ok(u32::from_le_bytes(b))
    }

    #[inline]
    pub fn read_u64(&mut self, addr: u64) -> Result<u64, MemoryTrap> {
        let mut b = [0u8; 8];
        self.read_bytes(addr, &mut b)?;
        Ok(u64::from_le_bytes(b))
    }

    #[inline]
    pub fn read_u128(&mut self, addr: u64) -> Result<[u8; 16], MemoryTrap> {
        let mut b = [0u8; 16];
        self.read_bytes(addr, &mut b)?;
        Ok(b)
    }

    #[inline]
    pub fn read_u256(&mut self, addr: u64) -> Result<[u8; 32], MemoryTrap> {
        let mut b = [0u8; 32];
        self.read_bytes(addr, &mut b)?;
        Ok(b)
    }

    #[inline]
    pub fn write_u8(&mut self, addr: u64, val: u8) -> Result<(), MemoryTrap> {
        self.write_bytes(addr, &[val])
    }

    #[inline]
    pub fn write_u16(&mut self, addr: u64, val: u16) -> Result<(), MemoryTrap> {
        self.write_bytes(addr, &val.to_le_bytes())
    }

    #[inline]
    pub fn write_u32(&mut self, addr: u64, val: u32) -> Result<(), MemoryTrap> {
        self.write_bytes(addr, &val.to_le_bytes())
    }

    #[inline]
    pub fn write_u64(&mut self, addr: u64, val: u64) -> Result<(), MemoryTrap> {
        self.write_bytes(addr, &val.to_le_bytes())
    }

    #[inline]
    pub fn write_u128(&mut self, addr: u64, val: &[u8; 16]) -> Result<(), MemoryTrap> {
        self.write_bytes(addr, val)
    }

    #[inline]
    pub fn write_u256(&mut self, addr: u64, val: &[u8; 32]) -> Result<(), MemoryTrap> {
        self.write_bytes(addr, val)
    }

    pub fn read_c_string(&mut self, mut addr: u64, max_len: usize) -> Result<Vec<u8>, MemoryTrap> {
        if addr == 0 {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for _ in 0..max_len {
            let b = self.read_u8(addr)?;
            if b == 0 {
                break;
            }
            out.push(b);
            addr = addr.wrapping_add(1);
        }
        Ok(out)
    }

    pub fn read_wide_string(&mut self, mut addr: u64, max_chars: usize) -> Result<Vec<u16>, MemoryTrap> {
        if addr == 0 {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for _ in 0..max_chars {
            let ch = self.read_u16(addr)?;
            if ch == 0 {
                break;
            }
            out.push(ch);
            addr = addr.wrapping_add(2);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_high_64bit_va_and_lru_swap_roundtrip() {
        let mut vmm = VirtualMemoryManager::new(64);
        let high_base = 0x0000_0008_8000_0000u64; // 34 GB
        let got = vmm.virtual_alloc(high_base, 80 * 4096, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
        assert_eq!(got, high_base);

        for i in 0..80u64 {
            let mut page = [0u8; PAGE_SIZE];
            page[0..8].copy_from_slice(&(0xCAFE_0000_0000_0000u64 | i).to_le_bytes());
            vmm.write_page(high_base + i * 4096, page).unwrap();
        }

        assert!(vmm.pages_evicted >= 16);
        let evicted = vmm.drain_evicted_dirty_pages();
        assert!(!evicted.is_empty());

        // First page was evicted by LRU; reading it now must raise PageFault
        let fault = vmm.read_page(high_base);
        assert_eq!(fault, Err(MemoryTrap::PageFault(high_base)));

        // Supply the page back from simulated NVMe shard and verify contents
        let saved = evicted.iter().find(|p| p.page_base == high_base).unwrap();
        vmm.supply_faulted_page(high_base, &saved.data);
        let restored = vmm.read_page(high_base).unwrap();
        assert_eq!(
            u64::from_le_bytes(restored[0..8].try_into().unwrap()),
            0xCAFE_0000_0000_0000u64
        );
    }
}
