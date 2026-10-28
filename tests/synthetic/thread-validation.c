#include "common.h"
static DWORD slot;
static volatile LONG completed;
static DWORD WINAPI worker(LPVOID param) {
    REQUIRE(TlsSetValue(slot, param));
    for (int i=0;i<10;i++) { Sleep(100); REQUIRE(TlsGetValue(slot)==param); }
    InterlockedIncrement(&completed);
    SAY("WORKER_DONE\n");
    return 0;
}
void mainCRTStartup(void) {
    HANDLE threads[3];
    slot=TlsAlloc(); REQUIRE(slot!=TLS_OUT_OF_INDEXES);
    for (int i=0;i<3;i++) { threads[i]=CreateThread(0,0,worker,(LPVOID)(ULONG_PTR)(i+1),0,0); REQUIRE(threads[i]!=0); }
    REQUIRE(WaitForMultipleObjects(3,threads,TRUE,10000)==WAIT_OBJECT_0);
    REQUIRE(completed==3);
    for (int i=0;i<3;i++) CloseHandle(threads[i]);
    TlsFree(slot); SAY("SUCCESS\n"); ExitProcess(0);
}
