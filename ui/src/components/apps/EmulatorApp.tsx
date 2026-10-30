import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronDown,
  CircleStop,
  Cpu,
  MousePointerClick,
  Pause,
  Play,
  RotateCcw,
  ScrollText,
  ShieldAlert,
  Store,
} from "lucide-react";
import type { StoreGame } from "@runtime/types";
import { useRuntime } from "@/hooks/useRuntime";
import { useEmulator } from "@/hooks/useEmulator";
import { useFramebuffer } from "@/hooks/useFramebuffer";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useWindowChrome } from "@/components/windows/WindowChromeContext";
import { useEmulatorStore } from "@/store/emulatorStore";
import { useWindowStore } from "@/store/windowStore";
import { useLibraryStore } from "@/store/libraryStore";
import { toast } from "@/store/uiStore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { LogConsole } from "@/components/ui/LogConsole";
import { cn } from "@/lib/cn";
import { formatDuration, formatNumber, shortHash } from "@/lib/format";

interface MetricProps {
  label: string;
  value: string;
  tone?: "default" | "accent" | "success" | "warning";
}

function Metric({ label, value, tone = "default" }: MetricProps) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 py-1.5">
      <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-ink-ghost">
        {label}
      </span>
      <span
        className={cn(
          "truncate font-mono text-[11.5px] tabular-nums",
          tone === "accent" && "text-accent",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
          tone === "default" && "text-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Emulator surface: guest scanout, controls, telemetry and the runtime console.
 *
 * Frame honesty: the canvas only receives `runtime.getFramebuffer()` output and the
 * mock mode is labelled in the chrome and in the log stream.
 */
export function EmulatorApp() {
  const chrome = useWindowChrome();
  const { store: gameStore } = useRuntime();
  const {
    runtime,
    mode,
    telemetry,
    guestState,
    status,
    logs,
    logsOpen,
    processHandle,
    loadAndLaunch,
    pause,
    resume,
    terminate,
    clearLogs,
    toggleLogs,
    sendKey,
  } = useEmulator();
  const { openApp } = useWindowManager();
  const games = useLibraryStore((state) => state.games);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const autoLaunched = useRef<string | null>(null);
  const inputNotice = useRef(false);

  const [armed, setArmed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Workload chosen from the in-window picker when no Store payload exists. */
  const [pickedAppId, setPickedAppId] = useState<string | null>(null);

  const payloadGame = useMemo<StoreGame | null>(() => {
    const appId = chrome.payload?.kind === "game" ? chrome.payload.appId : undefined;
    return appId ? gameStore.getGame(appId) : null;
  }, [chrome.payload, gameStore]);

  const installedGames = useMemo(
    () => games.filter((entry) => entry.status === "installed" && entry.exePath),
    [games],
  );

  /**
   * Payload wins (opened from the Store), then an explicit pick, then the first
   * installed workload — so the window is never a dead surface that needs a menu
   * detour before Launch becomes usable.
   */
  const game = useMemo<StoreGame | null>(() => {
    if (pickedAppId) return gameStore.getGame(pickedAppId);
    return payloadGame ?? installedGames[0] ?? null;
  }, [gameStore, installedGames, payloadGame, pickedAppId]);

  useFramebuffer(canvasRef, chrome.visible);

  useEffect(() => {
    useWindowStore
      .getState()
      .setTitle(chrome.id, game ? `${game.title} — Emulator` : "Porthole Emulator");
  }, [chrome.id, game]);

  // Opening the window from the Store payload starts that workload once. A
  // default selection never auto-launches: that would run a binary on window open.
  useEffect(() => {
    if (!chrome.visible || !payloadGame) return;
    if (useEmulatorStore.getState().status === "cold") return;
    if (processHandle || autoLaunched.current === payloadGame.appId) return;
    autoLaunched.current = payloadGame.appId;
    void loadAndLaunch(payloadGame.exePath);
  }, [chrome.visible, loadAndLaunch, payloadGame, processHandle]);

  const running = guestState === "running";
  const paused = guestState === "paused";
  const hasFrames = (telemetry?.presentedFrames ?? 0) > 0;

  const launchGame = useCallback(
    (entry: StoreGame): void => {
      setPickerOpen(false);
      setPickedAppId(entry.appId);
      autoLaunched.current = entry.appId;
      void loadAndLaunch(entry.exePath);
    },
    [loadAndLaunch],
  );

  const armInput = (): void => {
    setArmed(true);
    stageRef.current?.focus({ preventScroll: true });
    if (!inputNotice.current) {
      inputNotice.current = true;
      toast({
        title: "Input capture armed (KI-04)",
        message: "Keystrokes are counted by the shell; the core does not deliver them yet.",
        tone: "warning",
      });
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!armed || !running) return;
    if (["Tab", "F5", "F12", "Meta"].includes(event.key)) return;
    event.preventDefault();
    sendKey(event.code || event.key, "down");
  };

  const handleKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!armed || !running) return;
    event.preventDefault();
    sendKey(event.code || event.key, "up");
  };

  const handlePointer = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!armed) {
      armInput();
      return;
    }
    if (!running) return;
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const width = canvas.width || 240;
    const height = canvas.height || 135;
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const y = ((event.clientY - rect.top) / rect.height) * height;
    runtime.sendMouseEvent(0, x, y);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0f0f18]">
      <header className="flex flex-none items-center gap-2 border-b border-white/[0.07] px-3 py-2">
        <span className="grid h-7 w-7 flex-none place-items-center rounded-[7px] border border-violet/25 bg-violet/10 text-violet">
          <Cpu size={14} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[11.5px] font-medium text-ink">
            {game?.title ?? "No workload loaded"}
          </p>
          <p className="truncate font-mono text-[9.5px] text-ink-faint">
            {game?.exePath || "select an installed workload to load its entry point"}
          </p>
        </div>

        <div className="ml-2 flex items-center gap-1.5">
          <Badge
            tone={
              running ? "success" : paused ? "warning" : guestState === "faulted" ? "danger" : "neutral"
            }
            dot
          >
            {status === "initializing" ? "initializing" : guestState}
          </Badge>
          {mode === "mock" && (
            <Badge tone="warning" icon={ShieldAlert}>
              synthetic
            </Badge>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <div className="relative">
            <Button
              size="sm"
              variant="secondary"
              icon={Cpu}
              trailingIcon={ChevronDown}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((value) => !value)}
              disabled={installedGames.length === 0}
            >
              Workload
            </Button>
            {pickerOpen && (
              <div
                role="listbox"
                aria-label="Installed workloads"
                className="absolute right-0 top-[34px] z-20 w-[260px] overflow-hidden rounded-[10px] border border-white/10 bg-[rgba(17,17,27,0.97)] p-1 shadow-dialog backdrop-blur-xl"
              >
                {installedGames.map((entry) => (
                  <button
                    key={entry.appId}
                    type="button"
                    role="option"
                    aria-selected={game?.appId === entry.appId}
                    onClick={() => launchGame(entry)}
                    className="flex w-full flex-col items-start gap-0.5 rounded-[7px] px-2.5 py-1.5 text-left transition hover:bg-white/[0.06]"
                  >
                    <span className="text-[11px] text-ink">{entry.title}</span>
                    <span className="truncate font-mono text-[9px] text-ink-faint">
                      {entry.exePath}
                    </span>
                  </button>
                ))}
                {installedGames.length === 0 && (
                  <p className="px-2.5 py-2 text-[10.5px] text-ink-faint">
                    No installed workloads with an entry point.
                  </p>
                )}
              </div>
            )}
          </div>

          {running ? (
            <Button size="sm" variant="secondary" icon={Pause} onClick={() => void pause()}>
              Pause
            </Button>
          ) : paused ? (
            <Button size="sm" variant="primary" icon={Play} onClick={() => void resume()}>
              Resume
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon={Play}
              disabled={!game || status !== "ready"}
              onClick={() => {
                if (game) launchGame(game);
              }}
            >
              Launch
            </Button>
          )}

          <Button
            size="sm"
            variant="danger"
            icon={CircleStop}
            disabled={!processHandle}
            onClick={() => void terminate()}
          >
            Stop
          </Button>
          <Button
            size="icon"
            variant="ghost"
            icon={ScrollText}
            aria-label="Toggle runtime console"
            aria-pressed={logsOpen}
            onClick={toggleLogs}
            className={logsOpen ? "bg-white/[0.06] text-ink" : undefined}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#08080f] p-3">
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.35]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
              backgroundSize: "32px 32px",
            }}
            aria-hidden
          />

          <div
            ref={stageRef}
            tabIndex={0}
            role="application"
            aria-label="Guest scanout. Click to arm input capture."
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onPointerDown={armInput}
            onBlur={() => setArmed(false)}
            className={cn(
              "relative flex h-full w-full max-w-[1100px] items-center justify-center rounded-[10px] outline-none",
              "border border-white/[0.08] bg-black shadow-[inset_0_0_60px_rgba(0,0,0,0.9)]",
              armed && "ring-1 ring-accent/30",
            )}
          >
            <canvas
              ref={canvasRef}
              width={240}
              height={135}
              onPointerDown={handlePointer}
              className="h-full w-full object-contain [image-rendering:pixelated]"
            />

            {!hasFrames && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#08080f]/85 px-6 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-[12px] border border-white/[0.08] bg-white/[0.03] text-ink-faint">
                  <Cpu size={20} aria-hidden />
                </span>
                <div>
                  <p className="text-[12.5px] font-medium text-ink">
                    {status === "initializing"
                      ? "Seating the runtime…"
                      : processHandle
                        ? "Waiting for the first present…"
                        : "No guest frames yet"}
                  </p>
                  <p className="mt-1 max-w-[46ch] text-[10.5px] leading-relaxed text-ink-faint">
                    Pixels only ever come from the runtime framebuffer. In mock mode they
                    are labelled synthetic; with the Wasm core this is real scanout.
                  </p>
                </div>
                <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
                  {game ? (
                    <Button size="sm" variant="primary" icon={Play} onClick={() => launchGame(game)}>
                      Launch {game.title}
                    </Button>
                  ) : (
                    installedGames[0] && (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={Play}
                        onClick={() => launchGame(installedGames[0] as StoreGame)}
                      >
                        Launch {installedGames[0].title}
                      </Button>
                    )
                  )}
                  <Button size="sm" variant="secondary" icon={Store} onClick={() => openApp("store")}>
                    Library
                  </Button>
                </div>
              </div>
            )}

            <div className="pointer-events-none absolute left-2.5 top-2.5 flex items-center gap-1.5">
              <Badge tone={mode === "mock" ? "warning" : "success"} dot>
                {mode === "mock" ? "synthetic scanout" : "guest scanout"}
              </Badge>
              {armed && running && (
                <Badge tone="accent" icon={MousePointerClick}>
                  input armed
                </Badge>
              )}
            </div>

            {hasFrames && (
              <div className="pointer-events-none absolute bottom-2.5 left-2.5 right-2.5 flex items-end justify-between gap-3 font-mono text-[9px] text-white/40">
                <span>{`${telemetry?.presentedFrames ?? 0} presents · ${telemetry?.fps ?? 0} fps`}</span>
                <span>{telemetry?.frameChecksum ? shortHash(telemetry.frameChecksum, 10, 6) : "checksum pending"}</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-none items-stretch divide-x divide-white/[0.05] border-t border-white/[0.06] bg-black/25">
          <Metric label="State" value={guestState} tone={running ? "success" : "default"} />
          <Metric
            label="Instructions"
            value={telemetry ? formatNumber(telemetry.instructionsExecuted) : "—"}
          />
          <Metric
            label="Presents"
            value={telemetry ? formatNumber(telemetry.presentedFrames) : "—"}
            tone="accent"
          />
          <Metric label="FPS" value={telemetry ? String(telemetry.fps) : "—"} />
          <Metric
            label="Resident / max"
            value={
              telemetry
                ? `${telemetry.residentPages}/${telemetry.maxResidentPages}`
                : "—"
            }
          />
          <Metric
            label="Uptime"
            value={telemetry ? formatDuration(telemetry.uptimeMs) : "—"}
          />
          <Metric
            label="Input events"
            value={telemetry ? formatNumber(telemetry.inputEvents) : "—"}
            tone="warning"
          />
          <div className="ml-auto flex items-center gap-1 px-2">
            <Button
              size="icon"
              variant="ghost"
              icon={RotateCcw}
              aria-label="Reload the selected workload"
              disabled={!game}
              onClick={() => {
                if (!game) return;
                autoLaunched.current = null;
                void loadAndLaunch(game.exePath);
              }}
            />
          </div>
        </div>
      </div>

      <LogConsole
        entries={logs}
        open={logsOpen}
        onToggle={toggleLogs}
        onClear={clearLogs}
        title="Runtime console"
        height={148}
      />
    </div>
  );
}
