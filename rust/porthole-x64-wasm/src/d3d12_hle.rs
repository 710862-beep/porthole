use std::collections::HashMap;

use crate::vmm::{
    VirtualMemoryManager, MEM_COMMIT, MEM_PRIVATE, PAGE_EXECUTE_READWRITE, PAGE_READWRITE,
};

pub const COM_HEAP_BASE: u64 = 0x0000_7FF4_0000_0000;
/// COM vtable stubs live in their own VA range.
///
/// They used to be allocated from `THUNK_BASE + 0x1000`, i.e. the *same* address the Win32 import
/// thunk pool starts at. The two pools therefore handed out identical addresses, the import
/// registration overwrote the COM slot map, and a real guest call such as
/// `factory->lpVtbl->EnumAdapters1` silently landed on `kernel32!VirtualProtect` - it returned 1,
/// the guest saw "S_OK, adapter == NULL", and the failure looked like a missing D3D12 feature
/// instead of an address-space collision. One VA range per pool, always.
pub const COM_THUNK_BASE: u64 = 0x0000_7FF1_0000_0000;
pub const COM_THUNK_REGION_SIZE: u64 = 0x0001_0000; // 65536 bytes = 4096 thunk slots
pub const COM_HEAP_SIZE: u64 = 0x0020_0000; // 2 MB for COM objects + vtables
pub const GPU_BUFFER_VA_BASE: u64 = 0x0000_0002_0000_0000; // 8 GB+ for mapped D3D12 resources

pub const S_OK: u32 = 0x0000_0000;
pub const DXGI_STATUS_OCCLUDED: u32 = 0x087A_0001;
pub const E_NOINTERFACE: u32 = 0x8000_4002;
pub const E_POINTER: u32 = 0x8000_4003;
pub const E_NOTIMPL: u32 = 0x8000_4001;
pub const E_FAIL: u32 = 0x8000_4005;
pub const E_ACCESSDENIED: u32 = 0x8007_0005;
pub const E_INVALIDARG: u32 = 0x8007_0057;
pub const DXGI_ERROR_INVALID_CALL: u32 = 0x887A_0001;
pub const DXGI_ERROR_NOT_FOUND: u32 = 0x887A_0002;

pub const DXGI_FORMAT_R10G10B10A2_UNORM: u32 = 24;
pub const DXGI_FORMAT_R8G8B8A8_UNORM: u32 = 28;
pub const DXGI_FORMAT_B8G8R8A8_UNORM: u32 = 87;

pub const DESKTOP_HWND: u64 = 0x0000_0000_0001_0010;

const ADAPTER_LUID_LOW: u32 = 0x504F_5254; // "PORT"
const ADAPTER_LUID_HIGH: u32 = 0x0000_0064;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ComKind {
    DxgiFactory,
    DxgiAdapter,
    DxgiOutput,
    DxgiSwapChain,
    D3dBlob,
    D3d12Device,
    D3d12CommandQueue,
    D3d12CommandAllocator,
    D3d12CommandList,
    D3d12DescriptorHeap,
    D3d12RootSignature,
    D3d12PipelineState,
    D3d12Resource,
    D3d12Fence,
}

#[derive(Debug, Clone)]
pub enum PsColorSource {
    Constant([f32; 4]),
    RootConstants { slot: usize },
}

#[derive(Debug, Clone)]
pub enum GpuCommand {
    ClearRtv {
        rtv_ptr: u64,
        color: [f32; 4],
    },
    SetPipelineState {
        pso_ptr: u64,
    },
    SetRoot32BitConstants {
        root_index: u32,
        num_values: u32,
        dest_offset: u32,
        values: Vec<u32>,
    },
    SetRenderTargets {
        rtv_ptrs: Vec<u64>,
    },
    SetViewport {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
    },
    SetScissor {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    },
    DrawInstanced {
        vertex_count: u32,
        instance_count: u32,
    },
    CopyTextureRegion {
        dst_res: u64,
        dst_type: u32,
        dst_offset: u64,
        dst_row_pitch: u32,
        dst_width: u32,
        dst_height: u32,
        src_res: u64,
        src_type: u32,
        src_offset: u64,
        src_row_pitch: u32,
    },
    CopyBufferRegion {
        dst_res: u64,
        dst_offset: u64,
        src_res: u64,
        src_offset: u64,
        num_bytes: u64,
    },
    CopyResource {
        dst_res: u64,
        src_res: u64,
    },
}


/// Human-readable name of a COM vtable slot, so a crash log can say
/// `IDXGIFactory4::CreateSwapChainForHwnd` instead of `slot 15`.
///
/// Slot numbers follow the real interface layouts: IUnknown occupies 0..=2, then each interface
/// level appends its own methods (IDXGIObject, IDXGIFactory, IDXGIFactory1, ... / ID3D12Object,
/// ID3D12DeviceChild, ...). Only the slots this HLE implements or is asked about are spelled out;
/// anything else reports `UnknownMethod` so a missing entry is visible rather than guessed.
pub fn method_name(kind: ComKind, slot: usize) -> &'static str {
    match slot {
        0 => return "QueryInterface",
        1 => return "AddRef",
        2 => return "Release",
        _ => {}
    }
    match (kind, slot) {
        (ComKind::DxgiFactory, 3) => "SetPrivateData",
        (ComKind::DxgiFactory, 4) => "SetPrivateDataInterface",
        (ComKind::DxgiFactory, 5) => "GetPrivateData",
        (ComKind::DxgiFactory, 6) => "GetParent",
        (ComKind::DxgiFactory, 7) => "EnumAdapters",
        (ComKind::DxgiFactory, 8) => "MakeWindowAssociation",
        (ComKind::DxgiFactory, 9) => "GetWindowAssociation",
        (ComKind::DxgiFactory, 10) => "CreateSwapChain",
        (ComKind::DxgiFactory, 11) => "CreateSoftwareAdapter",
        (ComKind::DxgiFactory, 12) => "EnumAdapters1",
        (ComKind::DxgiFactory, 13) => "IsCurrent",
        (ComKind::DxgiFactory, 14) => "IsWindowedStereoEnabled",
        (ComKind::DxgiFactory, 15) => "CreateSwapChainForHwnd",
        (ComKind::DxgiFactory, 16) => "CreateSwapChainForCoreWindow",
        (ComKind::DxgiFactory, 17) => "GetSharedResourceAdapterLuid",
        (ComKind::DxgiFactory, 24) => "CreateSwapChainForComposition",
        (ComKind::DxgiFactory, 25) => "GetCreationFlags",
        (ComKind::DxgiFactory, 26) => "EnumAdapterByLuid",
        (ComKind::DxgiFactory, 27) => "EnumWarpAdapter",

        (ComKind::DxgiAdapter, 7) => "EnumOutputs",
        (ComKind::DxgiAdapter, 8) => "GetDesc",
        (ComKind::DxgiAdapter, 9) => "CheckInterfaceSupport",
        (ComKind::DxgiAdapter, 10) => "GetDesc1",
        (ComKind::DxgiAdapter, 11) => "GetDesc2",

        (ComKind::DxgiOutput, 7) => "GetDesc",
        (ComKind::DxgiOutput, 8) => "GetDisplayModeList",
        (ComKind::DxgiOutput, 9) => "FindClosestMatchingMode",
        (ComKind::DxgiOutput, 10) => "WaitForVBlank",
        (ComKind::DxgiOutput, 18) => "GetFrameStatistics",

        (ComKind::DxgiSwapChain, 3) => "SetPrivateData",
        (ComKind::DxgiSwapChain, 4) => "SetPrivateDataInterface",
        (ComKind::DxgiSwapChain, 5) => "GetPrivateData",
        (ComKind::DxgiSwapChain, 6) => "GetParent",
        (ComKind::DxgiSwapChain, 7) => "GetDevice",
        (ComKind::DxgiSwapChain, 8) => "Present",
        (ComKind::DxgiSwapChain, 9) => "GetBuffer",
        (ComKind::DxgiSwapChain, 10) => "SetFullscreenState",
        (ComKind::DxgiSwapChain, 11) => "GetFullscreenState",
        (ComKind::DxgiSwapChain, 12) => "GetDesc",
        (ComKind::DxgiSwapChain, 13) => "ResizeBuffers",
        (ComKind::DxgiSwapChain, 14) => "ResizeTarget",
        (ComKind::DxgiSwapChain, 15) => "GetContainingOutput",
        (ComKind::DxgiSwapChain, 16) => "GetFrameStatistics",
        (ComKind::DxgiSwapChain, 17) => "GetLastPresentCount",
        (ComKind::DxgiSwapChain, 18) => "GetDesc1",
        (ComKind::DxgiSwapChain, 20) => "GetHwnd",
        (ComKind::DxgiSwapChain, 22) => "Present1",
        (ComKind::DxgiSwapChain, 25) => "SetBackgroundColor",
        (ComKind::DxgiSwapChain, 26) => "GetBackgroundColor",
        (ComKind::DxgiSwapChain, 27) => "SetRotation",
        (ComKind::DxgiSwapChain, 28) => "GetRotation",
        (ComKind::DxgiSwapChain, 29) => "SetSourceSize",
        (ComKind::DxgiSwapChain, 30) => "GetSourceSize",
        (ComKind::DxgiSwapChain, 31) => "SetMaximumFrameLatency",
        (ComKind::DxgiSwapChain, 32) => "GetMaximumFrameLatency",
        (ComKind::DxgiSwapChain, 33) => "GetFrameLatencyWaitableObject",
        (ComKind::DxgiSwapChain, 36) => "GetCurrentBackBufferIndex",
        (ComKind::DxgiSwapChain, 37) => "CheckColorSpaceSupport",
        (ComKind::DxgiSwapChain, 38) => "SetColorSpace1",
        (ComKind::DxgiSwapChain, 39) => "ResizeBuffers1",

        (ComKind::D3dBlob, 3) => "GetBufferPointer",
        (ComKind::D3dBlob, 4) => "GetBufferSize",

        // ---- D3D12 ------------------------------------------------------------------------
        // Layout note: ID3D12Object has FOUR methods (GetPrivateData is slot 3 - unlike DXGI's
        // IDXGIObject, which starts with SetPrivateData), so GetNodeCount is 7 and every
        // ID3D12Device method sits one slot higher than a naive IUnknown+3 count suggests.
        (ComKind::D3d12Device, 3) => "GetPrivateData",
        (ComKind::D3d12Device, 4) => "SetPrivateData",
        (ComKind::D3d12Device, 5) => "SetPrivateDataInterface",
        (ComKind::D3d12Device, 6) => "SetName",
        (ComKind::D3d12Device, 7) => "GetNodeCount",
        (ComKind::D3d12Device, 8) => "CreateCommandQueue",
        (ComKind::D3d12Device, 9) => "CreateCommandAllocator",
        (ComKind::D3d12Device, 10) => "CreateGraphicsPipelineState",
        (ComKind::D3d12Device, 11) => "CreateComputePipelineState",
        (ComKind::D3d12Device, 12) => "CreateCommandList",
        (ComKind::D3d12Device, 13) => "CheckFeatureSupport",
        (ComKind::D3d12Device, 14) => "CreateDescriptorHeap",
        (ComKind::D3d12Device, 15) => "GetDescriptorHandleIncrementSize",
        (ComKind::D3d12Device, 16) => "CreateRootSignature",
        (ComKind::D3d12Device, 17) => "CreateConstantBufferView",
        (ComKind::D3d12Device, 18) => "CreateShaderResourceView",
        (ComKind::D3d12Device, 19) => "CreateUnorderedAccessView",
        (ComKind::D3d12Device, 20) => "CreateRenderTargetView",
        (ComKind::D3d12Device, 21) => "CreateDepthStencilView",
        (ComKind::D3d12Device, 22) => "CreateSampler",
        (ComKind::D3d12Device, 23) => "CopyDescriptors",
        (ComKind::D3d12Device, 24) => "CopyDescriptorsSimple",
        (ComKind::D3d12Device, 25) => "GetResourceAllocationInfo",
        (ComKind::D3d12Device, 26) => "GetCustomHeapProperties",
        (ComKind::D3d12Device, 27) => "CreateCommittedResource",
        (ComKind::D3d12Device, 28) => "CreateHeap",
        (ComKind::D3d12Device, 29) => "CreatePlacedResource",
        (ComKind::D3d12Device, 30) => "CreateReservedResource",
        (ComKind::D3d12Device, 31) => "CreateSharedHandle",
        (ComKind::D3d12Device, 32) => "OpenSharedHandle",
        (ComKind::D3d12Device, 33) => "OpenSharedHandleByName",
        (ComKind::D3d12Device, 34) => "MakeResident",
        (ComKind::D3d12Device, 35) => "Evict",
        (ComKind::D3d12Device, 36) => "CreateFence",
        (ComKind::D3d12Device, 37) => "GetDeviceRemovedReason",
        (ComKind::D3d12Device, 38) => "GetCopyableFootprints",
        (ComKind::D3d12Device, 39) => "CreateQueryHeap",
        (ComKind::D3d12Device, 40) => "SetStablePowerState",
        (ComKind::D3d12Device, 41) => "CreateCommandSignature",
        (ComKind::D3d12Device, 42) => "GetResourceTiling",
        (ComKind::D3d12Device, 43) => "GetAdapterLuid",

        (ComKind::D3d12CommandQueue, 7) => "GetDevice",
        (ComKind::D3d12CommandQueue, 8) => "UpdateTileMappings",
        (ComKind::D3d12CommandQueue, 9) => "CopyTileMappings",
        (ComKind::D3d12CommandQueue, 10) => "ExecuteCommandLists",
        (ComKind::D3d12CommandQueue, 11) => "SetMarker",
        (ComKind::D3d12CommandQueue, 12) => "BeginEvent",
        (ComKind::D3d12CommandQueue, 13) => "EndEvent",
        (ComKind::D3d12CommandQueue, 14) => "Signal",
        (ComKind::D3d12CommandQueue, 15) => "Wait",
        (ComKind::D3d12CommandQueue, 16) => "GetTimestampFrequency",
        (ComKind::D3d12CommandQueue, 17) => "GetClockCalibration",
        (ComKind::D3d12CommandQueue, 18) => "GetDesc",

        (ComKind::D3d12CommandAllocator, 7) => "GetDevice",
        (ComKind::D3d12CommandAllocator, 8) => "Reset",

        (ComKind::D3d12CommandList, 3) => "GetPrivateData",
        (ComKind::D3d12CommandList, 4) => "SetPrivateData",
        (ComKind::D3d12CommandList, 5) => "SetPrivateDataInterface",
        (ComKind::D3d12CommandList, 6) => "SetName",
        (ComKind::D3d12CommandList, 7) => "GetDevice",
        (ComKind::D3d12CommandList, 8) => "GetType",
        (ComKind::D3d12CommandList, 9) => "Close",
        (ComKind::D3d12CommandList, 10) => "Reset",
        (ComKind::D3d12CommandList, 11) => "ClearState",
        (ComKind::D3d12CommandList, 12) => "DrawInstanced",
        (ComKind::D3d12CommandList, 13) => "DrawIndexedInstanced",
        (ComKind::D3d12CommandList, 14) => "Dispatch",
        (ComKind::D3d12CommandList, 15) => "CopyBufferRegion",
        (ComKind::D3d12CommandList, 16) => "CopyTextureRegion",
        (ComKind::D3d12CommandList, 17) => "CopyResource",
        (ComKind::D3d12CommandList, 18) => "CopyTiles",
        (ComKind::D3d12CommandList, 19) => "ResolveSubresource",
        (ComKind::D3d12CommandList, 20) => "IASetPrimitiveTopology",
        (ComKind::D3d12CommandList, 21) => "RSSetViewports",
        (ComKind::D3d12CommandList, 22) => "RSSetScissorRects",
        (ComKind::D3d12CommandList, 23) => "OMSetBlendFactor",
        (ComKind::D3d12CommandList, 24) => "OMSetStencilRef",
        (ComKind::D3d12CommandList, 25) => "SetPipelineState",
        (ComKind::D3d12CommandList, 26) => "ResourceBarrier",
        (ComKind::D3d12CommandList, 27) => "ExecuteBundle",
        (ComKind::D3d12CommandList, 28) => "SetDescriptorHeaps",
        (ComKind::D3d12CommandList, 29) => "SetComputeRootSignature",
        (ComKind::D3d12CommandList, 30) => "SetGraphicsRootSignature",
        (ComKind::D3d12CommandList, 31) => "SetComputeRootDescriptorTable",
        (ComKind::D3d12CommandList, 32) => "SetGraphicsRootDescriptorTable",
        (ComKind::D3d12CommandList, 33) => "SetComputeRoot32BitConstant",
        (ComKind::D3d12CommandList, 34) => "SetGraphicsRoot32BitConstant",
        (ComKind::D3d12CommandList, 35) => "SetComputeRoot32BitConstants",
        (ComKind::D3d12CommandList, 36) => "SetGraphicsRoot32BitConstants",
        (ComKind::D3d12CommandList, 37) => "SetComputeRootConstantBufferView",
        (ComKind::D3d12CommandList, 38) => "SetGraphicsRootConstantBufferView",
        (ComKind::D3d12CommandList, 39) => "SetComputeRootShaderResourceView",
        (ComKind::D3d12CommandList, 40) => "SetGraphicsRootShaderResourceView",
        (ComKind::D3d12CommandList, 41) => "SetComputeRootUnorderedAccessView",
        (ComKind::D3d12CommandList, 42) => "SetGraphicsRootUnorderedAccessView",
        (ComKind::D3d12CommandList, 43) => "IASetIndexBuffer",
        (ComKind::D3d12CommandList, 44) => "IASetVertexBuffers",
        (ComKind::D3d12CommandList, 45) => "SOSetTargets",
        (ComKind::D3d12CommandList, 46) => "OMSetRenderTargets",
        (ComKind::D3d12CommandList, 47) => "ClearDepthStencilView",
        (ComKind::D3d12CommandList, 48) => "ClearRenderTargetView",
        (ComKind::D3d12CommandList, 49) => "ClearUnorderedAccessViewUint",
        (ComKind::D3d12CommandList, 50) => "ClearUnorderedAccessViewFloat",
        (ComKind::D3d12CommandList, 51) => "DiscardResource",
        (ComKind::D3d12CommandList, 52) => "BeginQuery",
        (ComKind::D3d12CommandList, 53) => "EndQuery",
        (ComKind::D3d12CommandList, 54) => "ResolveQueryData",
        (ComKind::D3d12CommandList, 55) => "SetPredication",
        (ComKind::D3d12CommandList, 56) => "SetMarker",
        (ComKind::D3d12CommandList, 57) => "BeginEvent",
        (ComKind::D3d12CommandList, 58) => "EndEvent",
        (ComKind::D3d12CommandList, 59) => "ExecuteIndirect",

        (ComKind::D3d12DescriptorHeap, 7) => "GetDevice",
        (ComKind::D3d12DescriptorHeap, 8) => "GetDesc",
        (ComKind::D3d12DescriptorHeap, 9) => "GetCPUDescriptorHandleForHeapStart",
        (ComKind::D3d12DescriptorHeap, 10) => "GetGPUDescriptorHandleForHeapStart",

        (ComKind::D3d12RootSignature, 6) => "SetName",
        (ComKind::D3d12PipelineState, 6) => "SetName",

        (ComKind::D3d12Resource, 3) => "GetPrivateData",
        (ComKind::D3d12Resource, 4) => "SetPrivateData",
        (ComKind::D3d12Resource, 5) => "SetPrivateDataInterface",
        (ComKind::D3d12Resource, 6) => "SetName",
        (ComKind::D3d12Resource, 7) => "GetDevice",
        (ComKind::D3d12Resource, 8) => "GetDesc",
        (ComKind::D3d12Resource, 9) => "Map",
        (ComKind::D3d12Resource, 10) => "Unmap",
        (ComKind::D3d12Resource, 11) => "WriteToSubresource",
        (ComKind::D3d12Resource, 12) => "ReadFromSubresource",
        (ComKind::D3d12Resource, 13) => "GetHeapProperties",

        (ComKind::D3d12Fence, 7) => "GetDevice",
        (ComKind::D3d12Fence, 8) => "GetCompletedValue",
        (ComKind::D3d12Fence, 9) => "SetEventOnCompletion",
        (ComKind::D3d12Fence, 10) => "Signal",

        _ => "UnknownMethod",
    }
}

