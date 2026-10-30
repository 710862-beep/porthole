/*
 * Porthole x86-64 :: DOOM-2016-shaped D3D12 startup
 *
 * This is not game code and contains nothing from any game. It is the *sequence* a 2016-era
 * D3D12 title performs in its first second of life, written against documented D3D12/DXGI:
 *
 *   factory -> adapter -> device -> queue -> allocator -> command list -> fence -> RTV heap
 *   -> root signature -> pipeline state -> swap chain -> back buffers -> first frame -> Present
 *
 * Every stage prints its name *before* the call, so a crash log always names the API that was
 * executing. A stage that returns a failure HRESULT prints the four things needed to fix it:
 * the API, the arguments, what a working driver returns, and what we got. The process then exits
 * with the stage number, so `exit:N` in the trace is the exact failure point.
 *
 * Built as PE32+ x86_64 by scripts/build-game-fixtures.mjs (zig cc, x86_64-windows-gnu).
 */
#include <windows.h>
#include <d3d12.h>
#include <dxgi1_4.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * `/blockstage:N` makes the process stop *before* stage N and emit the same one-line failure
 * report a real failure produces. It exists so the report path itself is measured in CI instead of
 * only being exercised when something breaks.
 */
static int g_block_stage = 0;

static void block_stage(int n, const char *api)
{
    printf("STAGE_FAIL n=%d api=%s hr=0x887a0001 last_error=0 "
           "expected=\"S_OK (stage %d completes)\" actual=\"hr=0x887a0001 ptr=NULL\" "
           "fix=\"simulated blocked stage (--blockstage) for failure-report validation\"\n",
           n, api, n);
    fflush(stdout);
    ExitProcess((UINT)n);
}

#define STAGE(n, api)                                    \
    do                                                   \
    {                                                    \
        if (g_block_stage == (n))                        \
            block_stage((n), (api));                     \
        printf("STAGE %d: %s\n", (n), (api));            \
        fflush(stdout);                                  \
    } while (0)

/*
 * One line, four fields, enough to act on without reading any emulator source:
 *
 *   STAGE_FAIL n=13 api=... hr=... last_error=... expected=... actual=... fix=...
 *
 * `expected` is what a working D3D12 driver returns, `actual` is what this run produced, and
 * `fix` names the emulator subsystem that has to grow for the stage to pass.
 */
#define FAIL_EX(n, api, hr, expected, fix)                                      \
    do                                                                          \
    {                                                                           \
        printf("STAGE_FAIL n=%d api=%s hr=0x%08lx last_error=%lu "              \
               "expected=\"%s\" actual=\"hr=0x%08lx ptr=NULL\" fix=\"%s\"\n",     \
               (n), (api), (unsigned long)(hr), (unsigned long)GetLastError(),  \
               (expected), (unsigned long)(hr), (fix));                         \
        fflush(stdout);                                                         \
        ExitProcess((UINT)(n));                                                 \
    } while (0)

/* A minimal, hand-written DXBC container: magic + version + size + zero chunks. It is enough for
 * the HLE to recognise a shader blob; it contains no shader code and belongs to no game. */
static const unsigned char kDummyDxbc[64] = {
    'D', 'X', 'B', 'C',
    0x40, 0x00, 0x00, 0x00,       /* total size */
    0x00, 0x00, 0x00, 0x00,       /* checksum[0] */
    0x01, 0x00, 0x00, 0x00,       /* version */
    0x00, 0x00, 0x00, 0x00,       /* chunk count */
    /* remaining bytes zero */
};

