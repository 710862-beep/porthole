#include "common.h"
static void write_file(const char *name,const char *data,DWORD len) {
    HANDLE h=CreateFileA(name,GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0); REQUIRE(h!=INVALID_HANDLE_VALUE);
    DWORD written; REQUIRE(WriteFile(h,data,len,&written,0) && written==len); REQUIRE(CloseHandle(h));
}
static void directory(const char *name) { REQUIRE(CreateDirectoryA(name,0) || GetLastError()==ERROR_ALREADY_EXISTS); }
void mainCRTStartup(void) {
    directory("C:\\Program Files"); directory("C:\\Program Files\\TestApp");
    write_file("C:\\Program Files\\TestApp\\test.txt","synthetic data\n",15);
    /* Marker only: not an executable uninstaller and never reported as one. */
    write_file("C:\\Program Files\\TestApp\\uninstall.exe","",0);
    HKEY key; DWORD disposition;
    REQUIRE(RegCreateKeyExA(HKEY_LOCAL_MACHINE,"Software\\TestApp",0,0,0,KEY_ALL_ACCESS,0,&key,&disposition)==0);
    const char location[]="C:\\Program Files\\TestApp";
    REQUIRE(RegSetValueExA(key,"InstallPath",0,REG_SZ,(const BYTE*)location,sizeof(location))==0); RegCloseKey(key);
    SAY("SUCCESS (requires host persistence verification)\n"); ExitProcess(0);
}
