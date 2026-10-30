import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  ScrollText,
  Trash2,
} from "lucide-react";
import type { RuntimeLogEntry, RuntimeLogLevel } from "@runtime/types";
import { copyText } from "@/lib/clipboard";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/cn";

interface LogConsoleProps {
  entries: readonly RuntimeLogEntry[];
  open: boolean;
  onToggle: () => void;
  onClear?: () => void;
  title?: string;
  height?: number;
  className?: string;
}

const LEVEL_STYLE: Record<RuntimeLogLevel, string> = {
  debug: "text-ink-ghost",
  info: "text-ink-muted",
  warn: "text-warning",
  error: "text-danger",
};

const LEVEL_TAG: Record<RuntimeLogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

/**
 * Collapsible console shared by the Game Store, Emulator and System Monitor.
 * Rows are runtime log entries verbatim (source + level preserved); the shell never
 * rewrites them.
 */
export function LogConsole({
  entries,
  open,
  onToggle,
  onClear,
  title = "Console",
  height = 176,
  className,
}: LogConsoleProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [entries.length, open]);

  const handleCopy = async (): Promise<void> => {
    const text = entries
      .map(
        (entry) =>
          `${formatClock(entry.ts)} ${entry.level.toUpperCase().padEnd(5)} ${entry.source} :: ${entry.message}`,
      )
      .join("\n");
    const ok = await copyText(text);
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <section
      className={cn(
        "flex flex-none flex-col overflow-hidden border-t border-white/[0.08] bg-[#0b0b13]",
        className,
      )}
      aria-label={title}
    >
      <header className="flex h-9 flex-none items-center gap-2 px-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-[10.5px] font-medium text-ink-muted transition hover:bg-white/[0.05] hover:text-ink"
        >
          <ChevronDown
            size={12}
            className={cn("transition-transform duration-200", !open && "-rotate-90")}
            aria-hidden
          />
          <ScrollText size={12} className="text-accent" aria-hidden />
          {title}
          <span className="rounded-full border border-white/[0.08] px-1.5 font-mono text-[9px] text-ink-faint">
            {entries.length}
          </span>
        </button>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              void handleCopy();
            }}
            className="flex items-center gap-1.5 rounded-[5px] px-1.5 py-1 text-[10px] text-ink-faint transition hover:bg-white/[0.06] hover:text-ink"
            aria-label="Copy console contents"
          >
            {copied ? <Check size={11} className="text-success" aria-hidden /> : <Copy size={11} aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              className="flex items-center gap-1.5 rounded-[5px] px-1.5 py-1 text-[10px] text-ink-faint transition hover:bg-danger/10 hover:text-danger"
              aria-label="Clear console"
            >
              <Trash2 size={11} aria-hidden />
              Clear
            </button>
          )}
        </div>
      </header>

      <div
        ref={scrollRef}
        className={cn(
          "no-scrollbar selectable min-h-0 overflow-y-auto border-t border-white/[0.05] px-3 py-2 font-mono text-[10.5px] leading-[1.6]",
          !open && "hidden",
        )}
        style={{ height }}
        role="log"
      >
        {entries.length === 0 ? (
          <p className="text-ink-ghost">No runtime entries yet. Launch a workload.</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="flex gap-2">
              <span className="flex-none text-ink-ghost">{formatClock(entry.ts)}</span>
              <span className={cn("flex-none font-semibold", LEVEL_STYLE[entry.level])}>
                {LEVEL_TAG[entry.level]}
              </span>
              <span className="flex-none text-info/70">{entry.source}</span>
              <span className={cn("min-w-0 break-words", LEVEL_STYLE[entry.level])}>
                {entry.message}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
