import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
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
  Store,
  Upload,
} from "lucide-react";
import type { StoreGame } from "@runtime/types";
import { useRuntime } from "@/hooks/useRuntime";
import { useEmulator } from "@/hooks/useEmulator";
import { useFramebuffer } from "@/hooks/useFramebuffer";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useWindowChrome } from "@/components/windows/WindowChromeContext";
import { useWindowStore } from "@/store/windowStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useEmulatorStore } from "@/store/emulatorStore";
import { toast } from "@/store/uiStore";
import { reportError } from "@/store/dialogStore";
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

function normalizeGuestPath(value: string): string {
  return value.replaceAll("/", "\\").replace(/\\+/g, "\\").toLowerCase();
}

function guestExecutableName(path: string): string {
  return path.replaceAll("/", "\\").split("\\").at(-1) ?? path;
}

function mergeGuestPaths(current: readonly string[], incoming: readonly string[]): string[] {
  const paths = new Map(current.map((path) => [normalizeGuestPath(path), path]));
  for (const path of incoming) paths.set(normalizeGuestPath(path), path);
  return [...paths.values()];
}

function requiredFilesFor(game: StoreGame): string[] {
  if (game.requiredFiles?.length) return game.requiredFiles;
  return game.exePath ? [game.exePath] : [];
}

function missingFilesFor(game: StoreGame | null, guestFiles: readonly string[]): string[] {
  if (!game) return [];
  const imported = new Set(guestFiles.map(normalizeGuestPath));
  return requiredFilesFor(game).filter((path) => !imported.has(normalizeGuestPath(path)));
}

