#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include "common.h"
void mainCRTStartup(void) {
    WSADATA data; REQUIRE(WSAStartup(MAKEWORD(2,2),&data)==0);
    struct hostent *host=gethostbyname("localhost");REQUIRE(host && host->h_addrtype==AF_INET && host->h_length==4 && host->h_addr_list[0] && !host->h_addr_list[1]);
    REQUIRE((BYTE)host->h_addr_list[0][0]==127);
    struct addrinfo hints={0}, *addr=0; hints.ai_family=AF_INET; hints.ai_socktype=SOCK_STREAM;
    const char *service=GetCommandLineA();while(*service && *service!=' ')service++;REQUIRE(*service==' ');service++;
    REQUIRE(getaddrinfo("localhost",service,&hints,&addr)==0);
    SOCKET s=socket(addr->ai_family,addr->ai_socktype,addr->ai_protocol); REQUIRE(s!=INVALID_SOCKET);
    REQUIRE(connect(s,addr->ai_addr,(int)addr->ai_addrlen)==0); freeaddrinfo(addr);
    const char request[]="GET / HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    int sent=0; while (sent<sizeof(request)-1) { int n=send(s,request+sent,sizeof(request)-1-sent,0); REQUIRE(n>0); sent+=n; }
    char buffer[512]; int used=0;
    while(used<sizeof(buffer)) { int n=recv(s,buffer+used,sizeof(buffer)-used,0); REQUIRE(n>=0); if(n==0)break; used+=n; }
    REQUIRE(used>=5);
    int marker=0;for(int i=0;i+19<=used;i++){const char expected[]="PORTHOLE_NETWORK_OK";int j=0;while(j<19 && buffer[i+j]==expected[j])j++;if(j==19)marker=1;} REQUIRE(marker);
    REQUIRE(buffer[0]=='H' && buffer[1]=='T' && buffer[2]=='T' && buffer[3]=='P' && buffer[4]=='/'); out(buffer,used);
    closesocket(s); WSACleanup(); SAY("\nSUCCESS\n"); ExitProcess(0);
}
