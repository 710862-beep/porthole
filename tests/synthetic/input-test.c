#include "common.h"
/* Host injects these exact signed deltas; no DOM and no test-only DLL import. */
void mainCRTStartup(void) {
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
