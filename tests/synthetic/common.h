/* Porthole-authored synthetic PE fixtures; not Wine/game/application binaries. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static void out(const char *text, DWORD len) { DWORD n; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, len, &n, 0); }
#define SAY(text) out(text, sizeof(text)-1)
#define REQUIRE(expr) do { if (!(expr)) { SAY("FAIL: " #expr "\n"); ExitProcess(1); } } while (0)

/* No CRT TLS used; satisfy MinGW import-library TLS index anchor. */
unsigned long _tls_index;
