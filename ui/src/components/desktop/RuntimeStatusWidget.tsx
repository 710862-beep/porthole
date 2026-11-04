import { Activity, ArrowUpRight } from "lucide-react";
import { useEmulator } from "@/hooks/useEmulator";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useEmulatorStore } from "@/store/emulatorStore";
import { cn } from "@/lib/cn";

/** Desktop system card: real browser/runtime facts, styled after a terminal window. */
export function RuntimeStatusWidget() {
  const { telemetry, guestState, mode, status } = useEmulator();
  const { openApp } = useWindowManager();
  const storage = useEmulatorStore((state) => state.storage);
  const runtimeReady = mode === "wasm";

  const rows = [
    ["environment", "browser sandbox"],
    ["guest runtime", runtimeReady ? "ABI-v3 WebAssembly" : "unavailable"],
    ["guest state", status === "initializing" ? "initializing" : guestState],
    ["storage", storage?.label ?? "not selected"],
    ["guest presents", runtimeReady ? String(telemetry?.presentedFrames ?? 0) : "not available"],
    ["host Windows process", "not accessible"],
  ] as const;

  return (
    <button
      type="button"
      onClick={() => openApp("system")}
      title="Open System Monitor"
      aria-label="Open System Monitor. Porthole runs in a browser and cannot start host Windows processes."
      className={cn(
        "fixed right-5 top-5 z-10 block w-[min(460px,calc(100vw-2.5rem))] overflow-hidden rounded-[10px]",
        "border border-white/[0.14] bg-[rgba(29,22,42,0.91)] text-left shadow-[0_24px_80px_rgba(15,5,31,0.55)]",
        "backdrop-blur-2xl transition duration-200 hover:border-white/[0.22] hover:bg-[rgba(31,23,46,0.95)]",
      )}
    >
      <div className="flex h-8 items-center gap-2 border-b border-white/[0.08] bg-white/[0.035] px-2.5">
        <span className="grid h-[17px] w-[17px] place-items-center rounded-[4px] border border-accent/25 bg-accent/10 text-accent">
          <Activity size={10} aria-hidden />
        </span>
        <span className="font-mono text-[9.5px] text-ink-muted">Porthole · system status</span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-[0.12em] text-ink-ghost">
          <i className={cn("h-1.5 w-1.5 rounded-full", runtimeReady ? "bg-success" : "bg-warning")} aria-hidden />
          {runtimeReady ? "ready" : "browser session"}
        </span>
      </div>

      <div className="p-3.5 font-mono text-[10px] leading-[1.7]">
        <p className="mb-2 text-accent/90">$ porthole status</p>
        <dl className="grid grid-cols-[minmax(112px,0.42fr)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="truncate text-ink-faint">{label}</dt>
              <dd
                className={cn(
                  "truncate text-[#cbd6e2]",
                  label === "guest runtime" && !runtimeReady && "text-warning",
                  label === "guest runtime" && runtimeReady && "text-success",
                  label === "host Windows process" && "text-ink-muted",
                  label === "guest state" && guestState === "faulted" && "text-danger",
                )}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <span className="mt-3 flex items-center gap-1 text-[9px] text-accent/80">
          Open browser and guest telemetry <ArrowUpRight size={10} aria-hidden />
        </span>
      </div>
    </button>
  );
}