int main(void)
{
    IDXGIFactory4 *factory = NULL;
    IDXGIAdapter1 *adapter = NULL;
    ID3D12Device *device = NULL;
    ID3D12CommandQueue *queue = NULL;
    ID3D12CommandAllocator *allocator = NULL;
    ID3D12GraphicsCommandList *list = NULL;
    ID3D12Fence *fence = NULL;
    ID3D12DescriptorHeap *rtv_heap = NULL;
    ID3D12RootSignature *root_sig = NULL;
    ID3D12PipelineState *pso = NULL;
    ID3D12Resource *backbuffer[2] = { NULL, NULL };
    IDXGISwapChain1 *sc1 = NULL;
    IDXGISwapChain3 *swapchain = NULL;
    D3D12_COMMAND_QUEUE_DESC qdesc;
    D3D12_COMMAND_SIGNATURE_DESC unused;
    D3D12_DESCRIPTOR_HEAP_DESC heap_desc;
    D3D12_ROOT_SIGNATURE_DESC rs_desc;
    D3D12_GRAPHICS_PIPELINE_STATE_DESC pso_desc;
    D3D12_HEAP_PROPERTIES heap_props;
    D3D12_RESOURCE_DESC res_desc;
    D3D12_RESOURCE_BARRIER barrier;
    D3D12_CPU_DESCRIPTOR_HANDLE rtv_handle;
    D3D12_VIEWPORT viewport;
    D3D12_RECT scissor;
    DXGI_SWAP_CHAIN_DESC1 sc_desc;
    ID3DBlob *sig_blob = NULL;
    ID3DBlob *err_blob = NULL;
    D3D12_FEATURE_DATA_ROOT_SIGNATURE rs_version;
    HWND hwnd;
    UINT rtv_stride;
    float clear_color[4] = { 0.05f, 0.06f, 0.09f, 1.0f };
    HRESULT hr;
    int i;

    (void)unused;

    {
        const char *cmd = GetCommandLineA();
        const char *hit = cmd ? strstr(cmd, "/blockstage:") : NULL;
        if (hit)
            g_block_stage = atoi(hit + 12);
    }

    printf("DOOM_STARTUP_BEGIN\n");
    fflush(stdout);

    /* ---------------------------------------------------------------- window ---------- */
    STAGE(1, "CreateWindowExW(game window)");
    hwnd = CreateWindowExW(0, L"PortholeGameWindow", L"PORTHOLE", WS_OVERLAPPEDWINDOW,
                           0, 0, 1280, 720, NULL, NULL, NULL, NULL);
    if (!hwnd)
        FAIL_EX(1, "CreateWindowExW", -1, "hwnd != NULL from CreateWindowExW", "Win32 HLE: CreateWindowExW must allocate a window object");

    /* ---------------------------------------------------------------- dxgi ------------ */
    STAGE(2, "CreateDXGIFactory2(IID_IDXGIFactory4)");
    hr = CreateDXGIFactory2(0, &IID_IDXGIFactory4, (void **)&factory);
    if (FAILED(hr) || !factory)
        FAIL_EX(2, "CreateDXGIFactory2", hr, "S_OK and a non-NULL IDXGIFactory4", "D3D12 HLE: CreateDXGIFactory2 -> create_dxgi_factory");

    STAGE(3, "IDXGIFactory1::EnumAdapters1(0)");
    hr = IDXGIFactory1_EnumAdapters1(factory, 0, &adapter);
    if (FAILED(hr) || !adapter)
        FAIL_EX(3, "IDXGIFactory1::EnumAdapters1", hr, "S_OK and a non-NULL IDXGIAdapter1", "D3D12 HLE: IDXGIFactory1::EnumAdapters1 (slot 12) must answer an adapter object");
    {
        DXGI_ADAPTER_DESC1 desc;
        ZeroMemory(&desc, sizeof(desc));
        hr = IDXGIAdapter1_GetDesc1(adapter, &desc);
        printf("  adapter desc hr=0x%08lx vendor=0x%08x device=0x%08x vram=%llu\n",
               (unsigned long)hr, desc.VendorId, desc.DeviceId,
               (unsigned long long)desc.DedicatedVideoMemory);
        fflush(stdout);
    }

    /* ---------------------------------------------------------------- device ---------- */
    STAGE(4, "D3D12CreateDevice(adapter, FEATURE_LEVEL_12_0)");
    hr = D3D12CreateDevice((IUnknown *)adapter, D3D_FEATURE_LEVEL_12_0, &IID_ID3D12Device,
                           (void **)&device);
    if (FAILED(hr) || !device)
        FAIL_EX(4, "D3D12CreateDevice", hr, "S_OK and a non-NULL ID3D12Device", "D3D12 HLE: D3D12CreateDevice / supports_iid(ID3D12Device)");

    STAGE(5, "ID3D12Device::CheckFeatureSupport(FeatureLevels)");
    {
        D3D_FEATURE_LEVEL levels[4] = { D3D_FEATURE_LEVEL_12_1 };
        D3D12_FEATURE_DATA_FEATURE_LEVELS q;
        ZeroMemory(&q, sizeof(q));
        q.NumFeatureLevels = 1;
        q.pFeatureLevelsRequested = levels;
        hr = ID3D12Device_CheckFeatureSupport(device, D3D12_FEATURE_FEATURE_LEVELS,
                                              &q, sizeof(q));
        printf("  feature level hr=0x%08lx max=0x%04x\n", (unsigned long)hr,
               (unsigned)q.MaxSupportedFeatureLevel);
        fflush(stdout);
    }

    /* ---------------------------------------------------------------- queue ----------- */
    ZeroMemory(&qdesc, sizeof(qdesc));
    qdesc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    qdesc.Priority = D3D12_COMMAND_QUEUE_PRIORITY_NORMAL;
    STAGE(6, "ID3D12Device::CreateCommandQueue");
    hr = ID3D12Device_CreateCommandQueue(device, &qdesc, &IID_ID3D12CommandQueue,
                                         (void **)&queue);
    if (FAILED(hr) || !queue)
        FAIL_EX(6, "ID3D12Device::CreateCommandQueue", hr, "S_OK and a non-NULL ID3D12CommandQueue", "D3D12 HLE: ID3D12Device::CreateCommandQueue (slot 8)");

    STAGE(7, "ID3D12Device::CreateCommandAllocator(DIRECT)");
    hr = ID3D12Device_CreateCommandAllocator(device, D3D12_COMMAND_LIST_TYPE_DIRECT,
                                             &IID_ID3D12CommandAllocator, (void **)&allocator);
    if (FAILED(hr) || !allocator)
        FAIL_EX(7, "ID3D12Device::CreateCommandAllocator", hr, "S_OK and a non-NULL ID3D12CommandAllocator", "D3D12 HLE: ID3D12Device::CreateCommandAllocator (slot 9)");

    STAGE(8, "ID3D12Device::CreateCommandList");
    hr = ID3D12Device_CreateCommandList(device, 0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocator,
                                        NULL, &IID_ID3D12GraphicsCommandList, (void **)&list);
    if (FAILED(hr) || !list)
        FAIL_EX(8, "ID3D12Device::CreateCommandList", hr, "S_OK and a non-NULL ID3D12GraphicsCommandList", "D3D12 HLE: ID3D12Device::CreateCommandList (slot 12)");

    STAGE(9, "ID3D12Device::CreateFence(0, FLAG_NONE)");
    hr = ID3D12Device_CreateFence(device, 0, D3D12_FENCE_FLAG_NONE, &IID_ID3D12Fence,
                                  (void **)&fence);
    if (FAILED(hr) || !fence)
        FAIL_EX(9, "ID3D12Device::CreateFence", hr, "S_OK and a non-NULL ID3D12Fence", "D3D12 HLE: ID3D12Device::CreateFence (slot 36)");

    /* ---------------------------------------------------------------- descriptors ----- */
    ZeroMemory(&heap_desc, sizeof(heap_desc));
    heap_desc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    heap_desc.NumDescriptors = 2;
    STAGE(10, "ID3D12Device::CreateDescriptorHeap(RTV x2)");
    hr = ID3D12Device_CreateDescriptorHeap(device, &heap_desc, &IID_ID3D12DescriptorHeap,
                                           (void **)&rtv_heap);
    if (FAILED(hr) || !rtv_heap)
        FAIL_EX(10, "ID3D12Device::CreateDescriptorHeap", hr, "S_OK and a non-NULL ID3D12DescriptorHeap", "D3D12 HLE: ID3D12Device::CreateDescriptorHeap (slot 14) with real descriptor memory");
    rtv_stride = ID3D12Device_GetDescriptorHandleIncrementSize(device,
                                                               D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    printf("  rtv_stride=%u\n", rtv_stride);
    fflush(stdout);

    /* ---------------------------------------------------------------- root sig -------- */
    STAGE(11, "D3D12SerializeRootSignature + ID3D12Device::CreateRootSignature");
    ZeroMemory(&rs_version, sizeof(rs_version));
    rs_version.HighestVersion = D3D_ROOT_SIGNATURE_VERSION_1_1;
    hr = D3D12SerializeRootSignature(&rs_desc /* zeroed: an empty root signature */,
                                     D3D_ROOT_SIGNATURE_VERSION_1, &sig_blob, &err_blob);
    if (FAILED(hr) || !sig_blob)
        FAIL_EX(11, "D3D12SerializeRootSignature", hr, "S_OK, a non-NULL root signature and a usable DXBC blob", "D3D12 HLE: D3D12SerializeRootSignature must return a real DXBC root signature, not a 16-byte stub");
    hr = ID3D12Device_CreateRootSignature(device, 0, ID3D10Blob_GetBufferPointer(sig_blob),
                                          ID3D10Blob_GetBufferSize(sig_blob),
                                          &IID_ID3D12RootSignature, (void **)&root_sig);
    if (FAILED(hr) || !root_sig)
        FAIL_EX(11, "ID3D12Device::CreateRootSignature", hr, "S_OK, a non-NULL root signature and a usable DXBC blob", "D3D12 HLE: D3D12SerializeRootSignature must return a real DXBC root signature, not a 16-byte stub");
    ID3D10Blob_Release(sig_blob);
    sig_blob = NULL;

    /* ---------------------------------------------------------------- pso ------------ */
    ZeroMemory(&pso_desc, sizeof(pso_desc));
    pso_desc.pRootSignature = root_sig;
    pso_desc.VS.pShaderBytecode = kDummyDxbc;
    pso_desc.VS.BytecodeLength = sizeof(kDummyDxbc);
    pso_desc.PS.pShaderBytecode = kDummyDxbc;
    pso_desc.PS.BytecodeLength = sizeof(kDummyDxbc);
    pso_desc.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    pso_desc.RasterizerState.CullMode = D3D12_CULL_MODE_BACK;
    pso_desc.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    pso_desc.NumRenderTargets = 1;
    pso_desc.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM;
    pso_desc.SampleDesc.Count = 1;
    STAGE(12, "ID3D12Device::CreateGraphicsPipelineState");
    hr = ID3D12Device_CreateGraphicsPipelineState(device, &pso_desc, &IID_ID3D12PipelineState,
                                                  (void **)&pso);
    if (FAILED(hr) || !pso)
        FAIL_EX(12, "ID3D12Device::CreateGraphicsPipelineState", hr, "S_OK and a non-NULL ID3D12PipelineState", "D3D12 HLE: CreateGraphicsPipelineState (slot 10) including DXBC parsing");

    /* ---------------------------------------------------------------- swap chain ----- */
    ZeroMemory(&sc_desc, sizeof(sc_desc));
    sc_desc.Width = 1280;
    sc_desc.Height = 720;
    sc_desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sc_desc.SampleDesc.Count = 1;
    sc_desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sc_desc.BufferCount = 2;
    sc_desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    sc_desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
    STAGE(13, "IDXGIFactory4::CreateSwapChainForHwnd");
    hr = IDXGIFactory4_CreateSwapChainForHwnd(factory, (IUnknown *)queue, hwnd, &sc_desc, NULL,
                                              NULL, &sc1);
    if (FAILED(hr) || !sc1)
        FAIL_EX(13, "IDXGIFactory4::CreateSwapChainForHwnd", hr, "S_OK and a non-NULL IDXGISwapChain1", "D3D12 HLE: IDXGIFactory4::CreateSwapChainForHwnd (slot 15)");

    STAGE(14, "IDXGISwapChain1::QueryInterface(IID_IDXGISwapChain3)");
    hr = IDXGISwapChain1_QueryInterface(sc1, &IID_IDXGISwapChain3, (void **)&swapchain);
    if (FAILED(hr) || !swapchain)
        FAIL_EX(14, "IDXGISwapChain1::QueryInterface(IDXGISwapChain3)", hr, "S_OK and a non-NULL IDXGISwapChain3", "D3D12 HLE: QueryInterface must accept IID_IDXGISwapChain3");

    /* ---------------------------------------------------------------- back buffers --- */
    for (i = 0; i < 2; i++)
    {
        STAGE(15, "IDXGISwapChain::GetBuffer(backbuffer)");
        hr = IDXGISwapChain3_GetBuffer(swapchain, (UINT)i, &IID_ID3D12Resource,
                                       (void **)&backbuffer[i]);
        if (FAILED(hr) || !backbuffer[i])
            FAIL_EX(15, "IDXGISwapChain::GetBuffer", hr, "S_OK and a non-NULL ID3D12Resource back buffer", "D3D12 HLE: IDXGISwapChain::GetBuffer (slot 9) with real backing surfaces");

        STAGE(16, "ID3D12Device::CreateRenderTargetView");
        rtv_handle = ID3D12DescriptorHeap_GetCPUDescriptorHandleForHeapStart(rtv_heap);
        rtv_handle.ptr += (SIZE_T)i * rtv_stride;
        ID3D12Device_CreateRenderTargetView(device, backbuffer[i], NULL, rtv_handle);
    }

    /* ---------------------------------------------------------------- first frame ----- */
    STAGE(17, "ID3D12GraphicsCommandList::ResourceBarrier(PRESENT->RENDER_TARGET)");
    ZeroMemory(&barrier, sizeof(barrier));
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = backbuffer[0];
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &barrier);

    STAGE(18, "ID3D12GraphicsCommandList::OMSetRenderTargets");
    rtv_handle = ID3D12DescriptorHeap_GetCPUDescriptorHandleForHeapStart(rtv_heap);
    ID3D12GraphicsCommandList_OMSetRenderTargets(list, 1, &rtv_handle, FALSE, NULL);

    STAGE(19, "ID3D12GraphicsCommandList::RSSetViewports + RSSetScissorRects");
    ZeroMemory(&viewport, sizeof(viewport));
    viewport.Width = 1280.0f;
    viewport.Height = 720.0f;
    viewport.MaxDepth = 1.0f;
    ID3D12GraphicsCommandList_RSSetViewports(list, 1, &viewport);
    scissor.left = 0;
    scissor.top = 0;
    scissor.right = 1280;
    scissor.bottom = 720;
    ID3D12GraphicsCommandList_RSSetScissorRects(list, 1, &scissor);

    STAGE(20, "ID3D12GraphicsCommandList::ClearRenderTargetView");
    ID3D12GraphicsCommandList_ClearRenderTargetView(list, rtv_handle, clear_color, 0, NULL);

    STAGE(21, "ID3D12GraphicsCommandList::SetGraphicsRootSignature + SetPipelineState");
    ID3D12GraphicsCommandList_SetGraphicsRootSignature(list, root_sig);
    ID3D12GraphicsCommandList_SetPipelineState(list, pso);

    STAGE(22, "ID3D12GraphicsCommandList::DrawInstanced(3,1,0,0)");
    ID3D12GraphicsCommandList_DrawInstanced(list, 3, 1, 0, 0);

    STAGE(23, "ID3D12GraphicsCommandList::ResourceBarrier(RENDER_TARGET->PRESENT) + Close");
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
    ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &barrier);
    ID3D12GraphicsCommandList_Close(list);

    STAGE(24, "ID3D12CommandQueue::ExecuteCommandLists");
    ID3D12CommandQueue_ExecuteCommandLists(queue, 1, (ID3D12CommandList *const *)&list);

    STAGE(25, "IDXGISwapChain::Present(1, 0)");
    hr = IDXGISwapChain3_Present(swapchain, 1, 0);
    if (FAILED(hr))
        FAIL_EX(25, "IDXGISwapChain::Present", hr, "S_OK from Present(1, 0)", "D3D12 HLE: IDXGISwapChain::Present (slot 8) must produce a frame");

    printf("DOOM_STARTUP_FRAME_PRESENTED\n");
    printf("DOOM_STARTUP_BACKBUFFER_INDEX %u\n",
           (unsigned)IDXGISwapChain3_GetCurrentBackBufferIndex(swapchain));
    printf("DOOM_STARTUP_OK stages=25\n");
    fflush(stdout);
    ExitProcess(0);
    return 0;
}
