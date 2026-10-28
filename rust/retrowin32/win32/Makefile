DLL_SRC=comctl32.rs advapi32.rs bass.rs dplay.rs ddraw/ dsound.rs gdi32/ kernel32/ ntdll.rs ole32.rs oleaut32.rs retrowin32_test.rs ucrtbase.rs vcruntime140.rs version.rs user32/ wininet.rs winmm/ ws2_32.rs
DLLS=$(foreach dll,$(DLL_SRC),src/winapi/$(dll))
src/winapi/builtin.rs: Makefile derive/src/*.rs src/*.rs src/winapi/* src/winapi/*/*
	cargo run -p win32-derive -- --dll-dir dll --builtins $@ $(DLLS)
	make -C dll -j