/// Interface family name used in trace lines and histogram keys.
pub fn interface_name(kind: ComKind) -> &'static str {
    match kind {
        ComKind::DxgiFactory => "IDXGIFactory4",
        ComKind::DxgiAdapter => "IDXGIAdapter1",
        ComKind::DxgiOutput => "IDXGIOutput",
        ComKind::DxgiSwapChain => "IDXGISwapChain3",
        ComKind::D3dBlob => "ID3D10Blob",
        ComKind::D3d12Device => "ID3D12Device",
        ComKind::D3d12CommandQueue => "ID3D12CommandQueue",
        ComKind::D3d12CommandAllocator => "ID3D12CommandAllocator",
        ComKind::D3d12CommandList => "ID3D12GraphicsCommandList",
        ComKind::D3d12DescriptorHeap => "ID3D12DescriptorHeap",
        ComKind::D3d12RootSignature => "ID3D12RootSignature",
        ComKind::D3d12PipelineState => "ID3D12PipelineState",
        ComKind::D3d12Resource => "ID3D12Resource",
        ComKind::D3d12Fence => "ID3D12Fence",
    }
}

#[derive(Debug, Clone)]
pub struct ResourceData {
    pub dimension: u32, // 1 = BUFFER, 3 = TEXTURE2D
    pub width: u64,
    pub height: u32,
    pub depth_or_array: u16,
    pub mip_levels: u16,
    pub format: u32,
    pub flags: u32,
    pub heap_type: u32,
    pub guest_va: u64, // Non-zero for BUFFER resources mapped in VMM
    pub byte_size: usize,
    pub texels_u32: Vec<u32>, // Packed 32-bit texels for TEXTURE2D resources
    pub swapchain_owner: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct SwapChainData {
    pub hwnd: u64,
    pub width: u32,
    pub height: u32,
    pub format: u32,
    pub buffer_count: u32,
    pub current_index: u32,
    pub buffers: Vec<u64>,
    pub device_or_queue: u64,
}

#[derive(Debug, Clone)]
pub struct ComObject {
    pub ptr: u64,
    pub kind: ComKind,
    pub refcount: u32,
    pub parent_device: u64,
    // Kind-specific payloads
    pub blob_va: u64,
    pub blob_size: usize,
    pub queue_type: u32,
    pub cmd_list_type: u32,
    pub cmd_list_open: bool,
    pub recorded_cmds: Vec<GpuCommand>,
    pub heap_type: u32,
    pub heap_num_desc: u32,
    pub heap_cpu_start: u64,
    pub heap_gpu_start: u64,
    pub pso_ps_source: PsColorSource,
    pub pso_rtv_format: u32,
    pub fence_value: u64,
    pub resource: Option<ResourceData>,
    pub swapchain: Option<SwapChainData>,
}

pub struct D3d12Subsystem {
    vtables: HashMap<ComKind, u64>,
    method_map: HashMap<u64, (ComKind, usize)>,
    pub objects: HashMap<u64, ComObject>,
    rtv_bindings: HashMap<u64, (u64, u32)>, // cpu_descriptor_ptr -> (resource_ptr, format)
    next_com_alloc: u64,
    next_desc_ptr: u64,
    next_gpu_va: u64,
    /// Diagnostics: COM calls (`ID3D12Device::CreateCommandQueue=3`), methods that fell through
    /// to the default arm, and free-form notes drained by the driver into its trace.
    pub com_calls: HashMap<String, u64>,
    pub com_unimplemented: Vec<String>,
    pub notes: Vec<String>,
    pub frames_presented: u64,
    pub last_frame_width: u32,
    pub last_frame_height: u32,
    pub last_frame_rgba: Vec<u8>,
    pub frame_dirty: bool,
}

impl D3d12Subsystem {
    pub fn new() -> Self {
        Self {
            vtables: HashMap::new(),
            method_map: HashMap::new(),
            objects: HashMap::new(),
            rtv_bindings: HashMap::new(),
            next_com_alloc: COM_HEAP_BASE,
            next_desc_ptr: 0x0000_7FF5_0000_0000,
            next_gpu_va: GPU_BUFFER_VA_BASE,
            com_calls: HashMap::new(),
            com_unimplemented: Vec::new(),
            notes: Vec::new(),
            frames_presented: 0,
            last_frame_width: 0,
            last_frame_height: 0,
            last_frame_rgba: Vec::new(),
            frame_dirty: false,
        }
    }

    pub fn init_memory(&mut self, vmm: &mut VirtualMemoryManager) {
        vmm.map_region(
            COM_HEAP_BASE,
            COM_HEAP_SIZE,
            PAGE_READWRITE,
            MEM_COMMIT,
            MEM_PRIVATE,
            true,
        );
        vmm.map_region(
            COM_THUNK_BASE,
            COM_THUNK_REGION_SIZE,
            PAGE_EXECUTE_READWRITE,
            MEM_COMMIT,
            MEM_PRIVATE,
            true,
        );
        let mut next_thunk = COM_THUNK_BASE;

        let specs: &[(ComKind, usize)] = &[
            (ComKind::DxgiFactory, 28),
            (ComKind::DxgiAdapter, 16),
            (ComKind::DxgiOutput, 24),
            (ComKind::DxgiSwapChain, 40),
            (ComKind::D3dBlob, 5),
            (ComKind::D3d12Device, 44),
            (ComKind::D3d12CommandQueue, 19),
            (ComKind::D3d12CommandAllocator, 9),
            (ComKind::D3d12CommandList, 60),
            (ComKind::D3d12DescriptorHeap, 11),
            (ComKind::D3d12RootSignature, 8),
            (ComKind::D3d12PipelineState, 9),
            (ComKind::D3d12Resource, 15),
            (ComKind::D3d12Fence, 11),
        ];

        for &(kind, slot_count) in specs {
            let vtbl_va = self.alloc_com_space((slot_count * 8) as u64);
            for slot in 0..slot_count {
                let thunk_va = next_thunk;
                next_thunk += 8;
                let _ = vmm.write_u64(vtbl_va + (slot as u64) * 8, thunk_va);
                self.method_map.insert(thunk_va, (kind, slot));
            }
            self.vtables.insert(kind, vtbl_va);
        }
    }

