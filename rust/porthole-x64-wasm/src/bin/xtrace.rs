//! Native (non-Wasm) trace driver for the x86-64 core.
//!
//! Loads a PE32+ image into the same `BrowserX64Emulator` that the browser and the Wine64
//! conformance harness use, arms a data breakpoint over the top of the guest stack, and prints a
//! per-instruction trace plus a full fault snapshot. This is the debugger channel used by CI to
//! publish guest state without artifact downloads.
//!
//! Usage:
//!   cargo run --bin xtrace -- <image.exe> [--budget N] [--slice N] [--trace N] [--no-watch]

use porthole_x64_wasm::pe64::MAIN_STACK_TOP;
use porthole_x64_wasm::BrowserX64Emulator;

struct Options {
    path: String,
    budget: u64,
    slice: u32,
    trace: u32,
    watch: bool,
    watch_span: u64,
    extra_watch: Vec<(u64, u64)>,
    peeks: Vec<u64>,
    args: Option<String>,
    hle_only: bool,
    match_patterns: Vec<String>,
    mkdirs: Vec<String>,
    puts: Vec<(String, String)>,
    gets: Vec<(String, String)>,
    exe_path: Option<String>,
    resident: u32,
}

fn parse_u64(v: &str) -> Option<u64> {
    let t = v.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok()
    } else {
        t.parse().ok()
    }
}

fn parse_args() -> Options {
    let mut opts = Options {
        path: "tests/assets/wine64/user32_test.exe".to_string(),
        budget: 250_000,
        slice: 4_000,
        trace: 600,
        watch: true,
        watch_span: 0x400,
        extra_watch: Vec::new(),
        peeks: Vec::new(),
        args: None,
        hle_only: false,
        match_patterns: Vec::new(),
        mkdirs: Vec::new(),
        puts: Vec::new(),
        gets: Vec::new(),
        exe_path: None,
        resident: 2048,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--budget" => opts.budget = it.next().and_then(|v| v.parse().ok()).unwrap_or(opts.budget),
            "--slice" => opts.slice = it.next().and_then(|v| v.parse().ok()).unwrap_or(opts.slice),
            "--trace" => opts.trace = it.next().and_then(|v| v.parse().ok()).unwrap_or(opts.trace),
            "--span" => opts.watch_span = it.next().and_then(|v| v.parse().ok()).unwrap_or(opts.watch_span),
            "--no-watch" => opts.watch = false,
            "--hle-only" => opts.hle_only = true,
            "--hle-match" => {
                if let Some(v) = it.next() {
                    opts.match_patterns = v
                        .split(',')
                        // Patterns keep their trailing space on purpose: "K " matches the HLE
                        // notes but not the word "kernel32.dll" in an `H` line.
                        .map(|p| p.to_string())
                        .filter(|p| !p.is_empty())
                        .collect();
                }
            }
            "--args" => opts.args = it.next(),
            "--resident" => {
                opts.resident = it.next().and_then(|v| v.parse().ok()).unwrap_or(opts.resident)
            }
            "--mkdir" => {
                if let Some(v) = it.next() {
                    opts.mkdirs.push(v);
                }
            }
            "--exe-path" => opts.exe_path = it.next(),
            "--put" => {
                if let Some(v) = it.next() {
                    if let Some((g, h)) = v.split_once('=') {
                        opts.puts.push((g.to_string(), h.to_string()));
                    }
                }
            }
            "--get" => {
                if let Some(v) = it.next() {
                    if let Some((g, h)) = v.split_once('=') {
                        opts.gets.push((g.to_string(), h.to_string()));
                    }
                }
            }
            "--watch" => {
                if let Some(v) = it.next() {
                    let mut parts = v.split(':');
                    let lo = parts.next().and_then(|v| parse_u64(v)).unwrap_or(0);
                    let hi = parts.next().and_then(|v| parse_u64(v)).unwrap_or(lo + 0x100);
                    opts.extra_watch.push((lo, hi));
                }
            }
            "--peek" => {
                if let Some(v) = it.next().and_then(|v| parse_u64(&v)) {
                    opts.peeks.push(v);
                }
            }
            other => opts.path = other.to_string(),
        }
    }
    opts
}

