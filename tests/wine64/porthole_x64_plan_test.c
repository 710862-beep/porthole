/*
 * Porthole x86-64 Browser Emulator Architecture Conformance Test
 * Uses upstream Wine's wine/test.h harness (compiled as 64-bit PE32+ x86_64).
 */
#define COBJMACROS
#define WIDL_C_INLINE_WRAPPERS
#include <windows.h>
#include <initguid.h>
#include <d3d12.h>
#include <dxgi1_4.h>
#include "wine/test.h"

static void __attribute__((target("avx2"))) test_x64_gpr_and_simd_avx2(void)
{
    float sse_a[4]  = { 1.5f, -2.0f, 3.25f, 4.0f };
    float sse_b[4]  = { 0.5f,  6.0f, 0.75f, -1.0f };
    float sse_out[4] = { 0 };

    float avx_a[8]  = { 10.0f, 20.0f, 30.0f, 40.0f, 1.0f, 2.0f, 3.0f, 4.0f };
    float avx_b[8]  = {  5.0f, -5.0f, 12.0f,  2.0f, 9.0f, 8.0f, 7.0f, 6.0f };
    float avx_out[8] = { 0 };

    UINT32 i_a[8]   = { 100, 200, 300, 400, 500, 600, 700, 800 };
    UINT32 i_b[8]   = {   1,   2,   3,   4,   5,   6,   7,   8 };
    UINT32 i_out[8] = { 0 };
    int i;

    /* 128-bit SSE: movups + addps */
    __asm__ __volatile__(
        "movups (%1), %%xmm0\n\t"
        "movups (%2), %%xmm1\n\t"
        "addps %%xmm1, %%xmm0\n\t"
        "movups %%xmm0, (%0)\n\t"
        :
        : "r"(sse_out), "r"(sse_a), "r"(sse_b)
        : "xmm0", "xmm1", "memory"
    );
    ok(sse_out[0] == 2.0f && sse_out[1] == 4.0f && sse_out[2] == 4.0f && sse_out[3] == 3.0f,
       "SSE addps mismatch: %f %f %f %f\n", sse_out[0], sse_out[1], sse_out[2], sse_out[3]);

    /* 256-bit AVX: vmovups + vaddps on YMM2/YMM3/YMM4 */
    __asm__ __volatile__(
        "vmovups (%1), %%ymm2\n\t"
        "vmovups (%2), %%ymm3\n\t"
        "vaddps %%ymm3, %%ymm2, %%ymm4\n\t"
        "vmovups %%ymm4, (%0)\n\t"
        "vzeroupper\n\t"
        :
        : "r"(avx_out), "r"(avx_a), "r"(avx_b)
        : "xmm2", "xmm3", "xmm4", "memory"
    );
    for (i = 0; i < 8; i++)
    {
        float expected = avx_a[i] + avx_b[i];
        ok(avx_out[i] == expected, "AVX 256-bit vaddps lane %d: got %f expected %f\n", i, avx_out[i], expected);
    }

    /* 256-bit AVX2 integer SIMD: vpaddd on YMM5/YMM6/YMM7 */
    __asm__ __volatile__(
        "vmovdqu (%1), %%ymm5\n\t"
        "vmovdqu (%2), %%ymm6\n\t"
        "vpaddd %%ymm6, %%ymm5, %%ymm7\n\t"
        "vmovdqu %%ymm7, (%0)\n\t"
        "vzeroupper\n\t"
        :
        : "r"(i_out), "r"(i_a), "r"(i_b)
        : "xmm5", "xmm6", "xmm7", "memory"
    );
    for (i = 0; i < 8; i++)
    {
        ok(i_out[i] == i_a[i] + i_b[i], "AVX2 256-bit vpaddd lane %d: got %u expected %u\n",
           i, i_out[i], i_a[i] + i_b[i]);
    }
}

