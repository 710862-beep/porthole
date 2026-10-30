import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChevronRight, Copy, CornerDownLeft, Terminal as TerminalIcon, Trash2 } from "lucide-react";
import type { InstallPhase } from "@runtime/types";
import { useRuntime } from "@/hooks/useRuntime";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useWindowChrome } from "@/components/windows/WindowChromeContext";
import { useEmulatorStore } from "@/store/emulatorStore";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/store/uiStore";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/cn";

type LineKind = "input" | "output" | "error" | "accent" | "muted";

interface Line {
  id: number;
  kind: LineKind;
  text: string;
}

const APP_ALIASES = ["store", "emulator", "terminal", "system", "settings", "welcome"] as const;
type OpenTarget = (typeof APP_ALIASES)[number];

const LINE_STYLE: Record<LineKind, string> = {
  input: "text-ink",
  output: "text-ink-muted",
  error: "text-danger",
  accent: "text-accent",
  muted: "text-ink-ghost",
};

/**
 * Local shell over the shell's own facts. It is explicitly NOT a guest console:
 * no command is forwarded to a guest process.
 */
export function TerminalApp() {
  const chrome = useWindowChrome();
  const { store: gameStore, storage } = useRuntime();
  const { launchGame, openApp, closeWindow } = useWindowManager();
  const logs = useEmulatorStore((state) => state.logs);
  const telemetry = useEmulatorStore((state) => state.telemetry);
  const mode = useEmulatorStore((state) => state.mode);

  const sequence = useRef(1);
  const history = useRef<string[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const initialLines = useMemo<Line[]>(() => {
    const payloadLines = chrome.payload?.kind === "terminal" ? chrome.payload.lines ?? [] : [];
    return payloadLines.map((text) => ({ id: sequence.current++, kind: "output" as const, text }));
  }, [chrome.payload]);

  const [lines, setLines] = useState<Line[]>(() => [
    {
      id: 0,
      kind: "accent",
      text: "Porthole shell · local only — no guest console is attached.",
    },
    { id: -1, kind: "muted", text: 'Type "help" for commands. Evidence lives in the store cards.' },
    ...initialLines,
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);

  useEffect(() => {
    // Guarded: some embedded webviews expose Element without scrollIntoView.
    const target = bottomRef.current;
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "end" });
    }
  }, [lines]);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const push = useCallback((kind: LineKind, text: string): void => {
    setLines((previous) => [...previous, { id: sequence.current++, kind, text }]);
  }, []);

  const pushAll = useCallback((entries: Array<{ kind: LineKind; text: string }>): void => {
    setLines((previous) => [
      ...previous,
      ...entries.map((entry) => ({ id: sequence.current++, ...entry })),
    ]);
  }, []);

  const runCommand = useCallback(
    async (raw: string): Promise<void> => {
      const [command = "", ...args] = raw.trim().split(/\s+/);
      const target = args[0] ?? "";

      switch (command) {
        case "help": {
          pushAll([
            { kind: "accent", text: "Commands" },
            { kind: "output", text: "  help                 this text" },
            { kind: "output", text: "  ls | games           library entries + status" },
            { kind: "output", text: "  install <appId>      register a library entry (simulated)" },
            { kind: "output", text: "  uninstall <appId>    remove a library entry" },
            { kind: "output", text: "  launch <appId>       launch an installed workload" },
            { kind: "output", text: "  open <app>           open a desktop app (store, settings, …)" },
            { kind: "output", text: "  storage              current storage backend" },
            { kind: "output", text: "  runtime              runtime mode + telemetry" },
            { kind: "output", text: "  logs [n]             last n runtime log lines" },
            { kind: "output", text: "  date | whoami | pwd  boring but honest" },
            { kind: "output", text: "  overview             open the Overview" },
            { kind: "output", text: "  clear                clear this transcript" },
            { kind: "output", text: "  exit                 close this terminal window" },
          ]);
          break;
        }
        case "ls":
        case "games": {
          push("accent", "library");
          for (const game of gameStore.listGames()) {
            push(
              game.status === "installed" ? "output" : "muted",
              `  ${game.status === "installed" ? "●" : "○"} ${game.appId.padEnd(18)} ${game.title.padEnd(28)} ${game.category}`,
            );
          }
          break;
        }
        case "install": {
          const game = target ? gameStore.getGame(target) : null;
          if (!game) {
            push("error", `unknown appId: ${target || "(missing)"} — try "ls"`);
            break;
          }
          if (game.status === "installed") {
            push("muted", `${game.title} is already installed`);
            break;
          }
          push("muted", `registering ${game.title} (library entry only, no download)…`);
          let lastPhase: InstallPhase | null = null;
          try {
            await gameStore.installGame(game.appId, (progress) => {
              if (progress.phase !== lastPhase) {
                lastPhase = progress.phase;
                push("output", `  ${progress.phase} · ${Math.round(progress.percent)}% — ${progress.detail}`);
              }
            });
            push("accent", `${game.title} installed. Launch it with: launch ${game.appId}`);
          } catch (error) {
            push("error", error instanceof Error ? error.message : String(error));
          }
          break;
        }
        case "uninstall": {
          const game = target ? gameStore.getGame(target) : null;
          if (!game) {
            push("error", `unknown appId: ${target || "(missing)"}`);
            break;
          }
          await gameStore.uninstallGame(game.appId);
          push("accent", `${game.title} removed from the library`);
          break;
        }
        case "launch": {
          const game = target ? gameStore.getGame(target) : null;
          if (!game) {
            push("error", `unknown appId: ${target || "(missing)"}`);
            break;
          }
          if (game.status !== "installed") {
            push("error", `${game.title} is not installed — run: install ${game.appId}`);
            break;
          }
          push("muted", `launching ${game.title}…`);
          launchGame(game);
          break;
        }
        case "open": {
          if (!APP_ALIASES.includes(target as OpenTarget)) {
            push("error", `unknown app: ${target || "(missing)"} — one of ${APP_ALIASES.join(", ")}`);
            break;
          }
          openApp(target as OpenTarget, target === "settings" ? { kind: "settings" } : null);
          push("muted", `opened ${target}`);
          break;
        }
        case "storage": {
          const state = storage.describeSelected();
          pushAll([
            { kind: "accent", text: "storage" },
            { kind: "output", text: `  backend : ${state.backend}` },
            { kind: "output", text: `  label   : ${state.label}` },
            { kind: "output", text: `  detail  : ${state.detail}` },
          ]);
          break;
        }
        case "runtime": {
          pushAll([
            { kind: "accent", text: "runtime" },
            { kind: "output", text: `  mode        : ${mode}` },
            { kind: "output", text: `  guest state : ${telemetry?.state ?? "idle"}` },
            { kind: "output", text: `  presents    : ${telemetry?.presentedFrames ?? 0}` },
            { kind: "output", text: `  instructions: ${telemetry?.instructionsExecuted ?? 0}` },
            { kind: "output", text: `  uptime      : ${formatDuration(telemetry?.uptimeMs ?? 0)}` },
            { kind: "muted", text: "  mock values are synthetic and must not be cited as evidence" },
          ]);
          break;
        }
        case "logs": {
          const count = Math.max(1, Math.min(40, Number(args[0]) || 8));
          const tail = logs.slice(-count);
          if (tail.length === 0) push("muted", "runtime log is empty");
          for (const entry of tail) {
            push(
              entry.level === "error" ? "error" : entry.level === "warn" ? "accent" : "muted",
              `  ${entry.level.padEnd(5)} ${entry.source} :: ${entry.message}`,
            );
          }
          break;
        }
        case "date":
          push("output", new Date().toString());
          break;
        case "whoami":
          push("output", "porthole-user@browser (local shell, no guest session)");
          break;
        case "pwd":
          push("output", "~");
          break;
        case "overview":
          useEmulatorStore.getState();
          push("muted", 'Use Super (or the panel button) for Overview — focus stays in this window.');
          break;
        case "clear":
          setLines([{ id: sequence.current++, kind: "muted", text: "transcript cleared" }]);
          break;
        case "exit":
          void closeWindow(chrome.id);
          break;
        case "":
          break;
        default:
          push("error", `command not found: ${command} — try "help"`);
      }
    },
    [
      chrome.id,
      closeWindow,
      gameStore,
      launchGame,
      logs,
      mode,
      openApp,
      push,
      pushAll,
      storage,
      telemetry,
    ],
  );

  const submit = async (): Promise<void> => {
    const raw = input;
    if (!raw.trim() || busy) return;
    history.current = [...history.current, raw].slice(-60);
    setHistoryIndex(-1);
    setInput("");
    push("input", `porthole@cachy:~$ ${raw}`);
    setBusy(true);
    try {
      await runCommand(raw);
    } finally {
      setBusy(false);
      inputRef.current?.focus({ preventScroll: true });
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.min(history.current.length - 1, historyIndex + 1);
      const value = history.current[history.current.length - 1 - next];
      if (value !== undefined) {
        setHistoryIndex(next);
        setInput(value);
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = Math.max(-1, historyIndex - 1);
      setHistoryIndex(next);
      setInput(next === -1 ? "" : history.current[history.current.length - 1 - next] ?? "");
    } else if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      setLines([{ id: sequence.current++, kind: "muted", text: "transcript cleared" }]);
    }
  };

  const copyTranscript = async (): Promise<void> => {
    const ok = await copyText(lines.map((line) => line.text).join("\n"));
    if (ok) toast({ title: "Transcript copied", tone: "success", duration: 1800 });
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[#0b0b13] font-mono"
      onClick={() => inputRef.current?.focus({ preventScroll: true })}
    >
      <header className="flex h-8 flex-none items-center gap-2 border-b border-white/[0.07] bg-white/[0.02] px-3">
        <TerminalIcon size={12} className="text-accent" aria-hidden />
        <span className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">terminal</span>
        <span className="font-mono text-[9.5px] text-ink-ghost">· local shell</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              void copyTranscript();
            }}
            className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[9.5px] text-ink-faint transition hover:bg-white/[0.06] hover:text-ink"
          >
            <Copy size={10} aria-hidden />
            copy
          </button>
          <button
            type="button"
            onClick={() => setLines([{ id: sequence.current++, kind: "muted", text: "transcript cleared" }])}
            className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[9.5px] text-ink-faint transition hover:bg-danger/10 hover:text-danger"
          >
            <Trash2 size={10} aria-hidden />
            clear
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="no-scrollbar selectable min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[11px] leading-[1.65]"
        role="log"
        aria-live="polite"
      >
        {lines.map((line) => (
          <div key={line.id} className={cn("whitespace-pre-wrap break-words", LINE_STYLE[line.kind])}>
            {line.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="flex flex-none items-center gap-2 border-t border-white/[0.07] bg-black/30 px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] text-success">
          porthole@cachy
          <span className="text-ink-ghost">:</span>
          <span className="text-info">~</span>
          <ChevronRight size={11} className="text-ink-faint" aria-hidden />
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          aria-label="Shell command"
          placeholder={busy ? "working…" : 'type "help"'}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-ink caret-accent outline-none placeholder:text-ink-ghost disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => {
            void submit();
          }}
          disabled={busy || !input.trim()}
          aria-label="Run command"
          className="grid h-6 w-6 flex-none place-items-center rounded-[5px] text-ink-faint transition hover:bg-white/[0.07] hover:text-accent disabled:opacity-30"
        >
          <CornerDownLeft size={12} aria-hidden />
        </button>
      </div>
    </div>
  );
}