fn main() {
    let opts = parse_args();
    let bytes = match std::fs::read(&opts.path) {
        Ok(b) => b,
        Err(e) => {
            println!("cannot read {}: {e}", opts.path);
            std::process::exit(2);
        }
    };

    println!("===PORTHOLE-TRACE-BEGIN===");
    println!("image={} bytes={}", opts.path, bytes.len());

    let started = std::time::Instant::now();
    let mut emu = BrowserX64Emulator::new(opts.resident);
    emu.enable_trace(opts.trace);
    for dir in &opts.mkdirs {
        emu.vfs_mkdir(dir);
        println!("vfs_mkdir={dir}");
    }
    for (guest, host) in &opts.puts {
        match std::fs::read(host) {
            Ok(data) => {
                println!("vfs_put {guest} <- {host} ({} bytes)", data.len());
                emu.vfs_insert(guest, &data);
            }
            Err(e) => println!("vfs_put FAILED {guest} <- {host}: {e}"),
        }
    }
    if let Some(exe) = &opts.exe_path {
        emu.set_exe_path(exe);
        println!("exe_path={exe}");
    }
    if opts.hle_only {
        // Only Win32/NT HLE traffic: the whole run then fits in a 260-line buffer.
        emu.set_hle_trace_only(true);
        println!("trace_filter=hle-only");
    }
    if !opts.match_patterns.is_empty() {
        println!("trace_match={}", opts.match_patterns.join(","));
        emu.set_trace_filter(opts.match_patterns.clone());
    }
    match emu.load_pe(&bytes) {
        Ok(info) => println!("load={info}"),
        Err(_) => {
            println!("load=FAILED");
            println!("===PORTHOLE-TRACE-END===");
            std::process::exit(3);
        }
    }

    for (lo, hi) in &opts.extra_watch {
        emu.add_write_watch(*lo, *hi);
        println!("watch+=[0x{lo:x},0x{hi:x})");
    }
    if let Some(args) = &opts.args {
        emu.set_command_line(args);
        println!("command_line={args}");
    }
    let rsp0 = emu.stack_pointer();
    if opts.watch {
        let lo = MAIN_STACK_TOP.saturating_sub(opts.watch_span);
        emu.set_write_watch(lo, MAIN_STACK_TOP, 4096);
        println!("watch=[0x{lo:x},0x{MAIN_STACK_TOP:x}) entry_rsp=0x{rsp0:x}");
    }
    println!("entry_rsp=0x{rsp0:x} aligned16_plus8={}", rsp0 % 16 == 8);

    let mut page_faults = 0u64;
    let mut slices = 0u32;
    let mut outcome = "budget".to_string();
    // Host-side store for pages evicted from the resident LRU window. Draining after every
    // slice and re-supplying from here makes small-resident runs faithful: the previous
    // always-zero supply silently zeroed evicted guest data on refault.
    let mut page_store: std::collections::HashMap<u64, Vec<u8>> = std::collections::HashMap::new();

    while emu.instructions_executed() < opts.budget {
        let status = emu.run_slice(opts.slice);
        slices += 1;
        let drained = emu.drain_evicted_pages();
        let mut off = 0usize;
        while off + 8 + 4096 <= drained.len() {
            let base = u64::from_le_bytes(drained[off..off + 8].try_into().unwrap());
            page_store.insert(base, drained[off + 8..off + 8 + 4096].to_vec());
            off += 8 + 4096;
        }
        if status == "next" {
            continue;
        }
        if let Some(addr) = status.strip_prefix("page-fault:") {
            page_faults += 1;
            if page_faults > 100_000 {
                outcome = format!("page-fault-storm {addr}");
                break;
            }
            let base: u64 = addr.parse().unwrap_or(0);
            match page_store.get(&base) {
                Some(data) => emu.supply_page(base, data),
                None => emu.supply_page(base, &[0u8; 4096]),
            }
            continue;
        }
        outcome = status;
        break;
    }

    let trace = emu.take_trace();
    println!("--- trace ({} lines) ---", trace.lines().count());
    println!("{trace}");
    println!("--- fault snapshot ---");
    print!("{}", emu.fault_snapshot());
    println!("--- result ---");
    let elapsed = started.elapsed();
    let insns = emu.instructions_executed();
    let mips = if elapsed.as_secs_f64() > 0.0 {
        insns as f64 / elapsed.as_secs_f64() / 1_000_000.0
    } else {
        0.0
    };
    println!(
        "outcome={} instructions={} slices={} page_faults={} last_error={} wall_ms={} mips={:.2} resident_pages={} pages_evicted={}",
        outcome,
        insns,
        slices,
        page_faults,
        emu.last_error(),
        elapsed.as_millis(),
        mips,
        emu.resident_pages(),
        emu.pages_evicted()
    );
    for (guest, host) in &opts.gets {
        match emu.vfs_read(guest) {
            Some(data) => match std::fs::write(host, &data) {
                Ok(()) => println!("vfs_get {guest} -> {host} ({} bytes)", data.len()),
                Err(e) => println!("vfs_get FAILED {guest} -> {host}: {e}"),
            },
            None => println!("vfs_get MISSING {guest}"),
        }
    }
    if !opts.peeks.is_empty() {
        println!("--- memory peeks ---");
        for addr in &opts.peeks {
            println!("0x{addr:x}:");
            print!("{}", emu.peek_qwords(*addr, 4));
        }
    }
    println!("--- hle histogram (top 40) ---");
    println!("{}", emu.hle_histogram(40));
    let com = emu.com_histogram(40);
    if !com.is_empty() {
        println!("--- com histogram (top 40) ---");
        println!("{com}");
    }
    let missing_com = emu.unimplemented_methods();
    if !missing_com.is_empty() {
        println!("--- unimplemented com methods ---");
        println!("{missing_com}");
    }
    let missing = emu.unimplemented_symbols();
    if !missing.is_empty() {
        println!("--- unimplemented symbols ---");
        println!("{missing}");
    }
    let console = emu.take_console();
    if !console.is_empty() {
        println!("--- guest console ---");
        for line in console.lines().take(3000) {
            println!("{line}");
        }
    }
    println!("===PORTHOLE-TRACE-END===");
}
