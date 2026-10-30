/*
 * Porthole x86-64 :: minimal Hello World
 *
 * The smallest realistic Windows desktop program: ucrt startup, `main`, stdio, and an explicit
 * `ExitProcess(0)`. It exists to answer one question with numbers rather than opinions:
 *
 *   "How many guest instructions does it take to run a compiled Windows binary to completion,
 *    which Win32/CRT APIs does it call, and what exit code does it produce?"
 */
#include <windows.h>
#include <stdio.h>

int main(int argc, char **argv)
{
    int i;

    printf("HELLO_WORLD_BEGIN\n");
    printf("argc=%d\n", argc);
    for (i = 0; i < argc && i < 4; i++)
        printf("argv[%d]=%s\n", i, argv[i]);
    printf("command_line=%s\n", GetCommandLineA());
    printf("Hello, World!\n");
    printf("HELLO_WORLD_OK\n");
    fflush(stdout);

    ExitProcess(0);
    return 0;
}
