#include "common.h"
/* Host injects these exact signed deltas; no DOM and no test-only DLL import. */
void mainCRTStartup(void) {
    REQUIRE(GetErrorMode()==0);REQUIRE(SetErrorMode(SEM_NOOPENFILEERRORBOX)==0);REQUIRE(GetErrorMode()==SEM_NOOPENFILEERRORBOX);REQUIRE(SetErrorMode(SEM_FAILCRITICALERRORS)==SEM_NOOPENFILEERRORBOX);REQUIRE(GetErrorMode()==SEM_FAILCRITICALERRORS);SetErrorMode(0);
    REQUIRE((GetAsyncKeyState(VK_SHIFT)&0xffff)==0x8001);
    REQUIRE((GetAsyncKeyState(VK_SHIFT)&0xffff)==0x8000);
    REQUIRE(GetAsyncKeyState(VK_CONTROL)==0);
    SetLastError(0);REQUIRE(SendMessageA(0,WM_SETFONT,0,0)==0);REQUIRE(GetLastError()==ERROR_INVALID_WINDOW_HANDLE);
    HWND desktop=GetDesktopWindow();RECT desktopRect;REQUIRE(desktop!=0 && GetWindowRect(desktop,&desktopRect));REQUIRE(desktopRect.right==GetSystemMetrics(SM_CXSCREEN) && desktopRect.bottom==GetSystemMetrics(SM_CYSCREEN));
    SetLastError(0);REQUIRE(!GetWindowRect(0,&desktopRect));REQUIRE(GetLastError()==ERROR_INVALID_WINDOW_HANDLE);
    REQUIRE(IsWindow(desktop) && !IsWindow(0) && !IsWindow((HWND)0xdeadbeef));
    RECT workArea;REQUIRE(SystemParametersInfoA(SPI_GETWORKAREA,0,&workArea,0));REQUIRE(workArea.left==0 && workArea.top==0 && workArea.right==desktopRect.right && workArea.bottom==desktopRect.bottom);
    REQUIRE(!SystemParametersInfoA(0xffff,0,0,0));REQUIRE(GetLastError()==ERROR_NOT_SUPPORTED);
    REQUIRE(GetFileAttributesA("input-test.exe")==FILE_ATTRIBUTE_NORMAL);REQUIRE(GetFileAttributesA(".")==FILE_ATTRIBUTE_DIRECTORY);REQUIRE(GetFileAttributesA("")==INVALID_FILE_ATTRIBUTES);REQUIRE(GetLastError()==ERROR_INVALID_NAME);REQUIRE(GetFileAttributesA("missing-porthole-test-file")==INVALID_FILE_ATTRIBUTES);REQUIRE(GetLastError()==ERROR_FILE_NOT_FOUND);
    char found[256];char *filePart=0;DWORD foundSize=SearchPathA(0,"input-test",".exe",sizeof(found),found,&filePart);REQUIRE(foundSize>0 && foundSize<sizeof(found) && filePart && filePart[0]=='i');
    REQUIRE(SearchPathA(0,"input-test.exe",0,0,0,0)==foundSize+1);
    REQUIRE(SearchPathA(0,"definitely-missing-porthole-file",0,sizeof(found),found,0)==0);REQUIRE(GetLastError()==ERROR_FILE_NOT_FOUND);
    char previousDir[512];DWORD cwdSize=GetCurrentDirectoryA(sizeof(previousDir),previousDir);REQUIRE(cwdSize>0&&cwdSize<sizeof(previousDir));REQUIRE(GetCurrentDirectoryA(0,0)==cwdSize+1);
    REQUIRE(CreateDirectoryA("cwd-probe",0));REQUIRE(SetCurrentDirectoryA("cwd-probe"));
    HANDLE marker=CreateFileA("marker.dat",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);REQUIRE(marker!=INVALID_HANDLE_VALUE);REQUIRE(CloseHandle(marker));REQUIRE(GetFileAttributesA("marker.dat")==FILE_ATTRIBUTE_NORMAL);
    REQUIRE(!SetCurrentDirectoryA("marker.dat")&&GetLastError()==ERROR_DIRECTORY);REQUIRE(!SetCurrentDirectoryA("missing")&&GetLastError()==ERROR_PATH_NOT_FOUND);REQUIRE(SetCurrentDirectoryA(previousDir));
    REQUIRE(GetFileAttributesA("cwd-probe\\marker.dat")==FILE_ATTRIBUTE_NORMAL);
    RAWINPUTDEVICE dev={1,2,0,0};
    REQUIRE(RegisterRawInputDevices(&dev,1,sizeof(dev)));
    const LONG dx[3]={10,-5,20}, dy[3]={5,15,-10};
    MSG msg; int received=0;
    while(PeekMessageA(&msg,0,0,0,PM_REMOVE)) {
        if(msg.message!=WM_INPUT) continue;
        REQUIRE(received<3);
        UINT size=0;
        REQUIRE(GetRawInputData((HRAWINPUT)msg.lParam,RID_INPUT,0,&size,sizeof(RAWINPUTHEADER))==0);
        REQUIRE(size==40);
        RAWINPUT raw;size=sizeof(raw);
        REQUIRE(GetRawInputData((HRAWINPUT)msg.lParam,RID_INPUT,&raw,&size,sizeof(RAWINPUTHEADER))==40);
        REQUIRE(raw.header.dwType==RIM_TYPEMOUSE);
        REQUIRE(raw.data.mouse.lLastX==dx[received] && raw.data.mouse.lLastY==dy[received]);
        received++; SAY("RAW_DELTA_VERIFIED\n");
    }
    REQUIRE(received==3); SAY("SUCCESS: 3 injected mouse events (synthetic, not physical)\n");ExitProcess(0);
}
