#include "common.h"
static HANDLE mutexHandle;
static DWORD WINAPI mutexWorker(LPVOID ignored){REQUIRE(WaitForSingleObject(mutexHandle,0)==WAIT_TIMEOUT);REQUIRE(!ReleaseMutex(mutexHandle)&&GetLastError()==ERROR_NOT_OWNER);return 0;}
static DWORD WINAPI abandoningWorker(LPVOID ignored){REQUIRE(WaitForSingleObject(mutexHandle,0)==WAIT_OBJECT_0);return 0;}
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
    mutexHandle=CreateMutexA(0,TRUE,"PortholeMutex");REQUIRE(mutexHandle&&GetLastError()==0);
    HANDLE alias=CreateMutexA(0,FALSE,"PortholeMutex");REQUIRE(alias&&GetLastError()==ERROR_ALREADY_EXISTS);
    REQUIRE(WaitForSingleObject(alias,0)==WAIT_OBJECT_0);REQUIRE(ReleaseMutex(alias));
    HANDLE probe=CreateThread(0,0,mutexWorker,0,0,0);REQUIRE(probe);REQUIRE(WaitForSingleObject(probe,1000)==WAIT_OBJECT_0);CloseHandle(probe);
    REQUIRE(ReleaseMutex(mutexHandle));REQUIRE(!ReleaseMutex(mutexHandle)&&GetLastError()==ERROR_NOT_OWNER);
    probe=CreateThread(0,0,abandoningWorker,0,0,0);REQUIRE(probe);REQUIRE(WaitForSingleObject(probe,1000)==WAIT_OBJECT_0);CloseHandle(probe);
    REQUIRE(WaitForSingleObject(alias,0)==WAIT_ABANDONED);REQUIRE(ReleaseMutex(alias));REQUIRE(CloseHandle(alias)&&CloseHandle(mutexHandle));
    HANDLE threads[3];
    slot=TlsAlloc(); REQUIRE(slot!=TLS_OUT_OF_INDEXES);
    for (int i=0;i<3;i++) { threads[i]=CreateThread(0,0,worker,(LPVOID)(ULONG_PTR)(i+1),0,0); REQUIRE(threads[i]!=0); }
    REQUIRE(WaitForMultipleObjects(3,threads,TRUE,10000)==WAIT_OBJECT_0);
    REQUIRE(completed==3);
    for (int i=0;i<3;i++) CloseHandle(threads[i]);
    TlsFree(slot); SAY("SUCCESS\n"); ExitProcess(0);
}
