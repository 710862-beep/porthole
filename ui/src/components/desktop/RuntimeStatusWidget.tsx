import { Activity, Cpu, HardDrive } from "lucide-react";
import { useEmulator } from "@/hooks/useEmulator";
import { useWindowManager } from "@/hooks/useWindowManager";
import { cn } from "@/lib/cn";

const STATE_TONE: Record<string, string> = {
  running: "text-success",
  paused: "text-warning",
  loading: "text-info",
  exited: "text-ink-faint",
  faulted: "text-danger",
  idle: "text-ink-faint",
  "page-fault-wait": "text-warning",
};

/** Compact KDE-plasmoid: storage, guest state, present rate. Opens System Monitor. */
export function RuntimeStatusWidget() {
  const { telemetry, guestState, mode, status } = useEmulator();
  const { openApp } = useWindowManager();
  const storage = telemetry?.storageBackend ?? "opfs";

  return (
    <button
      type="button"
      onClick={() => openApp("system")}
      title="Open System Monitor"
      className={cn(
        "group fixed bottom-[60px] left-4 z-10 flex items-center gap-3 rounded-full border border-white/[0.09]",
        "bg-[#11111b]/70 px-3.5 py-1.5 text-[10.5px] text-ink-muted shadow-[0_8px_30px_rgba(0,0,0,0.45)]",
        "backdrop-blur-xl transition-colors duration-200 hover:border-accent/30 hover:bg-[#11111b]/85 hover:text-ink",
      )}
    >
      <span className="flex items-center gap-1.5">
        <HardDrive size={11} aria-hidden className="text-accent" />
        <span className="font-mono uppercase tracking-[0.08em]">
          {storage === "file-system-access" ? "nvme" : storage}
        </span>
      </span>
      <span className="h-3 w-px bg-white/10" aria-hidden />
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            guestState === "running"
              ? "animate-pulse-dot bg-success"
              : guestState === "faulted"
                ? "bg-danger"
                : "bg-overlay",
          )}
          aria-hidden
        />
        <span className={cn("font-mono uppercase tracking-[0.08em]", STATE_TONE[guestState])}>
          {status === "initializing" ? "init" : guestState}
        </span>
      </span>
      {telemetry && guestState === "running" && (
        <>
          <span className="h-3 w-px bg-white/10" aria-hidden />
          <span className="flex items-center gap-1.5 font-mono tabular-nums">
            <Activity size={11} aria-hidden className="text-violet" />
            {telemetry.fps} fps
          </span>
        </>
      )}
      <span className="h-3 w-px bg-white/10" aria-hidden />
      <span className="flex items-center gap-1.5">
        <Cpu size={11} aria-hidden className={mode === "mock" ? "text-warning" : "text-success"} />
        <span className="font-mono uppercase tracking-[0.08em]">{mode}</span>
      </span>
    </button>
  );
}
