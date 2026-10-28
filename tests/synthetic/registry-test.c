#include "common.h"
void mainCRTStartup(void) {
    char user[32];DWORD length=1;user[0]='!';REQUIRE(!GetUserNameA(user,&length));REQUIRE(length==9&&GetLastError()==ERROR_INSUFFICIENT_BUFFER&&user[0]=='!');
    REQUIRE(SetEnvironmentVariableA("WINEUSERNAME","Miner"));length=sizeof(user);REQUIRE(GetUserNameA(user,&length)&&length==6&&user[0]=='M'&&user[4]=='r'&&user[5]==0);
    WCHAR userW[16];length=16;REQUIRE(GetUserNameW(userW,&length)&&length==6&&userW[0]==L'M'&&userW[5]==0);
    REQUIRE(GetEnvironmentVariableA("wineusername",user,0)==6);REQUIRE(SetEnvironmentVariableA("WINEUSERNAME",0));length=sizeof(user);REQUIRE(!GetUserNameA(user,&length));REQUIRE(GetLastError()==ERROR_ENVVAR_NOT_FOUND);REQUIRE(SetEnvironmentVariableA("WINEUSERNAME","Porthole"));
    LPCH env=GetEnvironmentStringsA();REQUIRE(env);REQUIRE(FreeEnvironmentStringsA(env));REQUIRE(!FreeEnvironmentStringsA(env));
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
