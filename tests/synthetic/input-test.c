#include "common.h"
static void signed_number(LONG value) {
    char buffer[12]; int end=12, start=end; DWORD magnitude;
    if(value<0) { SAY("-"); magnitude=0-(DWORD)value; } else magnitude=(DWORD)value;
    do { buffer[--start]=(char)('0'+magnitude%10); magnitude/=10; } while(magnitude);
    out(buffer+start,(DWORD)(end-start));
}
static LRESULT CALLBACK procedure(HWND hwnd, UINT msg, WPARAM w, LPARAM l) {
    if (msg==WM_INPUT) {
        RAWINPUT raw; UINT size=sizeof(raw);
        REQUIRE(GetRawInputData((HRAWINPUT)l,RID_INPUT,&raw,&size,sizeof(RAWINPUTHEADER))!=(UINT)-1);
        if (raw.header.dwType==RIM_TYPEMOUSE && (raw.data.mouse.lLastX || raw.data.mouse.lLastY)) {
            SAY("DX="); signed_number(raw.data.mouse.lLastX); SAY(" DY="); signed_number(raw.data.mouse.lLastY); SAY("\n");
        }
    }
    if (msg==WM_DESTROY) { ClipCursor(0); PostQuitMessage(0); return 0; }
    return DefWindowProcA(hwnd,msg,w,l);
}
void mainCRTStartup(void) {
    WNDCLASSA cls={0}; cls.lpfnWndProc=procedure; cls.lpszClassName="PortholeInput";
    REQUIRE(RegisterClassA(&cls));
    HWND hwnd=CreateWindowExA(0,cls.lpszClassName,"Synthetic Input",WS_OVERLAPPEDWINDOW,0,0,640,480,0,0,0,0);
    REQUIRE(hwnd); ShowWindow(hwnd,SW_SHOW);
    RAWINPUTDEVICE dev={1,2,0,hwnd}; REQUIRE(RegisterRawInputDevices(&dev,1,sizeof(dev)));
    RECT rect; REQUIRE(GetClientRect(hwnd,&rect)); MapWindowPoints(hwnd,0,(POINT*)&rect,2); REQUIRE(ClipCursor(&rect));
    SAY("INPUT_READY (requires real mouse and browser activation)\n");
    MSG msg; int rc; while ((rc=GetMessageA(&msg,0,0,0))>0) { TranslateMessage(&msg); DispatchMessageA(&msg); }
    REQUIRE(rc==0); ExitProcess(0);
}
