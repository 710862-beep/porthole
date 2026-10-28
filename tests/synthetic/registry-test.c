#include "common.h"
void mainCRTStartup(void) {
    HKEY key; DWORD disposition; BYTE token[128], readback[128];
    for (int i=0;i<128;i++) token[i]=(BYTE)i; /* artificial data, never a real token */
    REQUIRE(RegCreateKeyExA(HKEY_CURRENT_USER,"Software\\Roblox\\Client",0,0,0,KEY_ALL_ACCESS,0,&key,&disposition)==ERROR_SUCCESS);
    DWORD uid=12345;
    REQUIRE(RegSetValueExA(key,"AuthToken",0,REG_BINARY,token,sizeof(token))==ERROR_SUCCESS);
    REQUIRE(RegSetValueExA(key,"UserId",0,REG_DWORD,(BYTE*)&uid,sizeof(uid))==ERROR_SUCCESS);
    RegCloseKey(key);
    REQUIRE(RegOpenKeyExA(HKEY_CURRENT_USER,"Software\\Roblox\\Client",0,KEY_READ,&key)==ERROR_SUCCESS);
    REQUIRE(RegCloseKey(key)==ERROR_SUCCESS);
    REQUIRE(RegOpenKeyA(HKEY_CURRENT_USER,"Software\\Roblox\\Client",&key)==ERROR_SUCCESS);
    HKEY missing;REQUIRE(RegOpenKeyA(HKEY_CURRENT_USER,"Software\\PortholeMissingKey",&missing)==ERROR_FILE_NOT_FOUND);
    DWORD type=0,size=sizeof(readback);
    REQUIRE(RegQueryValueExA(key,"AuthToken",0,&type,readback,&size)==ERROR_SUCCESS);
    REQUIRE(type==REG_BINARY && size==sizeof(token));
    for(int i=0;i<128;i++) REQUIRE(token[i]==readback[i]);
    size=sizeof(uid); uid=0;
    REQUIRE(RegQueryValueExA(key,"UserId",0,&type,(BYTE*)&uid,&size)==ERROR_SUCCESS);
    REQUIRE(type==REG_DWORD && uid==12345);
    RegCloseKey(key); SAY("SUCCESS (same-process reopen only)\n"); ExitProcess(0);
}
