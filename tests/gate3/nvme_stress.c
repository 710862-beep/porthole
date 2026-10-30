// GATE 3 guest workload (DRAFT — not yet wired into CI).
//
// A deliberately authored PE32+ fixture (same zig pipeline as tests/game/*.c). It is NOT a
// third-party binary and proves nothing about compatibility; its only job is to be a
// deterministic memory hog: allocate a buffer FAR larger than the emulator's resident-page
// LRU window, fill it with a position-dependent pattern, then verify every byte after the
// buffer has necessarily been evicted to (and faulted back from) the host page store.
//
// Rules this file obeys because of how the emulator's trap works:
//  * The big buffer is touched ONLY through plain CPU loads/stores below. CPU memory ops
//    trap-and-resume correctly (MemoryTrap::PageFault unwinds before the access commits).
//    Bulk HLE helpers (memset/memcpy) are NOT used on the buffer: HLE arms call
//    vmm.write_bytes and ignore its Result, so an HLE copy spanning a swapped-out page
//    would silently drop data. That hazard is tracked in docs/gate3-nvme-memory-plan.md.
//  * Console output goes through WriteFile(GetStdHandle) — already exercised by fixtures.
//
// Pattern: word(page, word) is a splitmix-style hash of both coordinates, so aliasing two
// physical pages, serving a stale page, or corrupting a single word is detected, and the
// host can re-derive every expected byte without a golden copy (see run-nvme-stress.mjs).
//
// Exit code 0 and prints NVME_STRESS_OK iff every verified word matches.

#include <windows.h>

#define PAGE_WORDS 512ULL // 4096 bytes / 8

static unsigned long long pat(unsigned long long page, unsigned long long word) {
    unsigned long long x = (page + 1) * 0x9E3779B97F4A7C15ull + word * 0xD1B54A32D192ED03ull;
    x ^= x >> 29;
    x *= 0xBF58476D1CE4E5B9ull;
    x ^= x >> 32;
    return x;
}

static void out_str(HANDLE h, const char *s) {
    DWORD n = 0;
    DWORD len = 0;
    while (s[len]) len++;
    WriteFile(h, s, len, &n, NULL);
}

static void out_hex(HANDLE h, unsigned long long v) {
    char buf[19];
    int i = 18;
    buf[i] = 0;
    if (v == 0) buf[--i] = '0';
    while (v) {
        unsigned int d = (unsigned int)(v & 0xF);
        buf[--i] = (char)(d < 10 ? '0' + d : 'a' + (d - 10));
        v >>= 4;
    }
    buf[--i] = 'x';
    buf[--i] = '0';
    out_str(h, buf + i);
}

static void out_u64(HANDLE h, unsigned long long v) {
    char buf[24];
    int i = 23;
    buf[i] = 0;
    if (v == 0) buf[--i] = '0';
    while (v) { buf[--i] = (char)('0' + (v % 10)); v /= 10; }
    out_str(h, buf + i);
}

// Parse the first unsigned integer after the program name on the command line (MiB).
// Manual parse: keep this fixture free of CRT dependencies.
static unsigned long long parse_mib(void) {
    const char *cmd = GetCommandLineA();
    unsigned long long v = 0;
    int seen_digit = 0;
    int in_token = 0; // skip the program-name token (may itself contain digits)
    if (!cmd) return 512;
    while (*cmd && *cmd != ' ' && *cmd != '\t') cmd++; // skip argv[0]
    while (*cmd) {
        if (*cmd >= '0' && *cmd <= '9') {
            v = v * 10 + (unsigned long long)(*cmd - '0');
            seen_digit = 1;
            in_token = 1;
        } else if (in_token) {
            break;
        }
        cmd++;
    }
    return seen_digit ? v : 512;
}

int main(void) {
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    unsigned long long mib = parse_mib();
    if (mib < 16) mib = 16;
    unsigned long long pages = mib * 256ULL; // 1 MiB = 256 pages
    unsigned long long bytes = pages * 4096ULL;

    out_str(out, "NVME_STRESS_BEGIN mib=");
    out_u64(out, mib);
    out_str(out, " pages=");
    out_u64(out, pages);
    out_str(out, "\n");

    unsigned long long *buf = (unsigned long long *)VirtualAlloc(
        NULL, (SIZE_T)bytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (!buf) {
        out_str(out, "NVME_STRESS_FAIL virtualalloc\n");
        ExitProcess(3);
    }
    // The host re-derives every expected word from pat() and compares against its shard
    // files; it needs the buffer's guest VA to do that without guessing.
    out_str(out, "BUF_BASE=");
    out_hex(out, (unsigned long long)buf);
    out_str(out, "\n");

    // Phase 1: sequential write of the full pattern (streams evictions to the page store).
    for (unsigned long long p = 0; p < pages; p++) {
        unsigned long long *page = buf + p * PAGE_WORDS;
        for (unsigned long long w = 0; w < PAGE_WORDS; w++) {
            page[w] = pat(p, w);
        }
        if ((p & 0xFFF) == 0) { out_str(out, "W "); out_u64(out, p); out_str(out, "\n"); }
    }
    out_str(out, "PHASE_WRITE_DONE\n");

    // Phase 2: reverse-order verify. After phase 1 the LRU window holds the LAST pages
    // written; reading backwards faults on essentially every page again.
    unsigned long long bad = 0;
    unsigned long long first_bad_page = ~0ULL, first_bad_word = 0;
    for (unsigned long long pi = pages; pi-- > 0;) {
        unsigned long long *page = buf + pi * PAGE_WORDS;
        for (unsigned long long w = 0; w < PAGE_WORDS; w++) {
            if (page[w] != pat(pi, w)) {
                if (first_bad_page == ~0ULL) { first_bad_page = pi; first_bad_word = w; }
                bad++;
            }
        }
        if ((pi & 0xFFF) == 0) { out_str(out, "V "); out_u64(out, pi); out_str(out, "\n"); }
    }
    out_str(out, "PHASE_VERIFY_REV_DONE bad=");
    out_u64(out, bad);
    out_str(out, "\n");

    // Phase 3: deterministic pseudo-random single-word probes (LRU thrash: with a window of
    // a few MiB over hundreds of MiB, almost every probe must fault the page back in).
    unsigned long long state = 0x0123456789ABCDEFull;
    const unsigned long long probes = 200000;
    for (unsigned long long i = 0; i < probes; i++) {
        state = state * 6364136223846793005ull + 1442695040888963407ull;
        unsigned long long p = (state >> 33) % pages;
        unsigned long long w = (state >> 11) & (PAGE_WORDS - 1);
        if (buf[p * PAGE_WORDS + w] != pat(p, w)) {
            if (first_bad_page == ~0ULL) { first_bad_page = p; first_bad_word = w; }
            bad++;
        }
    }
    out_str(out, "PHASE_RANDOM_DONE probes=");
    out_u64(out, probes);
    out_str(out, " bad_total=");
    out_u64(out, bad);
    out_str(out, "\n");

    if (bad == 0) {
        out_str(out, "NVME_STRESS_OK pages=");
        out_u64(out, pages);
        out_str(out, " bad=0\n");
        ExitProcess(0);
    }
    out_str(out, "NVME_STRESS_FAIL bad=");
    out_u64(out, bad);
    out_str(out, " first_bad_page=");
    out_u64(out, first_bad_page);
    out_str(out, " first_bad_word=");
    out_u64(out, first_bad_word);
    out_str(out, "\n");
    ExitProcess(7);
    return 7;
}
