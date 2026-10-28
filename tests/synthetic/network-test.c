#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include "common.h"
void mainCRTStartup(void) {
    WSADATA data; REQUIRE(WSAStartup(MAKEWORD(2,2),&data)==0);
    struct addrinfo hints={0}, *addr=0; hints.ai_family=AF_INET; hints.ai_socktype=SOCK_STREAM;
    /* github.com is an explicitly permitted host. No proxy/credentials. */
    REQUIRE(getaddrinfo("github.com","80",&hints,&addr)==0);
    SOCKET s=socket(addr->ai_family,addr->ai_socktype,addr->ai_protocol); REQUIRE(s!=INVALID_SOCKET);
    REQUIRE(connect(s,addr->ai_addr,(int)addr->ai_addrlen)==0); freeaddrinfo(addr);
    const char request[]="GET / HTTP/1.0\r\nHost: github.com\r\nConnection: close\r\n\r\n";
    int sent=0; while (sent<sizeof(request)-1) { int n=send(s,request+sent,sizeof(request)-1-sent,0); REQUIRE(n>0); sent+=n; }
    char buffer[512]; int used=0;
    while(used<5) { int n=recv(s,buffer+used,sizeof(buffer)-used,0); REQUIRE(n>0); used+=n; }
    REQUIRE(buffer[0]=='H' && buffer[1]=='T' && buffer[2]=='T' && buffer[3]=='P' && buffer[4]=='/'); out(buffer,used);
    closesocket(s); WSACleanup(); SAY("\nSUCCESS\n"); ExitProcess(0);
}