    /// Records a COM call in the histogram and (for the trace) as a note.
    fn record_com(&mut self, kind: ComKind, slot: usize, args: &[u64; 10], result: u64) {
        let key = format!("{}::{}", interface_name(kind), method_name(kind, slot));
        *self.com_calls.entry(key.clone()).or_insert(0) += 1;
        if result == E_NOTIMPL as u64 {
            if self.com_unimplemented.len() < 256 && !self.com_unimplemented.contains(&key) {
                self.com_unimplemented.push(key.clone());
            }
        }
        if self.notes.len() < 200_000 {
            self.notes.push(format!(
                "K COM {key} this=0x{:x} args=[0x{:x},0x{:x},0x{:x},0x{:x},0x{:x}] -> 0x{result:08x}",
                args[0], args[1], args[2], args[3], args[4], args[5]
            ));
        }
    }

    /// `Interface::Method=count` lines, most-called first.
    pub fn com_histogram(&self, top: usize) -> String {
        let mut pairs: Vec<(&String, &u64)> = self.com_calls.iter().collect();
        pairs.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        pairs
            .into_iter()
            .take(top)
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn unimplemented_methods(&self) -> String {
        self.com_unimplemented.join(" ")
    }

    pub fn lookup_method(&self, thunk_va: u64) -> Option<(ComKind, usize)> {
        self.method_map.get(&thunk_va).copied()
    }

    fn alloc_com_space(&mut self, bytes: u64) -> u64 {
        let aligned = (bytes + 15) & !15;
        let out = self.next_com_alloc;
        self.next_com_alloc += aligned;
        out
    }

    fn create_com_object(&mut self, vmm: &mut VirtualMemoryManager, kind: ComKind, parent_device: u64) -> u64 {
        let ptr = self.alloc_com_space(32);
        let vtbl = self.vtables[&kind];
        let _ = vmm.write_u64(ptr, vtbl);
        self.objects.insert(
            ptr,
            ComObject {
                ptr,
                kind,
                refcount: 1,
                parent_device,
                blob_va: 0,
                blob_size: 0,
                queue_type: 0,
                cmd_list_type: 0,
                cmd_list_open: true,
                recorded_cmds: Vec::new(),
                heap_type: 0,
                heap_num_desc: 0,
                heap_cpu_start: 0,
                heap_gpu_start: 0,
                pso_ps_source: PsColorSource::Constant([0.0, 1.0, 0.0, 1.0]),
                pso_rtv_format: DXGI_FORMAT_B8G8R8A8_UNORM,
                fence_value: 0,
                resource: None,
                swapchain: None,
            },
        );
        ptr
    }

    fn read_guid(vmm: &mut VirtualMemoryManager, addr: u64) -> [u8; 16] {
        let mut g = [0u8; 16];
        if addr != 0 {
            let _ = vmm.read_bytes(addr, &mut g);
        }
        g
    }

    const fn guid(d1: u32, d2: u16, d3: u16, d4: [u8; 8]) -> [u8; 16] {
        let b1 = d1.to_le_bytes();
        let b2 = d2.to_le_bytes();
        let b3 = d3.to_le_bytes();
        [
            b1[0], b1[1], b1[2], b1[3], b2[0], b2[1], b3[0], b3[1], d4[0], d4[1], d4[2], d4[3],
            d4[4], d4[5], d4[6], d4[7],
        ]
    }

    fn supports_iid(kind: ComKind, iid: &[u8; 16]) -> bool {
        const IID_IUNKNOWN: [u8; 16] =
            D3d12Subsystem::guid(0x00000000, 0x0000, 0x0000, [0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]);
        const IID_D3D12_OBJECT: [u8; 16] =
            D3d12Subsystem::guid(0xc4fec28f, 0x7966, 0x4e95, [0x9f, 0x94, 0xf4, 0x31, 0xcb, 0x56, 0xc3, 0xb8]);
        const IID_D3D12_DEVICE_CHILD: [u8; 16] =
            D3d12Subsystem::guid(0x905db94b, 0xa00c, 0x4140, [0x9d, 0xf5, 0x2b, 0x64, 0xca, 0x9e, 0xa3, 0x57]);
        const IID_D3D12_PAGEABLE: [u8; 16] =
            D3d12Subsystem::guid(0x63ee58fb, 0x1268, 0x4835, [0x86, 0xda, 0xf0, 0x08, 0xce, 0x62, 0xf0, 0xd6]);
        const IID_D3D12_DEVICE: [u8; 16] =
            D3d12Subsystem::guid(0x189819f1, 0x1db6, 0x4b57, [0xbe, 0x54, 0x18, 0x21, 0x33, 0x9b, 0x85, 0xf7]);
        const IID_D3D12_COMMAND_QUEUE: [u8; 16] =
            D3d12Subsystem::guid(0x0ec870a6, 0x5d7e, 0x4c22, [0x8c, 0xfc, 0x5b, 0xaa, 0xe0, 0x76, 0x16, 0xed]);

        const IID_DXGI_OBJECT: [u8; 16] =
            D3d12Subsystem::guid(0xaec22fb8, 0x76f3, 0x4639, [0x9b, 0xe0, 0x28, 0xeb, 0x43, 0xa6, 0x7a, 0x2e]);
        const IID_DXGI_DEVICE_SUBOBJECT: [u8; 16] =
            D3d12Subsystem::guid(0x3d3e0379, 0xf9de, 0x4d58, [0xbb, 0x6c, 0x18, 0xd6, 0x29, 0x92, 0xf1, 0xa6]);
        const IID_DXGI_FACTORY: [u8; 16] =
            D3d12Subsystem::guid(0x7b7166ec, 0x21c7, 0x44ae, [0xb2, 0x1a, 0xc9, 0xae, 0x32, 0x1a, 0xe3, 0x69]);
        const IID_DXGI_FACTORY1: [u8; 16] =
            D3d12Subsystem::guid(0x770aae78, 0xf26f, 0x4dba, [0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87]);
        const IID_DXGI_FACTORY2: [u8; 16] =
            D3d12Subsystem::guid(0x50c83a1c, 0xe072, 0x4c48, [0x87, 0xb0, 0x36, 0x30, 0xfa, 0x36, 0xa6, 0xd0]);
        const IID_DXGI_FACTORY4: [u8; 16] =
            D3d12Subsystem::guid(0x1bc6ea02, 0xef36, 0x464f, [0xbf, 0x0c, 0x21, 0xca, 0x39, 0xe5, 0x16, 0x8a]);
        const IID_DXGI_ADAPTER: [u8; 16] =
            D3d12Subsystem::guid(0x2411e7e1, 0x12ac, 0x4ccf, [0xbd, 0x14, 0x97, 0x98, 0xe8, 0x53, 0x4d, 0xc0]);
        const IID_DXGI_ADAPTER1: [u8; 16] =
            D3d12Subsystem::guid(0x29038f61, 0x3839, 0x4626, [0x91, 0xfd, 0x08, 0x68, 0x79, 0x01, 0x1a, 0x05]);
        const IID_DXGI_SWAPCHAIN: [u8; 16] =
            D3d12Subsystem::guid(0x310d36a0, 0xd2e7, 0x4c0a, [0xaa, 0x04, 0x6a, 0x9d, 0x23, 0xb8, 0x88, 0x6a]);
        const IID_DXGI_SWAPCHAIN1: [u8; 16] =
            D3d12Subsystem::guid(0x790a45f7, 0x0d42, 0x4876, [0x98, 0x3a, 0x0a, 0x55, 0xcf, 0xe6, 0xf4, 0xaa]);
        const IID_DXGI_SWAPCHAIN3: [u8; 16] =
            D3d12Subsystem::guid(0x94d99bdb, 0xf1f8, 0x4ab0, [0xb2, 0x36, 0x7d, 0xa0, 0x17, 0x0e, 0xda, 0xb1]);

        if *iid == IID_IUNKNOWN {
            return true;
        }
        match kind {
            ComKind::D3d12Device => *iid == IID_D3D12_OBJECT || *iid == IID_D3D12_DEVICE,
            ComKind::D3d12CommandQueue => {
                *iid == IID_D3D12_OBJECT
                    || *iid == IID_D3D12_DEVICE_CHILD
                    || *iid == IID_D3D12_PAGEABLE
                    || *iid == IID_D3D12_COMMAND_QUEUE
            }
            ComKind::DxgiFactory => {
                *iid == IID_DXGI_OBJECT
                    || *iid == IID_DXGI_FACTORY
                    || *iid == IID_DXGI_FACTORY1
                    || *iid == IID_DXGI_FACTORY2
                    || *iid == IID_DXGI_FACTORY4
            }
            ComKind::DxgiAdapter => {
                *iid == IID_DXGI_OBJECT || *iid == IID_DXGI_ADAPTER || *iid == IID_DXGI_ADAPTER1
            }
            ComKind::DxgiSwapChain => {
                *iid == IID_DXGI_OBJECT
                    || *iid == IID_DXGI_DEVICE_SUBOBJECT
                    || *iid == IID_DXGI_SWAPCHAIN
                    || *iid == IID_DXGI_SWAPCHAIN1
                    || *iid == IID_DXGI_SWAPCHAIN3
            }
            _ => {
                // Other D3D12 child objects support ID3D12Object + ID3D12DeviceChild + ID3D12Pageable (not DXGI)
                if *iid == IID_DXGI_OBJECT
                    || *iid == IID_DXGI_DEVICE_SUBOBJECT
                    || *iid == IID_DXGI_ADAPTER
                    || *iid == IID_DXGI_FACTORY
                {
                    false
                } else {
                    true
                }
            }
        }
    }

    fn swapchain_has_outstanding_buffer_refs(&self, sc_ptr: u64) -> bool {
        if let Some(sc_obj) = self.objects.get(&sc_ptr) {
            if let Some(sc) = &sc_obj.swapchain {
                for &buf_ptr in &sc.buffers {
                    if let Some(b_obj) = self.objects.get(&buf_ptr) {
                        if b_obj.refcount > 0 {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    pub fn add_ref(&mut self, ptr: u64) -> u32 {
        let (kind, new_user_ref) = if let Some(obj) = self.objects.get_mut(&ptr) {
            obj.refcount = obj.refcount.saturating_add(1);
            (obj.kind, obj.refcount)
        } else {
            return 0;
        };
        if kind == ComKind::DxgiSwapChain && self.swapchain_has_outstanding_buffer_refs(ptr) {
            new_user_ref + 1
        } else {
            new_user_ref
        }
    }

    pub fn release(&mut self, vmm: &mut VirtualMemoryManager, ptr: u64) -> u32 {
        let (kind, new_user_ref, sc_owner) = if let Some(obj) = self.objects.get_mut(&ptr) {
            obj.refcount = obj.refcount.saturating_sub(1);
            let owner = obj.resource.as_ref().and_then(|r| r.swapchain_owner);
            (obj.kind, obj.refcount, owner)
        } else {
            return 0;
        };

        if kind == ComKind::DxgiSwapChain {
            let umbrella = if self.swapchain_has_outstanding_buffer_refs(ptr) {
                1
            } else {
                0
            };
            let total = new_user_ref + umbrella;
            if total == 0 {
                if let Some(sc_obj) = self.objects.remove(&ptr) {
                    if let Some(sc) = sc_obj.swapchain {
                        for b in sc.buffers {
                            self.objects.remove(&b);
                        }
                    }
                }
            }
            return total;
        }

        if let Some(sc_ptr) = sc_owner {
            // Backbuffer owned by swapchain: remains alive as long as swapchain lives,
            // and if swapchain user_refs == 0 and all backbuffer refs hit 0, destroy swapchain too.
            if new_user_ref == 0 && !self.swapchain_has_outstanding_buffer_refs(sc_ptr) {
                let sc_dead = self
                    .objects
                    .get(&sc_ptr)
                    .map(|o| o.refcount == 0)
                    .unwrap_or(false);
                if sc_dead {
                    if let Some(sc_obj) = self.objects.remove(&sc_ptr) {
                        if let Some(sc) = sc_obj.swapchain {
                            for b in sc.buffers {
                                self.objects.remove(&b);
                            }
                        }
                    }
                }
            }
            return new_user_ref;
        }

        if new_user_ref == 0 {
            if let Some(removed) = self.objects.remove(&ptr) {
                if removed.parent_device != 0 {
                    // Note: D3D12 child objects do NOT hold strong public refcounts on ID3D12Device!
                    // (Verified by d3d12.c destroy_test_context: device refcount reaches 0 after releasing children)
                }
                if let Some(res) = removed.resource {
                    if res.guest_va != 0 {
                        let _ = vmm.virtual_free(res.guest_va, 0, crate::vmm::MEM_RELEASE);
                    }
                }
            }
        }
        new_user_ref
    }

    pub fn create_dxgi_factory(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        riid: u64,
        out_ppv: u64,
    ) -> u32 {
        if out_ppv == 0 {
            return E_POINTER;
        }
        let iid = Self::read_guid(vmm, riid);
        if !Self::supports_iid(ComKind::DxgiFactory, &iid) {
            let _ = vmm.write_u64(out_ppv, 0);
            return E_NOINTERFACE;
        }
        let ptr = self.create_com_object(vmm, ComKind::DxgiFactory, 0);
        let _ = vmm.write_u64(out_ppv, ptr);
        S_OK
    }

    pub fn d3d12_create_device(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        _adapter: u64,
        min_feature_level: u32,
        riid: u64,
        out_device: u64,
    ) -> u32 {
        // Feature levels: 0xb000 (11_0), 0xb100 (11_1), 0xc000 (12_0), 0xc100 (12_1)
        if min_feature_level < 0xb000 || min_feature_level > 0xc200 {
            if out_device != 0 {
                let _ = vmm.write_u64(out_device, 0);
            }
            return E_INVALIDARG;
        }
        let iid = Self::read_guid(vmm, riid);
        if !Self::supports_iid(ComKind::D3d12Device, &iid) {
            if out_device != 0 {
                let _ = vmm.write_u64(out_device, 0);
            }
            return E_NOINTERFACE;
        }
        // NULL ppDevice is valid in D3D12CreateDevice (returns S_FALSE = 1 to test support!)
        if out_device == 0 {
            return 1; // S_FALSE
        }
        let dev = self.create_com_object(vmm, ComKind::D3d12Device, 0);
        let _ = vmm.write_u64(out_device, dev);
        S_OK
    }

    pub fn d3d12_serialize_root_signature(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        _desc: u64,
        _version: u32,
        out_blob: u64,
        out_err_blob: u64,
    ) -> u32 {
        if out_err_blob != 0 {
            let _ = vmm.write_u64(out_err_blob, 0);
        }
        if out_blob == 0 {
            return E_INVALIDARG;
        }
        let blob_ptr = self.create_com_object(vmm, ComKind::D3dBlob, 0);
        let payload_va = self.alloc_com_space(64);
        let _ = vmm.host_write_bytes(payload_va, b"DXBCRootSigV1\0\0\0");
        if let Some(obj) = self.objects.get_mut(&blob_ptr) {
            obj.blob_va = payload_va;
            obj.blob_size = 16;
        }
        let _ = vmm.write_u64(out_blob, blob_ptr);
        S_OK
    }

    /// Parses real SM5.0 DXBC `SHEX`/`SHDR` bytecode to determine whether a pixel shader
    /// outputs a constant `float4` immediate (`mov o0.xyzw, l(r,g,b,a)`) or reads root constants (`cb0`).
    fn parse_dxbc_pixel_shader(vmm: &mut VirtualMemoryManager, code_ptr: u64, byte_len: usize) -> PsColorSource {
        if code_ptr == 0 || byte_len < 36 || byte_len > 65536 {
            return PsColorSource::Constant([0.0, 1.0, 0.0, 1.0]);
        }
        let mut bytes = vec![0u8; byte_len];
        if vmm.read_bytes(code_ptr, &mut bytes).is_err() {
            return PsColorSource::Constant([0.0, 1.0, 0.0, 1.0]);
        }
        if &bytes[0..4] != b"DXBC" {
            return PsColorSource::Constant([0.0, 1.0, 0.0, 1.0]);
        }
        let chunk_count = u32::from_le_bytes(bytes[28..32].try_into().unwrap()) as usize;
        for c in 0..chunk_count {
            let off_pos = 32 + c * 4;
            if off_pos + 4 > bytes.len() {
                break;
            }
            let chunk_off = u32::from_le_bytes(bytes[off_pos..off_pos + 4].try_into().unwrap()) as usize;
            if chunk_off + 16 > bytes.len() {
                continue;
            }
            let fourcc = &bytes[chunk_off..chunk_off + 4];
            if fourcc == b"SHEX" || fourcc == b"SHDR" {
                let dwords_total =
                    u32::from_le_bytes(bytes[chunk_off + 12..chunk_off + 16].try_into().unwrap()) as usize;
                let mut pc = 2usize; // skip version + length dwords
                while pc < dwords_total && chunk_off + 8 + (pc + 1) * 4 <= bytes.len() {
                    let tok_off = chunk_off + 8 + pc * 4;
                    let tok = u32::from_le_bytes(bytes[tok_off..tok_off + 4].try_into().unwrap());
                    let opcode = tok & 0x7FF;
                    let insn_len = ((tok >> 24) & 0x7F) as usize;
                    if insn_len == 0 {
                        break;
                    }
                    // D3D10_SB_OPCODE_DCL_CONSTANT_BUFFER = 0x59
                    if opcode == 0x59 {
                        return PsColorSource::RootConstants { slot: 0 };
                    }
                    // D3D10_SB_OPCODE_MOV = 0x36 with immediate32 vec4 (len 8)
                    if opcode == 0x36 && insn_len >= 8 && chunk_off + 8 + (pc + 8) * 4 <= bytes.len() {
                        let src_tok_off = chunk_off + 8 + (pc + 3) * 4;
                        let src_tok =
                            u32::from_le_bytes(bytes[src_tok_off..src_tok_off + 4].try_into().unwrap());
                        let src_type = (src_tok >> 12) & 0xFF;
                        if src_type == 4 {
                            // IMMEDIATE32
                            let mut rgba = [0.0f32; 4];
                            for k in 0..4 {
                                let vo = chunk_off + 8 + (pc + 4 + k) * 4;
                                rgba[k] = f32::from_le_bytes(bytes[vo..vo + 4].try_into().unwrap());
                            }
                            return PsColorSource::Constant(rgba);
                        } else if src_type == 8 {
                            // CONSTANT_BUFFER
                            return PsColorSource::RootConstants { slot: 0 };
                        }
                    }
                    pc += insn_len;
                }
            }
        }
        PsColorSource::Constant([0.0, 1.0, 0.0, 1.0])
    }

    #[inline]
    pub fn pack_pixel(format: u32, color: [f32; 4]) -> u32 {
        let clamp01 = |v: f32| v.clamp(0.0, 1.0);
        let r = clamp01(color[0]);
        let g = clamp01(color[1]);
        let b = clamp01(color[2]);
        let a = clamp01(color[3]);
        match format {
            DXGI_FORMAT_R8G8B8A8_UNORM => {
                let ri = (r * 255.0 + 0.5) as u32;
                let gi = (g * 255.0 + 0.5) as u32;
                let bi = (b * 255.0 + 0.5) as u32;
                let ai = (a * 255.0 + 0.5) as u32;
                (ai << 24) | (bi << 16) | (gi << 8) | ri
            }
            DXGI_FORMAT_R10G10B10A2_UNORM => {
                let ri = (r * 1023.0 + 0.5) as u32 & 0x3FF;
                let gi = (g * 1023.0 + 0.5) as u32 & 0x3FF;
                let bi = (b * 1023.0 + 0.5) as u32 & 0x3FF;
                let ai = (a * 3.0 + 0.5) as u32 & 0x3;
                (ai << 30) | (bi << 20) | (gi << 10) | ri
            }
            _ => {
                // Default DXGI_FORMAT_B8G8R8A8_UNORM (87)
                let ri = (r * 255.0 + 0.5) as u32;
                let gi = (g * 255.0 + 0.5) as u32;
                let bi = (b * 255.0 + 0.5) as u32;
                let ai = (a * 255.0 + 0.5) as u32;
                (ai << 24) | (ri << 16) | (gi << 8) | bi
            }
        }
    }

    #[inline]
    fn unpack_to_rgba8(format: u32, packed: u32) -> [u8; 4] {
        match format {
            DXGI_FORMAT_R8G8B8A8_UNORM => [
                (packed & 0xFF) as u8,
                ((packed >> 8) & 0xFF) as u8,
                ((packed >> 16) & 0xFF) as u8,
                ((packed >> 24) & 0xFF) as u8,
            ],
            DXGI_FORMAT_R10G10B10A2_UNORM => {
                let r = (((packed & 0x3FF) * 255 + 511) / 1023) as u8;
                let g = ((((packed >> 10) & 0x3FF) * 255 + 511) / 1023) as u8;
                let b = ((((packed >> 20) & 0x3FF) * 255 + 511) / 1023) as u8;
                let a = ((((packed >> 30) & 0x3) * 255 + 1) / 3) as u8;
                [r, g, b, a]
            }
            _ => [
                ((packed >> 16) & 0xFF) as u8,
                ((packed >> 8) & 0xFF) as u8,
                (packed & 0xFF) as u8,
                ((packed >> 24) & 0xFF) as u8,
            ],
        }
    }

    fn allocate_swapchain(
        &mut self,
        vmm: &mut VirtualMemoryManager,
        queue_or_dev: u64,
        hwnd: u64,
        width: u32,
        height: u32,
        format: u32,
        buffer_count: u32,
        windowed: bool,
    ) -> Result<u64, u32> {
        if hwnd == DESKTOP_HWND || hwnd == 0 {
            if hwnd == DESKTOP_HWND {
                return Err(E_ACCESSDENIED);
            }
            return Err(DXGI_ERROR_INVALID_CALL);
        }
        // Validate command queue type == DIRECT (0)
        if let Some(q_obj) = self.objects.get(&queue_or_dev) {
            if q_obj.kind == ComKind::D3d12CommandQueue {
                if q_obj.queue_type != 0 {
                    return Err(DXGI_ERROR_INVALID_CALL);
                }
            } else {
                return Err(DXGI_ERROR_INVALID_CALL);
            }
        } else {
            return Err(DXGI_ERROR_INVALID_CALL);
        }

        if buffer_count == 0 || buffer_count > 16 {
            return Err(DXGI_ERROR_INVALID_CALL);
        }
        let w = if width == 0 { 640 } else { width };
        let h = if height == 0 { 480 } else { height };
        let _ = windowed;

        let sc_ptr = self.create_com_object(vmm, ComKind::DxgiSwapChain, 0);
        let mut buffers = Vec::with_capacity(buffer_count as usize);
        for _ in 0..buffer_count {
            let res_ptr = self.create_com_object(vmm, ComKind::D3d12Resource, 0);
            if let Some(r_obj) = self.objects.get_mut(&res_ptr) {
                r_obj.refcount = 0; // Internal swapchain ownership starts at 0 user refs!
                r_obj.resource = Some(ResourceData {
                    dimension: 3, // TEXTURE2D
                    width: w as u64,
                    height: h,
                    depth_or_array: 1,
                    mip_levels: 1,
                    format,
                    flags: 0x1, // ALLOW_RENDER_TARGET
                    heap_type: 1,
                    guest_va: 0,
                    byte_size: (w as usize) * (h as usize) * 4,
                    texels_u32: vec![0xFF00_0000; (w as usize) * (h as usize)],
                    swapchain_owner: Some(sc_ptr),
                });
            }
            buffers.push(res_ptr);
        }

        if let Some(sc_obj) = self.objects.get_mut(&sc_ptr) {
            sc_obj.swapchain = Some(SwapChainData {
                hwnd,
                width: w,
                height: h,
                format,
                buffer_count,
                current_index: 0,
                buffers,
                device_or_queue: queue_or_dev,
            });
        }
        Ok(sc_ptr)
    }

    fn execute_command_list(&mut self, vmm: &mut VirtualMemoryManager, cmd_list_ptr: u64) {
        let Some(cmds) = self
            .objects
            .get(&cmd_list_ptr)
            .map(|o| o.recorded_cmds.clone())
        else {
            return;
        };

        let mut active_rtv: Option<u64> = None;
        let mut active_pso: Option<u64> = None;
        let mut root_consts = [0u32; 64];
        let mut scissor: Option<(i32, i32, i32, i32)> = None;

        for cmd in cmds {
            match cmd {
                GpuCommand::ClearRtv { rtv_ptr, color } => {
                    if let Some(&(res_ptr, fmt_override)) = self.rtv_bindings.get(&rtv_ptr) {
                        if let Some(obj) = self.objects.get_mut(&res_ptr) {
                            if let Some(res) = &mut obj.resource {
                                let fmt = if fmt_override != 0 { fmt_override } else { res.format };
                                let packed = Self::pack_pixel(fmt, color);
                                res.texels_u32.fill(packed);
                            }
                        }
                    }
                }
                GpuCommand::SetPipelineState { pso_ptr } => {
                    active_pso = Some(pso_ptr);
                }
                GpuCommand::SetRoot32BitConstants {
                    dest_offset,
                    values,
                    ..
                } => {
                    for (i, &v) in values.iter().enumerate() {
                        let dst = (dest_offset as usize) + i;
                        if dst < root_consts.len() {
                            root_consts[dst] = v;
                        }
                    }
                }
                GpuCommand::SetRenderTargets { rtv_ptrs } => {
                    active_rtv = rtv_ptrs.first().copied();
                }
                GpuCommand::SetViewport { .. } => {}
                GpuCommand::SetScissor {
                    left,
                    top,
                    right,
                    bottom,
                } => {
                    scissor = Some((left, top, right, bottom));
                }
                GpuCommand::DrawInstanced {
                    vertex_count,
                    instance_count,
                } => {
                    if vertex_count == 0 || instance_count == 0 {
                        continue;
                    }
                    let Some(rtv_ptr) = active_rtv else { continue };
                    let Some(&(res_ptr, fmt_override)) = self.rtv_bindings.get(&rtv_ptr) else {
                        continue;
                    };
                    let color = if let Some(pso_ptr) = active_pso {
                        if let Some(pso_obj) = self.objects.get(&pso_ptr) {
                            match &pso_obj.pso_ps_source {
                                PsColorSource::Constant(c) => *c,
                                PsColorSource::RootConstants { .. } => [
                                    f32::from_bits(root_consts[0]),
                                    f32::from_bits(root_consts[1]),
                                    f32::from_bits(root_consts[2]),
                                    f32::from_bits(root_consts[3]),
                                ],
                            }
                        } else {
                            [0.0, 1.0, 0.0, 1.0]
                        }
                    } else {
                        [0.0, 1.0, 0.0, 1.0]
                    };

                    if let Some(obj) = self.objects.get_mut(&res_ptr) {
                        if let Some(res) = &mut obj.resource {
                            let w = res.width as i32;
                            let h = res.height as i32;
                            let (x0, y0, x1, y1) = if let Some((l, t, r, b)) = scissor {
                                (l.max(0), t.max(0), r.min(w), b.min(h))
                            } else {
                                (0, 0, w, h)
                            };
                            let fmt = if fmt_override != 0 { fmt_override } else { res.format };
                            let packed = Self::pack_pixel(fmt, color);
                            for y in y0..y1 {
                                let row_off = (y as usize) * (w as usize);
                                for x in x0..x1 {
                                    let idx = row_off + (x as usize);
                                    if idx < res.texels_u32.len() {
                                        res.texels_u32[idx] = packed;
                                    }
                                }
                            }
                        }
                    }
                }
                GpuCommand::CopyTextureRegion {
                    dst_res,
                    dst_type,
                    dst_offset,
                    dst_row_pitch,
                    src_res,
                    src_type,
                    ..
                } => {
                    // Texture2D (subresource index, type 0) -> Readback Buffer (placed footprint, type 1)
                    if src_type == 0 && dst_type == 1 {
                        let tex_info = self.objects.get(&src_res).and_then(|o| {
                            o.resource
                                .as_ref()
                                .map(|r| (r.width as usize, r.height as usize, r.texels_u32.clone()))
                        });
                        let dst_va = self
                            .objects
                            .get(&dst_res)
                            .and_then(|o| o.resource.as_ref().map(|r| r.guest_va))
                            .unwrap_or(0);
                        if let Some((tw, th, texels)) = tex_info {
                            if dst_va != 0 {
                                let pitch = (dst_row_pitch as usize).max(tw * 4);
                                for y in 0..th {
                                    let mut row_bytes = Vec::with_capacity(tw * 4);
                                    for x in 0..tw {
                                        let px = texels.get(y * tw + x).copied().unwrap_or(0);
                                        row_bytes.extend_from_slice(&px.to_le_bytes());
                                    }
                                    let row_va = dst_va + dst_offset + (y * pitch) as u64;
                                    let _ = vmm.host_write_bytes(row_va, &row_bytes);
                                }
                            }
                        }
                    }
                }
                GpuCommand::CopyBufferRegion {
                    dst_res,
                    dst_offset,
                    src_res,
                    src_offset,
                    num_bytes,
                } => {
                    let dst_va = self
                        .objects
                        .get(&dst_res)
                        .and_then(|o| o.resource.as_ref().map(|r| r.guest_va))
                        .unwrap_or(0);
                    let src_va = self
                        .objects
                        .get(&src_res)
                        .and_then(|o| o.resource.as_ref().map(|r| r.guest_va))
                        .unwrap_or(0);
                    if dst_va != 0 && src_va != 0 && num_bytes <= 16 * 1024 * 1024 {
                        let mut tmp = vec![0u8; num_bytes as usize];
                        if vmm.host_read_bytes(src_va + src_offset, &mut tmp).is_ok() {
                            let _ = vmm.host_write_bytes(dst_va + dst_offset, &tmp);
                        }
                    }
                }
                GpuCommand::CopyResource { dst_res, src_res } => {
                    let src_clone = self.objects.get(&src_res).and_then(|o| o.resource.clone());
                    if let (Some(src), Some(dst_obj)) = (src_clone, self.objects.get_mut(&dst_res)) {
                        if let Some(dst) = &mut dst_obj.resource {
                            if !src.texels_u32.is_empty() && dst.texels_u32.len() == src.texels_u32.len() {
                                dst.texels_u32.copy_from_slice(&src.texels_u32);
                            } else if src.guest_va != 0 && dst.guest_va != 0 {
                                let n = src.byte_size.min(dst.byte_size);
                                let mut tmp = vec![0u8; n];
                                if vmm.host_read_bytes(src.guest_va, &mut tmp).is_ok() {
                                    let _ = vmm.host_write_bytes(dst.guest_va, &tmp);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// Dispatches a COM vtable call (`RCX = This`, `RDX, R8, R9, stack[5..]` = args) and returns `RAX`.
    pub fn dispatch_vtable_call(
        &mut self,
        kind: ComKind,
        slot: usize,
        args: &[u64; 10],
        vmm: &mut VirtualMemoryManager,
        signal_win32_event: impl FnMut(u64),
        query_client_size: impl FnMut(u64) -> Option<(u32, u32)>,
    ) -> u64 {
        let result = self.dispatch_vtable_call_inner(
            kind,
            slot,
            args,
            vmm,
            signal_win32_event,
            query_client_size,
        );
        self.record_com(kind, slot, args, result);
        result
    }

    fn dispatch_vtable_call_inner(
        &mut self,
        kind: ComKind,
        slot: usize,
        args: &[u64; 10],
        vmm: &mut VirtualMemoryManager,
        mut signal_win32_event: impl FnMut(u64),
        mut query_client_size: impl FnMut(u64) -> Option<(u32, u32)>,
    ) -> u64 {
        let this = args[0];

        // Universal IUnknown slots 0..=2
        match slot {
            0 => {
                // QueryInterface(This, riid, ppvObject)
                let riid = args[1];
                let ppv = args[2];
                if ppv == 0 {
                    return E_POINTER as u64;
                }
                let iid = Self::read_guid(vmm, riid);
                if Self::supports_iid(kind, &iid) {
                    self.add_ref(this);
                    let _ = vmm.write_u64(ppv, this);
                    return S_OK as u64;
                } else {
                    let _ = vmm.write_u64(ppv, 0);
                    return E_NOINTERFACE as u64;
                }
            }
            1 => return self.add_ref(this) as u64,
            2 => return self.release(vmm, this) as u64,
            _ => {}
        }

        match (kind, slot) {
            // ID3D10Blob
            (ComKind::D3dBlob, 3) => self.objects.get(&this).map(|o| o.blob_va).unwrap_or(0),
            (ComKind::D3dBlob, 4) => self.objects.get(&this).map(|o| o.blob_size as u64).unwrap_or(0),

            // IDXGIFactory / IDXGIFactory2 / IDXGIFactory4
            (ComKind::DxgiFactory, 7) | (ComKind::DxgiFactory, 12) => {
                // EnumAdapters / EnumAdapters1 (this, idx, ppAdapter)
                let idx = args[1] as u32;
                let out_adapter = args[2];
                if idx > 0 {
                    if out_adapter != 0 {
                        let _ = vmm.write_u64(out_adapter, 0);
                    }
                    return DXGI_ERROR_NOT_FOUND as u64;
                }
                let adp = self.create_com_object(vmm, ComKind::DxgiAdapter, 0);
                let _ = vmm.write_u64(out_adapter, adp);
                S_OK as u64
            }
            (ComKind::DxgiFactory, 8) => S_OK as u64, // MakeWindowAssociation
            (ComKind::DxgiFactory, 10) => {
                // CreateSwapChain(this, pDevice, pDesc, ppSwapChain)
                let dev_or_queue = args[1];
                let desc_ptr = args[2];
                let out_sc = args[3];
                if desc_ptr == 0 || out_sc == 0 {
                    return DXGI_ERROR_INVALID_CALL as u64;
                }
                // DXGI_SWAP_CHAIN_DESC (72 bytes): Width@0, Height@4, Format@16, BufferCount@40, OutputWindow@48, Windowed@56
                let mut width = vmm.read_u32(desc_ptr).unwrap_or(640);
                let mut height = vmm.read_u32(desc_ptr + 4).unwrap_or(480);
                let format = vmm.read_u32(desc_ptr + 16).unwrap_or(DXGI_FORMAT_B8G8R8A8_UNORM);
                let buf_cnt = vmm.read_u32(desc_ptr + 40).unwrap_or(2);
                let hwnd = vmm.read_u64(desc_ptr + 48).unwrap_or(0);
                let windowed = vmm.read_u32(desc_ptr + 56).unwrap_or(1) != 0;
                if (width == 0 || height == 0) && hwnd != 0 {
                    if let Some((cw, ch)) = query_client_size(hwnd) {
                        if width == 0 {
                            width = cw.max(1);
                        }
                        if height == 0 {
                            height = ch.max(1);
                        }
                    }
                }
                match self.allocate_swapchain(
                    vmm,
                    dev_or_queue,
                    hwnd,
                    width,
                    height,
                    format,
                    buf_cnt,
                    windowed,
                ) {
                    Ok(sc) => {
                        let _ = vmm.write_u64(out_sc, sc);
                        S_OK as u64
                    }
                    Err(hr) => {
                        let _ = vmm.write_u64(out_sc, 0);
                        hr as u64
                    }
                }
            }
            (ComKind::DxgiFactory, 13) => 1, // IsCurrent -> TRUE
            (ComKind::DxgiFactory, 15) => {
                // CreateSwapChainForHwnd(this, pDevice, hWnd, pDesc1, pFullscreenDesc, pRestrictToOutput, ppSwapChain)
                let dev_or_queue = args[1];
                let hwnd = args[2];
                let desc1_ptr = args[3];
                let out_sc = args[6];
                if desc1_ptr == 0 || out_sc == 0 {
                    if out_sc != 0 {
                        let _ = vmm.write_u64(out_sc, 0);
                    }
                    return DXGI_ERROR_INVALID_CALL as u64;
                }
                let mut width = vmm.read_u32(desc1_ptr).unwrap_or(0);
                let mut height = vmm.read_u32(desc1_ptr + 4).unwrap_or(0);
                let format = vmm.read_u32(desc1_ptr + 8).unwrap_or(DXGI_FORMAT_B8G8R8A8_UNORM);
                let buf_cnt = vmm.read_u32(desc1_ptr + 28).unwrap_or(2);
                if width == 0 || height == 0 {
                    if let Some((cw, ch)) = query_client_size(hwnd) {
                        if width == 0 {
                            width = cw.max(1);
                        }
                        if height == 0 {
                            height = ch.max(1);
                        }
                    }
                }
                match self.allocate_swapchain(
                    vmm,
                    dev_or_queue,
                    hwnd,
                    width,
                    height,
                    format,
                    buf_cnt,
                    true,
                ) {
                    Ok(sc) => {
                        let _ = vmm.write_u64(out_sc, sc);
                        S_OK as u64
                    }
                    Err(hr) => {
                        let _ = vmm.write_u64(out_sc, 0);
                        hr as u64
                    }
                }
            }
            (ComKind::DxgiFactory, 26) | (ComKind::DxgiFactory, 27) => {
                // EnumAdapterByLuid / EnumWarpAdapter
                let out_adapter = if slot == 26 { args[3] } else { args[2] };
                let adp = self.create_com_object(vmm, ComKind::DxgiAdapter, 0);
                let _ = vmm.write_u64(out_adapter, adp);
                S_OK as u64
            }

            // IDXGIAdapter
            (ComKind::DxgiAdapter, 7) => {
                // EnumOutputs
                let idx = args[1] as u32;
                let out_output = args[2];
                if idx > 0 {
                    if out_output != 0 {
                        let _ = vmm.write_u64(out_output, 0);
                    }
                    return DXGI_ERROR_NOT_FOUND as u64;
                }
                let out_ptr = self.create_com_object(vmm, ComKind::DxgiOutput, 0);
                let _ = vmm.write_u64(out_output, out_ptr);
                S_OK as u64
            }
            (ComKind::DxgiAdapter, 10) => {
                // GetDesc1 (DXGI_ADAPTER_DESC1 = DXGI_ADAPTER_DESC + Flags at 304)
                let desc_ptr = args[1];
                if desc_ptr == 0 {
                    return E_INVALIDARG as u64;
                }
                let zero = [0u8; 312];
                let _ = vmm.write_bytes(desc_ptr, &zero);
                let name: Vec<u16> = "Porthole WebGPU x86-64 Virtual Adapter"
                    .encode_utf16()
                    .collect();
                for (i, &ch) in name.iter().enumerate() {
                    let _ = vmm.write_u16(desc_ptr + (i as u64) * 2, ch);
                }
                let _ = vmm.write_u32(desc_ptr + 256, 0x1AE0);
                let _ = vmm.write_u32(desc_ptr + 260, 0xD312);
                let _ = vmm.write_u64(desc_ptr + 272, 1024 * 1024 * 1024);
                let _ = vmm.write_u64(desc_ptr + 280, 0);
                let _ = vmm.write_u64(desc_ptr + 288, 2 * 1024 * 1024 * 1024);
                let _ = vmm.write_u32(desc_ptr + 296, ADAPTER_LUID_LOW);
                let _ = vmm.write_u32(desc_ptr + 300, ADAPTER_LUID_HIGH);
                // DXGI_ADAPTER_FLAG_SOFTWARE (0x2) would make engines skip the adapter; this is a
                // hardware-class adapter as far as the guest can tell.
                let _ = vmm.write_u32(desc_ptr + 304, 0);
                S_OK as u64
            }
            (ComKind::DxgiAdapter, 8) => {
                // GetDesc (DXGI_ADAPTER_DESC = 304 bytes: Description[128] WCHAR @0, VendorId@256, DeviceId@260, AdapterLuid@296)
                let desc_ptr = args[1];
                if desc_ptr == 0 {
                    return E_INVALIDARG as u64;
                }
                let zero = [0u8; 304];
                let _ = vmm.write_bytes(desc_ptr, &zero);
                let name: Vec<u16> = "Porthole WebGPU x86-64 Virtual Adapter".encode_utf16().collect();
                for (i, &ch) in name.iter().enumerate() {
                    let _ = vmm.write_u16(desc_ptr + (i as u64) * 2, ch);
                }
                let _ = vmm.write_u32(desc_ptr + 256, 0x1AE0); // Google/WebGPU Vendor ID
                let _ = vmm.write_u32(desc_ptr + 260, 0xD312); // Porthole D3D12 Device ID
                let _ = vmm.write_u64(desc_ptr + 272, 1024 * 1024 * 1024); // DedicatedVideoMemory 1 GB
                let _ = vmm.write_u32(desc_ptr + 296, ADAPTER_LUID_LOW);
                let _ = vmm.write_u32(desc_ptr + 300, ADAPTER_LUID_HIGH);
                S_OK as u64
            }

            // IDXGIOutput
            (ComKind::DxgiOutput, 7) => {
                let desc_ptr = args[1];
                if desc_ptr != 0 {
                    let zero = [0u8; 96];
                    let _ = vmm.write_bytes(desc_ptr, &zero);
                    let _ = vmm.write_u32(desc_ptr + 72, 1920);
                    let _ = vmm.write_u32(desc_ptr + 76, 1080);
                    let _ = vmm.write_u32(desc_ptr + 80, 1); // AttachedToDesktop
                }
                S_OK as u64
            }

            // IDXGISwapChain / IDXGISwapChain1 / IDXGISwapChain3
            (ComKind::DxgiSwapChain, 8) | (ComKind::DxgiSwapChain, 22) => {
                // Present / Present1
                let flags = args[2] as u32;
                let (cur_buf_ptr, w, h, fmt, next_idx) = if let Some(sc_obj) = self.objects.get(&this) {
                    if let Some(sc) = &sc_obj.swapchain {
                        let cur_buf = sc.buffers[sc.current_index as usize];
                        let nidx = if (flags & 1) != 0 {
                            // DXGI_PRESENT_TEST (1) does not advance backbuffer!
                            sc.current_index
                        } else {
                            (sc.current_index + 1) % sc.buffer_count
                        };
                        (cur_buf, sc.width, sc.height, sc.format, nidx)
                    } else {
                        return DXGI_ERROR_INVALID_CALL as u64;
                    }
                } else {
                    return DXGI_ERROR_INVALID_CALL as u64;
                };

                if (flags & 1) == 0 {
                    if let Some(buf_obj) = self.objects.get(&cur_buf_ptr) {
                        if let Some(res) = &buf_obj.resource {
                            let px_cnt = (w as usize) * (h as usize);
                            self.last_frame_width = w;
                            self.last_frame_height = h;
                            self.last_frame_rgba.resize(px_cnt * 4, 0);
                            for i in 0..px_cnt.min(res.texels_u32.len()) {
                                let rgba = Self::unpack_to_rgba8(fmt, res.texels_u32[i]);
                                self.last_frame_rgba[i * 4..i * 4 + 4].copy_from_slice(&rgba);
                            }
                            self.frames_presented += 1;
                            self.frame_dirty = true;
                        }
                    }
                    if let Some(sc_obj) = self.objects.get_mut(&this) {
                        if let Some(sc) = &mut sc_obj.swapchain {
                            sc.current_index = next_idx;
                        }
                    }
                }
                S_OK as u64
            }
            (ComKind::DxgiSwapChain, 9) => {
                // GetBuffer(this, Buffer, riid, ppSurface)
                let buf_idx = args[1] as usize;
                let out_surf = args[3];
                if out_surf == 0 {
                    return E_POINTER as u64;
                }
                let buf_ptr = self
                    .objects
                    .get(&this)
                    .and_then(|o| o.swapchain.as_ref())
                    .and_then(|sc| sc.buffers.get(buf_idx).copied());
                let Some(bp) = buf_ptr else {
                    let _ = vmm.write_u64(out_surf, 0);
                    return DXGI_ERROR_INVALID_CALL as u64;
                };
                self.add_ref(bp);
                let _ = vmm.write_u64(out_surf, bp);
                S_OK as u64
            }
            (ComKind::DxgiSwapChain, 10) => S_OK as u64, // SetFullscreenState
            (ComKind::DxgiSwapChain, 11) => {
                // GetFullscreenState(this, pFullscreen, ppTarget)
                if args[1] != 0 {
                    let _ = vmm.write_u32(args[1], 0);
                }
                if args[2] != 0 {
                    let _ = vmm.write_u64(args[2], 0);
                }
                S_OK as u64
            }
            (ComKind::DxgiSwapChain, 12) => {
                // GetDesc(this, pDesc)
                let desc_ptr = args[1];
                if desc_ptr == 0 {
                    return E_INVALIDARG as u64;
                }
                if let Some(sc) = self.objects.get(&this).and_then(|o| o.swapchain.as_ref()) {
                    let zero = [0u8; 72];
                    let _ = vmm.write_bytes(desc_ptr, &zero);
                    let _ = vmm.write_u32(desc_ptr, sc.width);
                    let _ = vmm.write_u32(desc_ptr + 4, sc.height);
                    let _ = vmm.write_u32(desc_ptr + 16, sc.format);
                    let _ = vmm.write_u32(desc_ptr + 28, 1); // SampleDesc.Count
                    let _ = vmm.write_u32(desc_ptr + 40, sc.buffer_count);
                    let _ = vmm.write_u64(desc_ptr + 48, sc.hwnd);
                    let _ = vmm.write_u32(desc_ptr + 56, 1); // Windowed
                }
                S_OK as u64
            }
            (ComKind::DxgiSwapChain, 13) | (ComKind::DxgiSwapChain, 39) => {
                // ResizeBuffers / ResizeBuffers1
                if self.swapchain_has_outstanding_buffer_refs(this) {
                    return DXGI_ERROR_INVALID_CALL as u64;
                }
                let new_cnt = args[1] as u32;
                let mut new_w = args[2] as u32;
                let mut new_h = args[3] as u32;
                let new_fmt = args[4] as u32;
                let hwnd = self
                    .objects
                    .get(&this)
                    .and_then(|o| o.swapchain.as_ref().map(|s| s.hwnd))
                    .unwrap_or(0);
                if new_w == 0 || new_h == 0 {
                    if let Some((cw, ch)) = query_client_size(hwnd) {
                        if new_w == 0 {
                            new_w = cw.max(1);
                        }
                        if new_h == 0 {
                            new_h = ch.max(1);
                        }
                    }
                }
                let (buf_ptrs, final_fmt) = if let Some(sc_obj) = self.objects.get_mut(&this) {
                    if let Some(sc) = &mut sc_obj.swapchain {
                        if new_w != 0 {
                            sc.width = new_w;
                        }
                        if new_h != 0 {
                            sc.height = new_h;
                        }
                        if new_fmt != 0 {
                            sc.format = new_fmt;
                        }
                        let _ = new_cnt;
                        sc.current_index = 0;
                        (sc.buffers.clone(), sc.format)
                    } else {
                        return DXGI_ERROR_INVALID_CALL as u64;
                    }
                } else {
                    return DXGI_ERROR_INVALID_CALL as u64;
                };
                for bp in buf_ptrs {
                    if let Some(b_obj) = self.objects.get_mut(&bp) {
                        if let Some(res) = &mut b_obj.resource {
                            res.width = new_w.max(1) as u64;
                            res.height = new_h.max(1);
                            res.format = final_fmt;
                            res.texels_u32 =
                                vec![0xFF00_0000; (res.width as usize) * (res.height as usize)];
                        }
                    }
                }
                S_OK as u64
            }
            (ComKind::DxgiSwapChain, 18) => {
                // GetDesc1(this, pDesc1)
                let desc1_ptr = args[1];
                if desc1_ptr == 0 {
                    return E_INVALIDARG as u64;
                }
                if let Some(sc) = self.objects.get(&this).and_then(|o| o.swapchain.as_ref()) {
                    let zero = [0u8; 48];
                    let _ = vmm.write_bytes(desc1_ptr, &zero);
                    let _ = vmm.write_u32(desc1_ptr, sc.width);
                    let _ = vmm.write_u32(desc1_ptr + 4, sc.height);
                    let _ = vmm.write_u32(desc1_ptr + 8, sc.format);
                    let _ = vmm.write_u32(desc1_ptr + 16, 1); // SampleDesc.Count
                    let _ = vmm.write_u32(desc1_ptr + 28, sc.buffer_count);
                }
                S_OK as u64
            }
            (ComKind::DxgiSwapChain, 20) => {
                // GetHwnd
                if let Some(sc) = self.objects.get(&this).and_then(|o| o.swapchain.as_ref()) {
                    if args[1] != 0 {
                        let _ = vmm.write_u64(args[1], sc.hwnd);
                    }
                }
                S_OK as u64
            }
            (ComKind::DxgiSwapChain, 36) => {
                // GetCurrentBackBufferIndex
                self.objects
                    .get(&this)
                    .and_then(|o| o.swapchain.as_ref())
                    .map(|sc| sc.current_index as u64)
                    .unwrap_or(0)
            }

            // ID3D12Device
            (ComKind::D3d12Device, 7) => 1, // GetNodeCount
            (ComKind::D3d12Device, 8) => {
                // CreateCommandQueue(this, pDesc, riid, ppCommandQueue)
                let desc_ptr = args[1];
                let out_q = args[3];
                if desc_ptr == 0 || out_q == 0 {
                    return E_INVALIDARG as u64;
                }
                let q_type = vmm.read_u32(desc_ptr).unwrap_or(0);
                let q_ptr = self.create_com_object(vmm, ComKind::D3d12CommandQueue, this);
                if let Some(q_obj) = self.objects.get_mut(&q_ptr) {
                    q_obj.queue_type = q_type;
                }
                let _ = vmm.write_u64(out_q, q_ptr);
                S_OK as u64
            }
            (ComKind::D3d12Device, 9) => {
                // CreateCommandAllocator(this, type, riid, ppCommandAllocator)
                let out_ca = args[3];
                if out_ca == 0 {
                    return E_INVALIDARG as u64;
                }
                let ca_ptr = self.create_com_object(vmm, ComKind::D3d12CommandAllocator, this);
                let _ = vmm.write_u64(out_ca, ca_ptr);
                S_OK as u64
            }
            (ComKind::D3d12Device, 10) | (ComKind::D3d12Device, 11) => {
                // CreateGraphicsPipelineState / CreateComputePipelineState
                let desc_ptr = args[1];
                let out_pso = args[3];
                if desc_ptr == 0 || out_pso == 0 {
                    return E_INVALIDARG as u64;
                }
                let ps_source = if slot == 10 {
                    // PSO_DESC: PS is at offset 24 (pShaderBytecode @24, BytecodeLength @32)
                    let ps_ptr = vmm.read_u64(desc_ptr + 24).unwrap_or(0);
                    let ps_len = vmm.read_u64(desc_ptr + 32).unwrap_or(0) as usize;
                    Self::parse_dxbc_pixel_shader(vmm, ps_ptr, ps_len)
                } else {
                    PsColorSource::Constant([0.0, 1.0, 0.0, 1.0])
                };
                let rtv_fmt = if slot == 10 {
                    vmm.read_u32(desc_ptr + 580).unwrap_or(DXGI_FORMAT_B8G8R8A8_UNORM)
                } else {
                    DXGI_FORMAT_B8G8R8A8_UNORM
                };
                let pso_ptr = self.create_com_object(vmm, ComKind::D3d12PipelineState, this);
                if let Some(p_obj) = self.objects.get_mut(&pso_ptr) {
                    p_obj.pso_ps_source = ps_source;
                    p_obj.pso_rtv_format = rtv_fmt;
                }
                let _ = vmm.write_u64(out_pso, pso_ptr);
                S_OK as u64
            }
            (ComKind::D3d12Device, 12) => {
                // CreateCommandList(this, nodeMask, type, pAllocator, pInitialState, riid, ppCommandList)
                let cl_type = args[2] as u32;
                let init_pso = args[4];
                let out_cl = args[6];
                if out_cl == 0 {
                    return E_INVALIDARG as u64;
                }
                let cl_ptr = self.create_com_object(vmm, ComKind::D3d12CommandList, this);
                if let Some(cl_obj) = self.objects.get_mut(&cl_ptr) {
                    cl_obj.cmd_list_type = cl_type;
                    cl_obj.cmd_list_open = true;
                    if init_pso != 0 {
                        cl_obj
                            .recorded_cmds
                            .push(GpuCommand::SetPipelineState { pso_ptr: init_pso });
                    }
                }
                let _ = vmm.write_u64(out_cl, cl_ptr);
                S_OK as u64
            }
            (ComKind::D3d12Device, 13) => {
                // CheckFeatureSupport(this, Feature, pFeatureSupportData, FeatureSupportDataSize)
                //
                // Zero-filling used to be "good enough", but a zeroed answer is a *negative*
                // answer: MaxSupportedFeatureLevel = 0 means "no feature level at all",
                // HighestShaderModel = 0 is not even a valid enum, and engines bail out of device
                // creation on that (or, worse, size a resource heap from MaxGPUVirtualAddressBits
                // = 0). Answer the questions a renderer actually asks.
                let feature = args[1] as u32;
                let ptr = args[2];
                let sz = args[3] as usize;
                if ptr != 0 && sz > 0 && sz <= 256 {
                    let zero = vec![0u8; sz];
                    let _ = vmm.write_bytes(ptr, &zero);
                }
                match feature {
                    2 => {
                        // D3D12_FEATURE_FEATURE_LEVELS: report the highest level the guest asked
                        // for that we support (12_0), by walking its requested array.
                        if ptr != 0 && sz >= 24 {
                            let count = vmm.read_u32(ptr).unwrap_or(0) as u64;
                            let list = vmm.read_u64(ptr + 8).unwrap_or(0);
                            let mut best: u32 = 0;
                            for i in 0..count.min(16) {
                                let want = vmm.read_u32(list + i * 4).unwrap_or(0);
                                if want >= 0xb000 && want <= 0xc000 && want > best {
                                    best = want;
                                }
                            }
                            let chosen = if best != 0 { best } else { 0xc000 };
                            let _ = vmm.write_u32(ptr + 16, chosen);
                        }
                    }
                    1 => {
                        // D3D12_FEATURE_ARCHITECTURE: discrete GPU, UMA = FALSE.
                    }
                    6 => {
                        // D3D12_FEATURE_GPU_VIRTUAL_ADDRESS_SUPPORT: 40-bit GPU VAs.
                        if ptr != 0 && sz >= 8 {
                            let _ = vmm.write_u32(ptr, 40);
                            let _ = vmm.write_u32(ptr + 4, 40);
                        }
                    }
                    7 => {
                        // D3D12_FEATURE_SHADER_MODEL: the guest passes in the highest model it
                        // understands; answer with that if it is <= 6.7.
                        if ptr != 0 && sz >= 4 {
                            let asked = vmm.read_u32(ptr).unwrap_or(0x67);
                            let reply = if (0x51..=0x67).contains(&asked) { asked } else { 0x67 };
                            let _ = vmm.write_u32(ptr, reply);
                        }
                    }
                    _ => {}
                }
                S_OK as u64
            }
            (ComKind::D3d12Device, 14) => {
                // CreateDescriptorHeap(this, pDesc, riid, ppvHeap)
                let desc_ptr = args[1];
                let out_heap = args[3];
                if desc_ptr == 0 || out_heap == 0 {
                    return E_INVALIDARG as u64;
                }
                let h_type = vmm.read_u32(desc_ptr).unwrap_or(0);
                let num_desc = vmm.read_u32(desc_ptr + 4).unwrap_or(1).max(1);
                let cpu_start = self.next_desc_ptr;
                self.next_desc_ptr += (num_desc as u64) * 32 + 64;
                let h_ptr = self.create_com_object(vmm, ComKind::D3d12DescriptorHeap, this);
                if let Some(h_obj) = self.objects.get_mut(&h_ptr) {
                    h_obj.heap_type = h_type;
                    h_obj.heap_num_desc = num_desc;
                    h_obj.heap_cpu_start = cpu_start;
                    h_obj.heap_gpu_start = cpu_start;
                }
                let _ = vmm.write_u64(out_heap, h_ptr);
                S_OK as u64
            }
            (ComKind::D3d12Device, 15) => 32, // GetDescriptorHandleIncrementSize -> 32 bytes
            (ComKind::D3d12Device, 16) => {
                // CreateRootSignature(this, nodeMask, pBlob, blobLength, riid, ppvRootSignature)
                let out_rs = args[5];
                if out_rs == 0 {
                    return E_INVALIDARG as u64;
                }
                let rs_ptr = self.create_com_object(vmm, ComKind::D3d12RootSignature, this);
                let _ = vmm.write_u64(out_rs, rs_ptr);
                S_OK as u64
            }
            (ComKind::D3d12Device, 20) => {
                // CreateRenderTargetView(this, pResource, pDesc, DestDescriptor)
                let res_ptr = args[1];
                let desc_ptr = args[2];
                let dest_cpu_ptr = args[3];
                let fmt = if desc_ptr != 0 {
                    vmm.read_u32(desc_ptr).unwrap_or(0)
                } else {
                    0
                };
                self.rtv_bindings.insert(dest_cpu_ptr, (res_ptr, fmt));
                0
            }
            (ComKind::D3d12Device, 17..=19) | (ComKind::D3d12Device, 21..=24) => 0,
            (ComKind::D3d12Device, 27) => {
                // CreateCommittedResource(this, pHeapProps, HeapFlags, pDesc, InitialState, pClearValue, riid, ppvResource)
                let heap_props_ptr = args[1];
                let desc_ptr = args[3];
                let clear_val_ptr = args[5];
                let out_res = args[7];
                if desc_ptr == 0 {
                    return E_INVALIDARG as u64;
                }
                if out_res == 0 {
                    return 1; // S_FALSE
                }
                let heap_type = if heap_props_ptr != 0 {
                    vmm.read_u32(heap_props_ptr).unwrap_or(1)
                } else {
                    1
                };
                // D3D12_RESOURCE_DESC (56 bytes): Dimension@0, Width@16, Height@24, DepthOrArraySize@28, MipLevels@30, Format@32, Flags@52
                let dimension = vmm.read_u32(desc_ptr).unwrap_or(1);
                let width = vmm.read_u64(desc_ptr + 16).unwrap_or(4);
                let height = vmm.read_u32(desc_ptr + 24).unwrap_or(1).max(1);
                let depth = vmm.read_u16(desc_ptr + 28).unwrap_or(1).max(1);
                let mips = vmm.read_u16(desc_ptr + 30).unwrap_or(1).max(1);
                let format = vmm.read_u32(desc_ptr + 32).unwrap_or(0);
                let flags = vmm.read_u32(desc_ptr + 52).unwrap_or(0);

                let mut guest_va = 0u64;
                let mut texels_u32 = Vec::new();
                let byte_size: usize;
                if dimension == 1 {
                    // BUFFER: allocate real committed pages in VMM so Map() returns a direct guest pointer!
                    byte_size = (width as usize).max(256);
                    let va = self.next_gpu_va;
                    let aligned_span = VirtualMemoryManager::align_up(byte_size as u64);
                    self.next_gpu_va = (va + aligned_span + 0xFFFF) & !0xFFFF;
                    vmm.map_region(va, aligned_span, PAGE_READWRITE, MEM_COMMIT, MEM_PRIVATE, false);
                    guest_va = va;
                } else {
                    let px_count = (width as usize).saturating_mul(height as usize).max(1);
                    byte_size = px_count * 4;
                    let init_px = if clear_val_ptr != 0 {
                        let cv_fmt = vmm.read_u32(clear_val_ptr).unwrap_or(format);
                        let c0 = f32::from_bits(vmm.read_u32(clear_val_ptr + 4).unwrap_or(0));
                        let c1 = f32::from_bits(vmm.read_u32(clear_val_ptr + 8).unwrap_or(0));
                        let c2 = f32::from_bits(vmm.read_u32(clear_val_ptr + 12).unwrap_or(0));
                        let c3 = f32::from_bits(vmm.read_u32(clear_val_ptr + 16).unwrap_or(0));
                        Self::pack_pixel(if cv_fmt != 0 { cv_fmt } else { format }, [c0, c1, c2, c3])
                    } else {
                        0
                    };
                    texels_u32 = vec![init_px; px_count];
                }

                let res_ptr = self.create_com_object(vmm, ComKind::D3d12Resource, this);
                if let Some(r_obj) = self.objects.get_mut(&res_ptr) {
                    r_obj.resource = Some(ResourceData {
                        dimension,
                        width,
                        height,
                        depth_or_array: depth,
                        mip_levels: mips,
                        format,
                        flags,
                        heap_type,
                        guest_va,
                        byte_size,
                        texels_u32,
                        swapchain_owner: None,
                    });
                }
                let _ = vmm.write_u64(out_res, res_ptr);
                S_OK as u64
            }
            (ComKind::D3d12Device, 36) => {
                // CreateFence(this, InitialValue, Flags, riid, ppFence)
                let init_val = args[1];
                let out_fence = args[4];
                if out_fence == 0 {
                    return E_INVALIDARG as u64;
                }
                let f_ptr = self.create_com_object(vmm, ComKind::D3d12Fence, this);
                if let Some(f_obj) = self.objects.get_mut(&f_ptr) {
                    f_obj.fence_value = init_val;
                }
                let _ = vmm.write_u64(out_fence, f_ptr);
                S_OK as u64
            }
            (ComKind::D3d12Device, 37) => S_OK as u64, // GetDeviceRemovedReason
            (ComKind::D3d12Device, 38) => {
                // GetCopyableFootprints(this, pResourceDesc, FirstSubresource, NumSubresources, BaseOffset, pLayouts, pNumRows, pRowSizeInBytes, pTotalBytes)
                let desc_ptr = args[1];
                let base_offset = args[4];
                let layouts_ptr = args[5];
                let num_rows_ptr = args[6];
                let row_size_ptr = args[7];
                let total_bytes_ptr = args[8];
                let width = vmm.read_u64(desc_ptr + 16).unwrap_or(32) as u32;
                let height = vmm.read_u32(desc_ptr + 24).unwrap_or(32);
                let format = vmm.read_u32(desc_ptr + 32).unwrap_or(DXGI_FORMAT_B8G8R8A8_UNORM);
                let row_bytes = width * 4;
                let row_pitch = (row_bytes + 255) & !255;
                let total = (row_pitch as u64) * (height.saturating_sub(1) as u64) + (row_bytes as u64);
                if layouts_ptr != 0 {
                    let _ = vmm.write_u64(layouts_ptr, base_offset);
                    let _ = vmm.write_u32(layouts_ptr + 8, format);
                    let _ = vmm.write_u32(layouts_ptr + 12, width);
                    let _ = vmm.write_u32(layouts_ptr + 16, height);
                    let _ = vmm.write_u32(layouts_ptr + 20, 1);
                    let _ = vmm.write_u32(layouts_ptr + 24, row_pitch);
                }
                if num_rows_ptr != 0 {
                    let _ = vmm.write_u32(num_rows_ptr, height);
                }
                if row_size_ptr != 0 {
                    let _ = vmm.write_u64(row_size_ptr, row_bytes as u64);
                }
                if total_bytes_ptr != 0 {
                    let _ = vmm.write_u64(total_bytes_ptr, base_offset + total);
                }
                0
            }
            (ComKind::D3d12Device, 43) => {
                // GetAdapterLuid(This, RetPtr) -> returns RetPtr!
                let ret_ptr = args[1];
                if ret_ptr != 0 {
                    let _ = vmm.write_u32(ret_ptr, ADAPTER_LUID_LOW);
                    let _ = vmm.write_u32(ret_ptr + 4, ADAPTER_LUID_HIGH);
                }
                ret_ptr
            }

            // ID3D12CommandQueue
            (ComKind::D3d12CommandQueue, 7) => {
                let dev = self.objects.get(&this).map(|o| o.parent_device).unwrap_or(0);
                if args[2] != 0 && dev != 0 {
                    self.add_ref(dev);
                    let _ = vmm.write_u64(args[2], dev);
                }
                S_OK as u64
            }
            (ComKind::D3d12CommandQueue, 10) => {
                // ExecuteCommandLists(this, NumCommandLists, ppCommandLists)
                let num = args[1] as usize;
                let arr_ptr = args[2];
                for i in 0..num.min(64) {
                    let cl_ptr = vmm.read_u64(arr_ptr + (i as u64) * 8).unwrap_or(0);
                    if cl_ptr != 0 {
                        self.execute_command_list(vmm, cl_ptr);
                    }
                }
                0
            }
            (ComKind::D3d12CommandQueue, 14) => {
                // Signal(this, pFence, Value)
                let fence_ptr = args[1];
                let val = args[2];
                if let Some(f_obj) = self.objects.get_mut(&fence_ptr) {
                    f_obj.fence_value = val;
                }
                S_OK as u64
            }
            (ComKind::D3d12CommandQueue, 15) => S_OK as u64, // Wait
            (ComKind::D3d12CommandQueue, 16) => {
                if args[1] != 0 {
                    let _ = vmm.write_u64(args[1], 1_000_000_000);
                }
                S_OK as u64
            }
            (ComKind::D3d12CommandQueue, 18) => {
                // GetDesc(This, RetPtr) -> returns RetPtr!
                let ret_ptr = args[1];
                let q_type = self.objects.get(&this).map(|o| o.queue_type).unwrap_or(0);
                if ret_ptr != 0 {
                    let _ = vmm.write_u32(ret_ptr, q_type);
                    let _ = vmm.write_u32(ret_ptr + 4, 0);
                    let _ = vmm.write_u32(ret_ptr + 8, 0);
                    let _ = vmm.write_u32(ret_ptr + 12, 0);
                }
                ret_ptr
            }

            // ID3D12CommandAllocator
            (ComKind::D3d12CommandAllocator, 8) => S_OK as u64, // Reset

            // ID3D12DescriptorHeap
            (ComKind::D3d12DescriptorHeap, 8) => {
                let ret_ptr = args[1];
                if let Some(h) = self.objects.get(&this) {
                    if ret_ptr != 0 {
                        let _ = vmm.write_u32(ret_ptr, h.heap_type);
                        let _ = vmm.write_u32(ret_ptr + 4, h.heap_num_desc);
                        let _ = vmm.write_u32(ret_ptr + 8, 0);
                        let _ = vmm.write_u32(ret_ptr + 12, 0);
                    }
                }
                ret_ptr
            }
            (ComKind::D3d12DescriptorHeap, 9) => {
                // GetCPUDescriptorHandleForHeapStart(This, RetPtr) -> returns RetPtr!
                let ret_ptr = args[1];
                let start = self.objects.get(&this).map(|o| o.heap_cpu_start).unwrap_or(0);
                if ret_ptr != 0 {
                    let _ = vmm.write_u64(ret_ptr, start);
                }
                ret_ptr
            }
            (ComKind::D3d12DescriptorHeap, 10) => {
                let ret_ptr = args[1];
                let start = self.objects.get(&this).map(|o| o.heap_gpu_start).unwrap_or(0);
                if ret_ptr != 0 {
                    let _ = vmm.write_u64(ret_ptr, start);
                }
                ret_ptr
            }

            // ID3D12Resource
            (ComKind::D3d12Resource, 8) => {
                // Map(this, Subresource, pReadRange, ppData)
                let pp_data = args[3];
                let va = self
                    .objects
                    .get(&this)
                    .and_then(|o| o.resource.as_ref().map(|r| r.guest_va))
                    .unwrap_or(0);
                if va == 0 {
                    return E_INVALIDARG as u64;
                }
                if pp_data != 0 {
                    let _ = vmm.write_u64(pp_data, va);
                }
                S_OK as u64
            }
            (ComKind::D3d12Resource, 9) => 0, // Unmap
            (ComKind::D3d12Resource, 10) => {
                // GetDesc(This, RetPtr) -> returns RetPtr (56 bytes)!
                let ret_ptr = args[1];
                if ret_ptr != 0 {
                    let zero = [0u8; 56];
                    let _ = vmm.write_bytes(ret_ptr, &zero);
                    if let Some(res) = self.objects.get(&this).and_then(|o| o.resource.as_ref()) {
                        let _ = vmm.write_u32(ret_ptr, res.dimension);
                        let _ = vmm.write_u64(ret_ptr + 8, 0);
                        let _ = vmm.write_u64(ret_ptr + 16, res.width);
                        let _ = vmm.write_u32(ret_ptr + 24, res.height);
                        let _ = vmm.write_u16(ret_ptr + 28, res.depth_or_array);
                        let _ = vmm.write_u16(ret_ptr + 30, res.mip_levels);
                        let _ = vmm.write_u32(ret_ptr + 32, res.format);
                        let _ = vmm.write_u32(ret_ptr + 36, 1); // SampleDesc.Count
                        let _ = vmm.write_u32(ret_ptr + 40, 0); // SampleDesc.Quality
                        let _ = vmm.write_u32(ret_ptr + 44, if res.dimension == 1 { 1 } else { 0 });
                        let _ = vmm.write_u32(ret_ptr + 52, res.flags);
                    }
                }
                ret_ptr
            }
            (ComKind::D3d12Resource, 11) => self
                .objects
                .get(&this)
                .and_then(|o| o.resource.as_ref().map(|r| r.guest_va))
                .unwrap_or(0),

            // ID3D12Fence
            (ComKind::D3d12Fence, 8) => {
                self.objects.get(&this).map(|o| o.fence_value).unwrap_or(0)
            }
            (ComKind::D3d12Fence, 9) => {
                // SetEventOnCompletion(this, Value, hEvent)
                let target_val = args[1];
                let h_event = args[2];
                let cur = self.objects.get(&this).map(|o| o.fence_value).unwrap_or(0);
                if cur >= target_val && h_event != 0 {
                    signal_win32_event(h_event);
                }
                S_OK as u64
            }
            (ComKind::D3d12Fence, 10) => {
                if let Some(f_obj) = self.objects.get_mut(&this) {
                    f_obj.fence_value = args[1];
                }
                S_OK as u64
            }

            // ID3D12GraphicsCommandList
            (ComKind::D3d12CommandList, 8) => self
                .objects
                .get(&this)
                .map(|o| o.cmd_list_type as u64)
                .unwrap_or(0),
            (ComKind::D3d12CommandList, 9) => {
                if let Some(cl) = self.objects.get_mut(&this) {
                    if !cl.cmd_list_open {
                        return E_FAIL as u64;
                    }
                    cl.cmd_list_open = false;
                }
                S_OK as u64
            }
            (ComKind::D3d12CommandList, 10) => {
                // Reset(this, pAllocator, pInitialState)
                let init_pso = args[2];
                if let Some(cl) = self.objects.get_mut(&this) {
                    cl.recorded_cmds.clear();
                    cl.cmd_list_open = true;
                    if init_pso != 0 {
                        cl.recorded_cmds
                            .push(GpuCommand::SetPipelineState { pso_ptr: init_pso });
                    }
                }
                S_OK as u64
            }
            (ComKind::D3d12CommandList, 11) => {
                if let Some(cl) = self.objects.get_mut(&this) {
                    cl.recorded_cmds.clear();
                }
                0
            }
            (ComKind::D3d12CommandList, 12) => {
                // DrawInstanced(this, VertexCountPerInstance, InstanceCount, StartVertexLocation, StartInstanceLocation)
                let vc = args[1] as u32;
                let ic = args[2] as u32;
                if let Some(cl) = self.objects.get_mut(&this) {
                    cl.recorded_cmds.push(GpuCommand::DrawInstanced {
                        vertex_count: vc,
                        instance_count: ic,
                    });
                }
                0
            }
            (ComKind::D3d12CommandList, 13) => {
                let ic = args[1] as u32;
                let inst = args[2] as u32;
                if let Some(cl) = self.objects.get_mut(&this) {
                    cl.recorded_cmds.push(GpuCommand::DrawInstanced {
                        vertex_count: ic,
                        instance_count: inst,
                    });
                }
                0
            }
            (ComKind::D3d12CommandList, 15) => {
                // CopyBufferRegion
                let cmd = GpuCommand::CopyBufferRegion {
                    dst_res: args[1],
                    dst_offset: args[2],
                    src_res: args[3],
                    src_offset: args[4],
                    num_bytes: args[5],
                };
                if let Some(cl) = self.objects.get_mut(&this) {
                    cl.recorded_cmds.push(cmd);
                }
                0
            }
            (ComKind::D3d12CommandList, 16) => {
                // CopyTextureRegion(this, pDst, DstX, DstY, DstZ, pSrc, pSrcBox)
                let dst_loc = args[1];
                let src_loc = args[5];
                if dst_loc != 0 && src_loc != 0 {
                    // COPY_LOC: pResource@0, Type@8, PlacedFootprint@16 (Offset@16, Format@24, Width@28, Height@32, Depth@36, RowPitch@40)
                    let dst_res = vmm.read_u64(dst_loc).unwrap_or(0);
                    let dst_type = vmm.read_u32(dst_loc + 8).unwrap_or(0);
                    let dst_offset = vmm.read_u64(dst_loc + 16).unwrap_or(0);
                    let dst_width = vmm.read_u32(dst_loc + 28).unwrap_or(0);
                    let dst_height = vmm.read_u32(dst_loc + 32).unwrap_or(0);
                    let dst_row_pitch = vmm.read_u32(dst_loc + 40).unwrap_or(0);

                    let src_res = vmm.read_u64(src_loc).unwrap_or(0);
                    let src_type = vmm.read_u32(src_loc + 8).unwrap_or(0);
                    let src_offset = vmm.read_u64(src_loc + 16).unwrap_or(0);
                    let src_row_pitch = vmm.read_u32(src_loc + 40).unwrap_or(0);

                    if let Some(cl) = self.objects.get_mut(&this) {
                        cl.recorded_cmds.push(GpuCommand::CopyTextureRegion {
                            dst_res,
                            dst_type,
                            dst_offset,
                            dst_row_pitch,
                            dst_width,
                            dst_height,
                            src_res,
                            src_type,
                            src_offset,
                            src_row_pitch,
                        });
                    }
                }
                0
            }
            (ComKind::D3d12CommandList, 17) => {
                if let Some(cl) = self.objects.get_mut(&this) {
                    cl.recorded_cmds.push(GpuCommand::CopyResource {
                        dst_res: args[1],
                        src_res: args[2],
                    });
                }
                0
            }
            (ComKind::D3d12CommandList, 21) => {
                // RSSetViewports(this, NumViewports, pViewports)
                let num = args[1] as usize;
                let vp_ptr = args[2];
                if num > 0 && vp_ptr != 0 {
                    let x = f32::from_bits(vmm.read_u32(vp_ptr).unwrap_or(0));
                    let y = f32::from_bits(vmm.read_u32(vp_ptr + 4).unwrap_or(0));
                    let w = f32::from_bits(vmm.read_u32(vp_ptr + 8).unwrap_or(0));
                    let h = f32::from_bits(vmm.read_u32(vp_ptr + 12).unwrap_or(0));
                    if let Some(cl) = self.objects.get_mut(&this) {
                        cl.recorded_cmds
                            .push(GpuCommand::SetViewport { x, y, w, h });
                    }
                }
                0
            }
            (ComKind::D3d12CommandList, 22) => {
                // RSSetScissorRects(this, NumRects, pRects)
                let num = args[1] as usize;
                let rect_ptr = args[2];
                if num > 0 && rect_ptr != 0 {
                    let left = vmm.read_u32(rect_ptr).unwrap_or(0) as i32;
                    let top = vmm.read_u32(rect_ptr + 4).unwrap_or(0) as i32;
                    let right = vmm.read_u32(rect_ptr + 8).unwrap_or(0) as i32;
                    let bottom = vmm.read_u32(rect_ptr + 12).unwrap_or(0) as i32;
                    if let Some(cl) = self.objects.get_mut(&this) {
                        cl.recorded_cmds.push(GpuCommand::SetScissor {
                            left,
                            top,
                            right,
                            bottom,
                        });
                    }
                }
                0
            }
            (ComKind::D3d12CommandList, 25) => {
                if let Some(cl) = self.objects.get_mut(&this) {
                    cl.recorded_cmds
                        .push(GpuCommand::SetPipelineState { pso_ptr: args[1] });
                }
                0
            }
            (ComKind::D3d12CommandList, 33) | (ComKind::D3d12CommandList, 34) => {
                // SetComputeRoot32BitConstant / SetGraphicsRoot32BitConstant
                let root_idx = args[1] as u32;
                let src_data = args[2] as u32;
                let dest_off = args[3] as u32;
                if let Some(cl) = self.objects.get_mut(&this) {
                    cl.recorded_cmds.push(GpuCommand::SetRoot32BitConstants {
                        root_index: root_idx,
                        num_values: 1,
                        dest_offset: dest_off,
                        values: vec![src_data],
                    });
                }
                0
            }
            (ComKind::D3d12CommandList, 35) | (ComKind::D3d12CommandList, 36) => {
                // SetComputeRoot32BitConstants / SetGraphicsRoot32BitConstants(this, RootParameterIndex, Num32BitValuesToSet, pSrcData, DestOffsetIn32BitValues)
                let root_idx = args[1] as u32;
                let count = (args[2] as usize).min(64);
                let src_ptr = args[3];
                let dest_off = args[4] as u32;
                let mut vals = Vec::with_capacity(count);
                for i in 0..count {
                    vals.push(vmm.read_u32(src_ptr + (i as u64) * 4).unwrap_or(0));
                }
                if let Some(cl) = self.objects.get_mut(&this) {
                    cl.recorded_cmds.push(GpuCommand::SetRoot32BitConstants {
                        root_index: root_idx,
                        num_values: count as u32,
                        dest_offset: dest_off,
                        values: vals,
                    });
                }
                0
            }
            (ComKind::D3d12CommandList, 46) => {
                // OMSetRenderTargets(this, NumRenderTargetDescriptors, pRenderTargetDescriptors, RTsSingleHandleToDescriptorRange, pDepthStencilDescriptor)
                let num = (args[1] as usize).min(8);
                let ptr = args[2];
                let single_range = args[3] as u32 != 0;
                let mut rtvs = Vec::with_capacity(num);
                if ptr != 0 && num > 0 {
                    if single_range {
                        let base = vmm.read_u64(ptr).unwrap_or(0);
                        for i in 0..num {
                            rtvs.push(base + (i as u64) * 32);
                        }
                    } else {
                        for i in 0..num {
                            rtvs.push(vmm.read_u64(ptr + (i as u64) * 8).unwrap_or(0));
                        }
                    }
                }
                if let Some(cl) = self.objects.get_mut(&this) {
                    cl.recorded_cmds
                        .push(GpuCommand::SetRenderTargets { rtv_ptrs: rtvs });
                }
                0
            }
            (ComKind::D3d12CommandList, 48) => {
                // ClearRenderTargetView(this, RenderTargetView, ColorRGBA, NumRects, pRects)
                // Note: D3D12_CPU_DESCRIPTOR_HANDLE is a 1-field struct { SIZE_T ptr }; on MS x64 ABI an 8-byte struct is passed by VALUE in RDX!
                let rtv_ptr = args[1];
                let rgba_ptr = args[2];
                let mut color = [0.0f32; 4];
                if rgba_ptr != 0 {
                    for i in 0..4 {
                        color[i] = f32::from_bits(vmm.read_u32(rgba_ptr + (i as u64) * 4).unwrap_or(0));
                    }
                }
                if let Some(cl) = self.objects.get_mut(&this) {
                    cl.recorded_cmds
                        .push(GpuCommand::ClearRtv { rtv_ptr, color });
                }
                0
            }
            (ComKind::D3d12CommandList, _) => 0,

            // Nothing implemented this method. Returning S_OK here used to hide the failure from
            // the guest *and* from the trace: a game would carry on with an uninitialised object
            // and die later somewhere unrelated. E_NOTIMPL is what a real driver returns for an
            // unsupported entry point, and it shows up in the unimplemented-method list.
            _ => E_NOTIMPL as u64,
        }
    }
}