static void test_nvme_vmm_16gb_and_lru_paging(void)
{
    const SIZE_T page_count = 320; /* Exceeds compact test LRU window to force real NVMe swap eviction & reload */
    const SIZE_T region_bytes = page_count * 4096;
    BYTE *high_a = (BYTE *)VirtualAlloc((LPVOID)0x0000000440000000ULL, /* >17 GB VA */
                                        region_bytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    BYTE *high_b = (BYTE *)VirtualAlloc((LPVOID)0x0000000880000000ULL, /* >34 GB VA */
                                        64 * 4096, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    SIZE_T p;
    BOOL all_ok = TRUE;

    ok(high_a == (BYTE *)0x0000000440000000ULL, "Expected >16 GB sparse VA at 0x440000000, got %p\n", high_a);
    ok(high_b == (BYTE *)0x0000000880000000ULL, "Expected >32 GB sparse VA at 0x880000000, got %p\n", high_b);
    if (!high_a || !high_b) return;

    for (p = 0; p < page_count; p++)
    {
        UINT64 *slot = (UINT64 *)(high_a + p * 4096);
        slot[0] = 0xCAFEBABE00000000ULL ^ (p * 0x9E3779B97F4A7C15ULL);
        slot[511] = ~slot[0];
    }
    for (p = 0; p < 64; p++)
    {
        UINT64 *slot = (UINT64 *)(high_b + p * 4096);
        slot[0] = 0x123456789ABCDEF0ULL + p;
    }

    /* Re-read evicted pages from the beginning of high_a (forces NVMe shard readback!) */
    for (p = 0; p < page_count; p++)
    {
        UINT64 *slot = (UINT64 *)(high_a + p * 4096);
        UINT64 expected = 0xCAFEBABE00000000ULL ^ (p * 0x9E3779B97F4A7C15ULL);
        if (slot[0] != expected || slot[511] != ~expected)
        {
            all_ok = FALSE;
            break;
        }
    }
    ok(all_ok, "NVMe LRU page eviction/reload corrupted data at page %Iu\n", p);

    ok(VirtualFree(high_a, 0, MEM_RELEASE), "VirtualFree high_a failed\n");
    ok(VirtualFree(high_b, 0, MEM_RELEASE), "VirtualFree high_b failed\n");
}

typedef UINT64 (__attribute__((ms_abi)) *jit_fn_t)(UINT64 a, UINT64 b);

static void test_aot_and_self_modifying_jit(void)
{
    /* Emit Win64 MS-ABI function: mov rax, rcx (48 89 C8); add rax, rdx (48 01 D0); ret (C3) */
    static const BYTE add_code[7] = { 0x48, 0x89, 0xC8, 0x48, 0x01, 0xD0, 0xC3 };
    BYTE *code_page = (BYTE *)VirtualAlloc(NULL, 4096, MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE);
    jit_fn_t fn;
    UINT64 acc = 0;
    int i;

    ok(code_page != NULL, "VirtualAlloc PAGE_EXECUTE_READWRITE failed\n");
    if (!code_page) return;

    memcpy(code_page, add_code, sizeof(add_code));
    fn = (jit_fn_t)code_page;

    /* Execute 80 times to cross the runtime Wasm Micro-JIT hotness threshold (64) */
    for (i = 0; i < 80; i++)
        acc += fn(40, 2);
    ok(acc == 80 * 42, "Dynamic JIT execution mismatch: got %I64u expected %u\n", acc, 80 * 42);

    /* Self-modifying code: patch `add rax, rdx` (48 01 D0) -> `sub rax, rdx` (48 29 D0) */
    code_page[4] = 0x29;
    ok(fn(40, 2) == 38, "Self-modifying code epoch invalidation failed: got %I64u expected 38\n", fn(40, 2));

    VirtualFree(code_page, 0, MEM_RELEASE);
}

static void test_nvme_game_vfs_file_io(void)
{
    static const WCHAR pathW[] = L"C:\\Game\\nvme_save_test.bin";
    static const char payload[] = "PORTHOLE_NVME_X64_OK:1234567890";
    char read_buf[64] = { 0 };
    DWORD written = 0, read_bytes = 0, sz = 0;
    HANDLE hFile;

    hFile = CreateFileW(pathW, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ,
                        NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    ok(hFile != INVALID_HANDLE_VALUE, "CreateFileW on C:\\Game failed: err=%lu\n", GetLastError());
    if (hFile == INVALID_HANDLE_VALUE) return;

    ok(WriteFile(hFile, payload, sizeof(payload) - 1, &written, NULL), "WriteFile failed\n");
    ok(written == sizeof(payload) - 1, "WriteFile wrote %lu bytes\n", written);

    sz = GetFileSize(hFile, NULL);
    ok(sz == sizeof(payload) - 1, "GetFileSize returned %lu\n", sz);

    ok(SetFilePointer(hFile, 0, NULL, FILE_BEGIN) == 0, "SetFilePointer failed\n");
    ok(ReadFile(hFile, read_buf, sizeof(payload) - 1, &read_bytes, NULL), "ReadFile failed\n");
    ok(read_bytes == sizeof(payload) - 1, "ReadFile read %lu bytes\n", read_bytes);
    ok(!memcmp(read_buf, payload, sizeof(payload) - 1), "ReadFile content mismatch: %s\n", read_buf);
    ok(CloseHandle(hFile), "CloseHandle failed\n");
}

static volatile LONG shared_atomic_counter = 0;

static DWORD WINAPI worker_proc(LPVOID param)
{
    int loops = (int)(UINT_PTR)param;
    int i;
    for (i = 0; i < loops; i++)
        InterlockedExchangeAdd(&shared_atomic_counter, 3);
    return 0x77;
}

static void test_cooperative_threads_and_atomics(void)
{
    HANDLE threads[3];
    DWORD tid = 0, exit_code = 0, wait_rc;
    int i;

    shared_atomic_counter = 0;
    for (i = 0; i < 3; i++)
    {
        threads[i] = CreateThread(NULL, 0, worker_proc, (LPVOID)(UINT_PTR)25, 0, &tid);
        ok(threads[i] != NULL, "CreateThread %d failed\n", i);
    }

    wait_rc = WaitForMultipleObjects(3, threads, TRUE, 5000);
    ok(wait_rc == WAIT_OBJECT_0, "WaitForMultipleObjects returned %lu\n", wait_rc);
    ok(shared_atomic_counter == 3 * 25 * 3, "Atomic counter mismatch: got %ld expected %d\n",
       shared_atomic_counter, 3 * 25 * 3);

    for (i = 0; i < 3; i++)
    {
        ok(GetExitCodeThread(threads[i], &exit_code) && exit_code == 0x77,
           "Unexpected thread exit code %#lx\n", exit_code);
        CloseHandle(threads[i]);
    }
}

static void test_d3d12_swapchain_present(void)
{
    IDXGIFactory4 *factory = NULL;
    ID3D12Device *device = NULL;
    ID3D12CommandQueue *queue = NULL;
    IDXGISwapChain1 *sc1 = NULL;
    IDXGISwapChain3 *sc3 = NULL;
    D3D12_COMMAND_QUEUE_DESC qdesc = { 0 };
    DXGI_SWAP_CHAIN_DESC1 sc_desc = { 0 };
    HWND hwnd;
    HRESULT hr;

    hwnd = CreateWindowExA(0, "STATIC", "PortholeX64D3D12", WS_POPUP, 0, 0, 320, 180, NULL, NULL, NULL, NULL);
    ok(hwnd != NULL, "CreateWindowExA failed\n");

    hr = CreateDXGIFactory2(0, &IID_IDXGIFactory4, (void **)&factory);
    ok(hr == S_OK && factory != NULL, "CreateDXGIFactory2 failed: %#lx\n", hr);

    hr = D3D12CreateDevice(NULL, D3D_FEATURE_LEVEL_11_0, &IID_ID3D12Device, (void **)&device);
    ok(hr == S_OK && device != NULL, "D3D12CreateDevice failed: %#lx\n", hr);

    qdesc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    hr = ID3D12Device_CreateCommandQueue(device, &qdesc, &IID_ID3D12CommandQueue, (void **)&queue);
    ok(hr == S_OK && queue != NULL, "CreateCommandQueue failed: %#lx\n", hr);

    sc_desc.Width = 320;
    sc_desc.Height = 180;
    sc_desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sc_desc.SampleDesc.Count = 1;
    sc_desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sc_desc.BufferCount = 2;
    sc_desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;

    hr = IDXGIFactory4_CreateSwapChainForHwnd(factory, (IUnknown *)queue, hwnd, &sc_desc, NULL, NULL, &sc1);
    ok(hr == S_OK && sc1 != NULL, "CreateSwapChainForHwnd failed: %#lx\n", hr);

    hr = IDXGISwapChain1_QueryInterface(sc1, &IID_IDXGISwapChain3, (void **)&sc3);
    ok(hr == S_OK && sc3 != NULL, "QueryInterface IDXGISwapChain3 failed: %#lx\n", hr);

    hr = IDXGISwapChain3_Present(sc3, 0, 0);
    ok(hr == S_OK, "Present 1 failed: %#lx\n", hr);
    hr = IDXGISwapChain3_Present(sc3, 0, 0);
    ok(hr == S_OK, "Present 2 failed: %#lx\n", hr);

    IDXGISwapChain3_Release(sc3);
    IDXGISwapChain1_Release(sc1);
    ID3D12CommandQueue_Release(queue);
    ID3D12Device_Release(device);
    IDXGIFactory4_Release(factory);
    DestroyWindow(hwnd);
}

START_TEST(x64_plan)
{
    test_x64_gpr_and_simd_avx2();
    test_nvme_vmm_16gb_and_lru_paging();
    test_aot_and_self_modifying_jit();
    test_nvme_game_vfs_file_io();
    test_cooperative_threads_and_atomics();
    test_d3d12_swapchain_present();
}
