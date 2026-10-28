#include "common.h"
void mainCRTStartup(void) {
    FILETIME original={0,0},local,back;SYSTEMTIME oldEpoch;
    REQUIRE(FileTimeToSystemTime(&original,&oldEpoch)&&oldEpoch.wYear==1601&&oldEpoch.wMonth==1&&oldEpoch.wDay==1);
    original.dwLowDateTime=0xd53e8000;original.dwHighDateTime=0x019db1de;
    REQUIRE(FileTimeToLocalFileTime(&original,&local));REQUIRE(LocalFileTimeToFileTime(&local,&back));REQUIRE(back.dwLowDateTime==original.dwLowDateTime&&back.dwHighDateTime==original.dwHighDateTime);
    REQUIRE(!FileTimeToLocalFileTime(0,&local)&&GetLastError()==ERROR_INVALID_PARAMETER);
    WCHAR converted[]={L'A',0x20ac,0};char encoded[16];BOOL used=TRUE;
    REQUIRE(WideCharToMultiByte(1252,0,converted,-1,0,0,0,0)==3);
    REQUIRE(WideCharToMultiByte(1252,0,converted,-1,encoded,sizeof(encoded),0,&used)==3&&!used&&(BYTE)encoded[1]==0x80&&encoded[2]==0);
    REQUIRE(!WideCharToMultiByte(1252,0,converted,-1,encoded,2,0,0)&&GetLastError()==ERROR_INSUFFICIENT_BUFFER);
    WCHAR emoji[]={0xd83d,0xde00};REQUIRE(WideCharToMultiByte(CP_UTF8,0,emoji,2,encoded,sizeof(encoded),0,0)==4&&(BYTE)encoded[0]==0xf0);
    REQUIRE(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,emoji,1,encoded,sizeof(encoded),0,0)&&GetLastError()==ERROR_NO_UNICODE_TRANSLATION);
    char user[32];DWORD length=1;user[0]='!';REQUIRE(!GetUserNameA(user,&length));REQUIRE(length==9&&GetLastError()==ERROR_INSUFFICIENT_BUFFER&&user[0]=='!');
    REQUIRE(SetEnvironmentVariableA("WINEUSERNAME","Miner"));length=sizeof(user);REQUIRE(GetUserNameA(user,&length)&&length==6&&user[0]=='M'&&user[4]=='r'&&user[5]==0);
    WCHAR userW[16];length=16;REQUIRE(GetUserNameW(userW,&length)&&length==6&&userW[0]==L'M'&&userW[5]==0);
    REQUIRE(GetEnvironmentVariableA("wineusername",user,0)==6);REQUIRE(SetEnvironmentVariableA("WINEUSERNAME",0));length=sizeof(user);REQUIRE(!GetUserNameA(user,&length));REQUIRE(GetLastError()==ERROR_ENVVAR_NOT_FOUND);REQUIRE(SetEnvironmentVariableA("WINEUSERNAME","Porthole"));
    REQUIRE(GetEnvironmentVariableA("WINDIR",user,sizeof(user))==10&&user[2]=='\\'&&user[3]=='W');
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