/**
 * Emulator surface: guest scanout, controls, telemetry and the runtime console.
 *
 * Frame honesty: the canvas only receives `runtime.getFramebuffer()` output from
 * the ABI-v3 runtime; when that runtime is unavailable, guest launch stays disabled.
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
  const profileRequest = useEmulatorStore((state) => state.selectedProfileId);
  const selectedGuestExecutable = useEmulatorStore((state) => state.selectedGuestExecutable);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputNotice = useRef(false);
  const guestFileScanVersion = useRef(0);

  const [armed, setArmed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [guestFiles, setGuestFiles] = useState<string[]>([]);
  const [guestFilesLoading, setGuestFilesLoading] = useState(false);
  const [guestExecutables, setGuestExecutables] = useState<string[]>([]);
  const [guestExecutablesLoading, setGuestExecutablesLoading] = useState(false);
  /** Launch profile chosen from the browser-local library list. */
  const [pickedAppId, setPickedAppId] = useState<string | null>(null);

  const libraryEntries = useMemo(
    () => games.filter((entry) => entry.status === "in-library" && /\.exe$/i.test(entry.exePath)),
    [games],
  );

  /** A catalog entry is only a launch profile; its executable must be imported locally. */
  const game = useMemo<StoreGame | null>(() => {
    if (selectedGuestExecutable) return null;
    if (pickedAppId) return gameStore.getGame(pickedAppId);
    return libraryEntries[0] ?? null;
  }, [gameStore, libraryEntries, pickedAppId, selectedGuestExecutable]);
  const missingRequiredFiles = useMemo(
    () => missingFilesFor(game, guestFiles),
    [game, guestFiles],
  );
  const activeGuestPath = selectedGuestExecutable ?? (telemetry?.processId ? telemetry.executable : null);
  const workloadTitle = selectedGuestExecutable
    ? guestExecutableName(selectedGuestExecutable)
    : game?.title ?? (activeGuestPath ? guestExecutableName(activeGuestPath) : "No workload loaded");

  useEffect(() => {
    if (!profileRequest || games.length === 0) return;
    const requested = libraryEntries.find((entry) => entry.appId === profileRequest);
    if (requested) setPickedAppId(requested.appId);
    useEmulatorStore.getState().setSelectedProfileId(null);
  }, [games.length, libraryEntries, profileRequest]);

  useEffect(() => {
    if (mode !== "wasm" || status !== "ready") {
      setGuestFilesLoading(false);
      return;
    }
    let active = true;
    const scanVersion = guestFileScanVersion.current;
    setGuestFilesLoading(true);
    void runtime.listGameFiles()
      .then((paths) => {
        if (active && scanVersion === guestFileScanVersion.current) setGuestFiles(paths);
      })
      .catch((error: unknown) => {
        if (active && scanVersion === guestFileScanVersion.current) {
          const message = error instanceof Error ? error.message : String(error);
          toast({ title: "Could not inspect C:\\Game", message, tone: "warning" });
        }
      })
      .finally(() => {
        if (active) setGuestFilesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mode, runtime, status]);

  useEffect(() => {
    if (mode !== "wasm" || status !== "ready") {
      setGuestExecutablesLoading(false);
      return;
    }
    let active = true;
    setGuestExecutablesLoading(true);
    void runtime.listGuestExecutables()
      .then((paths) => {
        if (active) setGuestExecutables(paths);
      })
      .catch((error: unknown) => {
        if (active) {
          const message = error instanceof Error ? error.message : String(error);
          toast({ title: "Could not inspect guest executables", message, tone: "warning" });
        }
      })
      .finally(() => {
        if (active) setGuestExecutablesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [guestState, mode, runtime, status]);

  useFramebuffer(canvasRef, chrome.visible);

  useEffect(() => {
    useWindowStore
      .getState()
      .setTitle(chrome.id, `${workloadTitle} — Emulator`);
  }, [chrome.id, workloadTitle]);

  const running = guestState === "running";
  const paused = guestState === "paused";
  const hasFrames = (telemetry?.presentedFrames ?? 0) > 0;

  const launchGame = useCallback(
    (entry: StoreGame): void => {
      setPickerOpen(false);
      setPickedAppId(entry.appId);
      useEmulatorStore.getState().setSelectedGuestExecutable(null);
      if (guestFilesLoading) {
        toast({ title: "Checking mounted files", message: "The Emulator is scanning C:\\Game. Try again in a moment.", tone: "info" });
        return;
      }
      const missing = missingFilesFor(entry, guestFiles);
      if (missing.length > 0) {
        const names = missing.map((path) => path.split("\\").at(-1) ?? path);
        toast({
          title: "Import files before launching",
          message: `Choose ${names.join(", ")} from your device. Files are copied into C:\\Game; package archives downloaded by the Store stay separate and are not installed.`,
          tone: "warning",
        });
        fileInputRef.current?.click();
        return;
      }
      void loadAndLaunch(entry.exePath, entry.launchArguments ?? "");
    },
    [guestFiles, guestFilesLoading, loadAndLaunch],
  );

  const handleImportSelection = async (event: ReactChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;
    setImporting(true);
    const importVersion = ++guestFileScanVersion.current;
    try {
      if (!runtime.importFiles) {
        throw new Error("Local guest-file import requires an initialized ABI-v3 Wasm runtime. Chocolatey packages are not used.");
      }
      const paths = await runtime.importFiles(files);
      const updatedFiles = await runtime.listGameFiles().catch(() => mergeGuestPaths(guestFiles, paths));
      if (importVersion === guestFileScanVersion.current) setGuestFiles(updatedFiles);
      const missing = game ? missingFilesFor(game, updatedFiles) : [];
      const detail = paths.length === 0
        ? "No supported filenames were selected."
        : missing.length > 0
          ? `Still needed for ${game?.title ?? "this profile"}: ${missing.map((path) => path.split("\\").at(-1) ?? path).join(", ")}.`
          : `${paths.slice(0, 3).join(" · ")}${paths.length > 3 ? ` · +${paths.length - 3} more` : ""}. Click Launch when ready.`;
      toast({
        title: `${paths.length} guest file${paths.length === 1 ? "" : "s"} imported`,
        message: detail,
        tone: paths.length > 0 && missing.length === 0 ? "success" : paths.length > 0 ? "warning" : "info",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reportError({
        title: "Guest file import failed",
        body: "Files are copied only into the locally mounted C:\\Game folder. The store and Chocolatey feed are not involved.",
        details: message,
      });
    } finally {
      input.value = "";
      setImporting(false);
    }
  };

  const armInput = (): void => {
    setArmed(true);
    stageRef.current?.focus({ preventScroll: true });
    if (!inputNotice.current) {
      inputNotice.current = true;
      toast({
        title: "Input capture armed (KI-04)",
        message: "Keyboard and mouse-button state are not delivered yet (KI-04). Mouse coordinates use a separate core injection path.",
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
          <p className="truncate text-[11.5px] font-medium text-ink">{workloadTitle}</p>
          <p className="truncate font-mono text-[9.5px] text-ink-faint">
            {selectedGuestExecutable
              ? selectedGuestExecutable
              : game
                ? guestFilesLoading
                  ? "checking files in C:\\Game…"
                  : missingRequiredFiles.length > 0
                    ? `needs ${missingRequiredFiles.map((path) => path.split("\\").at(-1) ?? path).join(", ")} · import from device`
                    : game.exePath
                : activeGuestPath ?? (guestExecutablesLoading ? "scanning persistent guest C: files…" : "choose a profile or guest executable")}
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
          <Badge tone={mode === "wasm" ? "success" : "warning"} dot>
            {mode} runtime
          </Badge>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".exe,.dll,.wad,.lmp,.cfg,.dat,.pk3,.zip"
          aria-label="Choose files to copy into C:\\Game"
          className="sr-only"
          onChange={(event) => { void handleImportSelection(event); }}
        />
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="icon"
            variant="ghost"
            icon={Upload}
            aria-label="Import guest files into C:\\Game"
            title={mode === "wasm" ? "Import user-selected files into the mounted C:\\Game folder" : "Import requires an initialized ABI-v3 Wasm runtime"}
            loading={importing}
            disabled={mode !== "wasm" || running || importing}
            onClick={() => fileInputRef.current?.click()}
          />
          <div className="relative">
            <Button
              size="sm"
              variant="secondary"
              icon={Cpu}
              trailingIcon={ChevronDown}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((value) => !value)}
              disabled={libraryEntries.length === 0 && guestExecutables.length === 0}
            >
              {selectedGuestExecutable ? "Guest file" : "Profile"}
            </Button>
            {pickerOpen && (
              <div
                role="listbox"
                aria-label="Catalog profiles and guest executables"
                className="absolute right-0 top-[34px] z-20 w-[260px] overflow-hidden rounded-[10px] border border-white/10 bg-[rgba(17,17,27,0.97)] p-1 shadow-dialog backdrop-blur-xl"
              >
                {libraryEntries.map((entry) => (
                  <button
                    key={entry.appId}
                    type="button"
                    role="option"
                    aria-selected={game?.appId === entry.appId}
                    onClick={() => {
                      setPickedAppId(entry.appId);
                      useEmulatorStore.getState().setSelectedGuestExecutable(null);
                      setPickerOpen(false);
                    }}
                    className="flex w-full flex-col items-start gap-0.5 rounded-[7px] px-2.5 py-1.5 text-left transition hover:bg-white/[0.06]"
                  >
                    <span className="text-[11px] text-ink">{entry.title}</span>
                    <span className="truncate font-mono text-[9px] text-ink-faint">
                      {entry.exePath}
                    </span>
                  </button>
                ))}
                {guestExecutables.length > 0 && (
                  <div className="my-1 border-t border-white/[0.06] pt-1">
                    <p className="px-2.5 py-1 text-[8.5px] font-semibold uppercase tracking-[0.12em] text-ink-ghost">Guest executables</p>
                    {guestExecutables.map((path) => (
                      <button
                        key={path}
                        type="button"
                        role="option"
                        aria-selected={normalizeGuestPath(selectedGuestExecutable ?? "") === normalizeGuestPath(path)}
                        onClick={() => {
                          useEmulatorStore.getState().setSelectedGuestExecutable(path);
                          setPickedAppId(null);
                          setPickerOpen(false);
                        }}
                        className="flex w-full flex-col items-start gap-0.5 rounded-[7px] px-2.5 py-1.5 text-left transition hover:bg-white/[0.06]"
                      >
                        <span className="text-[10.5px] text-ink">{guestExecutableName(path)}</span>
                        <span className="truncate font-mono text-[8.5px] text-ink-faint">{path}</span>
                      </button>
                    ))}
                  </div>
                )}
                {libraryEntries.length === 0 && guestExecutables.length === 0 && (
                  <p className="px-2.5 py-2 text-[10.5px] text-ink-faint">
                    {guestExecutablesLoading ? "Scanning guest C: files…" : "No guest executables or library profiles yet."}
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
              disabled={(!selectedGuestExecutable && (!game || guestFilesLoading)) || mode !== "wasm" || status !== "ready" || importing}
              onClick={() => {
                if (selectedGuestExecutable) {
                  void loadAndLaunch(selectedGuestExecutable);
                } else if (game) {
                  launchGame(game);
                }
              }}
            >
              {selectedGuestExecutable
                ? "Launch guest file"
                : guestFilesLoading
                  ? "Checking files…"
                  : mode === "wasm" && missingRequiredFiles.length > 0
                    ? "Import files"
                    : "Launch"}
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
                      ? "Starting the runtime…"
                      : mode !== "wasm"
                        ? "ABI-v3 runtime unavailable"
                        : processHandle
                          ? "Waiting for the first present…"
                          : "No guest frames yet"}
                  </p>
                  <p className="mt-1 max-w-[46ch] text-[10.5px] leading-relaxed text-ink-faint">
                    {missingRequiredFiles.length > 0
                      ? `Required in C:\\Game: ${missingRequiredFiles.map((path) => path.split("\\").at(-1) ?? path).join(", ")}. Import the files, or use the Store's explicitly confirmed direct-EXE runner for a supported embedded x64 installer.`
                      : selectedGuestExecutable
                        ? "This PE32+ executable runs in the Wasm guest only. Keyboard and mouse-button delivery are still pending."
                        : "The canvas draws only frames reported by the ABI-v3 core. No demo image or synthetic guest frame is substituted."}
                  </p>
                </div>
                <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
                  {selectedGuestExecutable ? (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={Play}
                      disabled={mode !== "wasm" || status !== "ready" || importing}
                      onClick={() => { void loadAndLaunch(selectedGuestExecutable); }}
                    >
                      Launch {guestExecutableName(selectedGuestExecutable)}
                    </Button>
                  ) : game ? (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={missingRequiredFiles.length > 0 ? Upload : Play}
                      disabled={mode !== "wasm" || status !== "ready" || guestFilesLoading || importing}
                      onClick={() => launchGame(game)}
                    >
                      {guestFilesLoading
                        ? "Checking files…"
                        : missingRequiredFiles.length > 0
                          ? `Import files for ${game.title}`
                          : `Launch ${game.title}`}
                    </Button>
                  ) : (
                    libraryEntries[0] && (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={Play}
                        disabled={mode !== "wasm" || status !== "ready"}
                        onClick={() => launchGame(libraryEntries[0] as StoreGame)}
                      >
                        Launch {libraryEntries[0].title}
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
              <Badge tone={hasFrames ? "success" : "neutral"} dot>
                {hasFrames ? "guest frames reported" : "no guest frames"}
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
              disabled={!game || mode !== "wasm" || status !== "ready"}
              onClick={() => {
                if (!game) return;
                launchGame(game);
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
