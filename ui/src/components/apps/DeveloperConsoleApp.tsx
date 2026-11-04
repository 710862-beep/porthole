import { useMemo, useState } from "react";
import { Activity, Braces, Cpu, Radio, Trash2 } from "lucide-react";
import type { RuntimeLogLevel } from "@runtime/types";
import { useEmulatorStore } from "@/store/emulatorStore";
import { useDevConsoleStore, type DevConsoleChannel } from "@/store/devConsoleStore";
import { formatClock } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

type ChannelFilter = "all" | DevConsoleChannel;

const FILTERS: Array<{ id: ChannelFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "ui", label: "UI events" },
  { id: "shim", label: "SHIM calls" },
  { id: "runtime", label: "Runtime" },
];

const LEVEL_STYLE: Record<RuntimeLogLevel, string> = {
  debug: "text-ink-ghost",
  info: "text-ink-muted",
  warn: "text-warning",
  error: "text-danger",
};

const CHANNEL_STYLE: Record<DevConsoleChannel, string> = {
  ui: "text-accent",
  shim: "text-violet",
  runtime: "text-info",
};

/** In-OS event console; SHIM rows are sourced from the Wasm core's HLE histogram. */
export function DeveloperConsoleApp() {
  const entries = useDevConsoleStore((state) => state.entries);
  const clear = useDevConsoleStore((state) => state.clear);
  const telemetry = useEmulatorStore((state) => state.telemetry);
  const mode = useEmulatorStore((state) => state.mode);
  const [filter, setFilter] = useState<ChannelFilter>("all");

  const filtered = useMemo(
    () => (filter === "all" ? entries : entries.filter((entry) => entry.channel === filter)),
    [entries, filter],
  );
  const shimCount = entries.filter((entry) => entry.channel === "shim").length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#101019]">
      <header className="flex flex-none items-center gap-3 border-b border-white/[0.07] px-4 py-3">
        <span className="grid h-8 w-8 place-items-center rounded-[8px] border border-accent/20 bg-accent/10 text-accent">
          <Braces size={15} aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="text-[12.5px] font-semibold text-ink">Developer Console</h1>
          <p className="text-[9.5px] text-ink-faint">UI events · Windows API SHIM/HLE aggregates · runtime state</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge tone={mode === "wasm" ? "success" : "warning"} dot>
            {mode}
          </Badge>
          <Badge tone="neutral">{telemetry?.state ?? "idle"}</Badge>
          <Button size="icon" variant="ghost" icon={Trash2} aria-label="Clear developer console" onClick={clear} />
        </div>
      </header>

      <div className="flex flex-none items-center gap-1 overflow-x-auto border-b border-white/[0.06] px-3 py-2">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
            className={cn(
              "h-7 flex-none rounded-[6px] px-2.5 text-[10px] transition",
              filter === item.id ? "bg-white/[0.09] text-ink" : "text-ink-faint hover:bg-white/[0.05] hover:text-ink",
            )}
          >
            {item.label}
            <span className="ml-1.5 font-mono text-[9px] text-ink-ghost">
              {item.id === "all" ? entries.length : entries.filter((entry) => entry.channel === item.id).length}
            </span>
          </button>
        ))}
        <div className="ml-auto flex flex-none items-center gap-3 px-2 font-mono text-[9px] text-ink-ghost">
              <span className="flex items-center gap-1"><Activity size={10} aria-hidden />{mode === "wasm" ? telemetry?.instructionsExecuted.toLocaleString() ?? "0" : "—"} insn</span>
              <span className="flex items-center gap-1"><Cpu size={10} aria-hidden />{mode === "wasm" ? telemetry?.residentPages ?? 0 : "—"} pages</span>
          <span className="flex items-center gap-1"><Radio size={10} aria-hidden />{shimCount} SHIM rows</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[10px] leading-[1.65]" role="log" aria-label="Developer event log">
        {filtered.length === 0 ? (
          <div className="flex h-full min-h-[130px] flex-col items-center justify-center gap-2 text-center">
            <Radio size={17} className="text-ink-ghost" aria-hidden />
            <p className="text-ink-muted">No {filter === "shim" ? "guest SHIM/HLE counters" : "events"} captured yet.</p>
            <p className="max-w-[52ch] text-[9.5px] leading-relaxed text-ink-ghost">
              UI actions appear here as you use the desktop. SHIM rows are aggregate HLE counters reported by the Wasm core, not per-call traces; no synthetic guest activity is generated.
            </p>
          </div>
        ) : (
          filtered.map((entry) => (
            <div key={entry.id} className="grid grid-cols-[66px_52px_86px_minmax(0,1fr)] gap-2 border-b border-white/[0.035] py-1">
              <time className="text-ink-ghost">{formatClock(entry.ts)}</time>
              <span className={cn("uppercase", LEVEL_STYLE[entry.level])}>{entry.level}</span>
              <span className={cn("truncate uppercase", CHANNEL_STYLE[entry.channel])}>{entry.channel}/{entry.source}</span>
              <span className={cn("break-words", LEVEL_STYLE[entry.level])}>{entry.message}</span>
            </div>
          ))
        )}
      </div>
      <footer className="flex flex-none items-center justify-between border-t border-white/[0.06] px-3 py-2 text-[9px] text-ink-ghost">
        <span>Bounded in-memory ring · {entries.length} / 600</span>
        <span>SHIM histogram rows are aggregates; per-call trace fidelity is not verified.</span>
      </footer>
    </div>
  );
}
