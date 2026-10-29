#define WIN32_LEAN_AND_MEAN
#include <windows.h>
unsigned long _tls_index;
static DWORD attached;
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID reserved){
 if(reason==DLL_PROCESS_ATTACH){attached++;
#ifdef ATTACH_FAIL
 return FALSE;
#endif
 }
 return TRUE;
}
__declspec(dllexport) DWORD AttachCount(void) __asm__("AttachCount");
__declspec(dllexport) DWORD AttachCount(void){return attached;}
