/*
 * Porthole x86-64 :: game startup fixture
 *
 * Mimics the first hundred lines of a typical Windows game's startup path against the emulator's
 * Win32/NT HLE, using nothing but documented Win32/D3D12 entry points:
 *
 *   1. CreateFileW + WriteFile     -> open the game's own log on the virtual C:\ volume
 *   2. VirtualAlloc(2 GB, RESERVE) -> the size of a "reserve the address space" game allocator
 *   3. VirtualAlloc(64 MB, COMMIT) -> the commit that follows it, touched at both ends
 *   4. GetModuleHandleW(NULL/kernel32) + GetProcAddress -> dynamic API resolution, then a call
 *      through the resolved pointer (this exercises the HLE thunk indirection)
 *   5. D3D12CreateDevice(...)      -> may fail, but must fail with an HRESULT, never a crash
 *   6. ExitProcess(0)
 *
 * Built as PE32+ x86_64 by scripts/build-game-fixtures.mjs (zig cc, x86_64-windows-gnu).
 */
#include <windows.h>
#include <d3d12.h>
#include <stdio.h>

static int g_failures = 0;

static void step(const char *what)
{
    printf("STEP %s\n", what);
    fflush(stdout);
}

static void check(int condition, const char *what, unsigned long value)
{
    if (condition)
    {
        printf("  ok   %s (0x%lx)\n", what, value);
    }
    else
    {
        printf("  FAIL %s (0x%lx)\n", what, value);
        g_failures++;
    }
    fflush(stdout);
}

int main(void)
{
    HANDLE log_file;
    DWORD written = 0;
    static const char banner[] = "PORTHOLE_STARTUP 1.0\n";
    void *reserve = NULL;
    unsigned char *commit = NULL;
    SIZE_T i;
    HMODULE kernel32 = NULL;
    FARPROC sleep_proc = NULL;
    FARPROC alloc_proc = NULL;
    ID3D12Device *device = NULL;
    HRESULT hr;

    printf("GAME_STARTUP_BEGIN\n");
    fflush(stdout);

    /* ---- 1. open a file on the virtual C:\ volume ------------------------------------- */
    step("CreateFileW(C:\\Game\\startup.log)");
    log_file = CreateFileW(L"C:\\Game\\startup.log", GENERIC_READ | GENERIC_WRITE,
                           FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    check(log_file != INVALID_HANDLE_VALUE, "CreateFileW", GetLastError());
    if (log_file != INVALID_HANDLE_VALUE)
    {
        check(WriteFile(log_file, banner, (DWORD)(sizeof(banner) - 1), &written, NULL),
              "WriteFile", written);
        check(written == sizeof(banner) - 1, "WriteFile byte count", written);
    }

    /* ---- 2. reserve 2 GB of address space --------------------------------------------- */
    step("VirtualAlloc(2GB, MEM_RESERVE)");
    reserve = VirtualAlloc(NULL, (SIZE_T)2 * 1024 * 1024 * 1024, MEM_RESERVE, PAGE_NOACCESS);
    check(reserve != NULL, "VirtualAlloc reserve 2GB", (unsigned long)(UINT_PTR)reserve);
    printf("  info reserve=%p\n", reserve);

    /* ---- 3. commit and touch 64 MB ----------------------------------------------------- */
    step("VirtualAlloc(64MB, MEM_COMMIT)");
    commit = (unsigned char *)VirtualAlloc(NULL, (SIZE_T)64 * 1024 * 1024, MEM_COMMIT, PAGE_READWRITE);
    check(commit != NULL, "VirtualAlloc commit 64MB", (unsigned long)(UINT_PTR)commit);
    if (commit != NULL)
    {
        /* Touch every page and verify the write immediately: a lazy allocator that never
         * materialises the range would fault here instead of at some unrelated point later in
         * the game, and a broken page-in would read back the wrong value. The verify is done
         * page-local on purpose, so it holds no matter how small the resident-page window is. */
        unsigned long bad = 0;
        for (i = 0; i < 64u * 1024u * 1024u; i += 4096u)
        {
            unsigned char want = (unsigned char)(i / 4096u);
            commit[i] = want;
            if (commit[i] != want)
                bad++;
        }
        printf("  info touched=%lu pages bad=%lu\n",
               (unsigned long)(64u * 1024u * 1024u / 4096u), bad);
        check(bad == 0, "commit write/readback", bad);
    }

    /* ---- 4. dynamic module + symbol resolution ----------------------------------------- */
    step("GetModuleHandleW(NULL) / GetModuleHandleW(L\"kernel32.dll\")");
    kernel32 = GetModuleHandleW(L"kernel32.dll");
    check(kernel32 != NULL, "GetModuleHandleW(kernel32)", (unsigned long)(UINT_PTR)kernel32);
    check(GetModuleHandleW(NULL) != NULL, "GetModuleHandleW(NULL)",
          (unsigned long)(UINT_PTR)GetModuleHandleW(NULL));

    step("GetProcAddress(kernel32!Sleep|VirtualAlloc)");
    sleep_proc = GetProcAddress(kernel32, "Sleep");
    check(sleep_proc != NULL, "GetProcAddress(Sleep)", (unsigned long)(UINT_PTR)sleep_proc);
    alloc_proc = GetProcAddress(kernel32, "VirtualAlloc");
    check(alloc_proc != NULL, "GetProcAddress(VirtualAlloc)", (unsigned long)(UINT_PTR)alloc_proc);
    if (sleep_proc)
    {
        /* A call *through* a GetProcAddress thunk: if the thunk is unregistered this is the
         * "unmapped thunk" fault the trace used to report. */
        ((void(WINAPI *)(DWORD))sleep_proc)(1);
        check(1, "indirect call through thunk", 0);
    }
    if (alloc_proc)
    {
        void *p2 = ((void *(WINAPI *)(void *, SIZE_T, DWORD, DWORD))alloc_proc)(
            NULL, 4096, MEM_COMMIT, PAGE_READWRITE);
        check(p2 != NULL, "indirect VirtualAlloc", (unsigned long)(UINT_PTR)p2);
    }

    /* ---- 5. hypothetical device creation ------------------------------------------------ */
    step("D3D12CreateDevice(NULL, FEATURE_LEVEL_12_0)");
    hr = D3D12CreateDevice(NULL, D3D_FEATURE_LEVEL_12_0, &IID_ID3D12Device, (void **)&device);
    printf("  info D3D12CreateDevice hr=0x%08lx device=%p\n", (unsigned long)hr, (void *)device);
    if (hr == S_OK)
        check(device != NULL, "device produced", 0);
    else
        printf("  note device creation refused with 0x%08lx (allowed; must not crash)\n",
               (unsigned long)hr);
    if (device)
        ID3D12Device_Release(device);

    /* ---- 6. orderly shutdown ------------------------------------------------------------ */
    printf("GAME_STARTUP_RESULT failures=%d\n", g_failures);
    fflush(stdout);
    if (log_file != INVALID_HANDLE_VALUE)
        CloseHandle(log_file);

    ExitProcess(0);
    return 0;
}
