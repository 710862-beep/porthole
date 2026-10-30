import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  Cpu,
  ExternalLink,
  HardDrive,
  Info,
  Keyboard,
  LayoutGrid,
  Monitor,
  Palette,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldAlert,
  Trash2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { StorageBackendId, StorageProbe } from "@runtime/types";
import { useRuntime } from "@/hooks/useRuntime";
import { useEmulator } from "@/hooks/useEmulator";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useWindowChrome } from "@/components/windows/WindowChromeContext";
import {
  ACCENTS,
  WALLPAPERS,
  useUiStore,
  toast,
  type AccentId,
  type WallpaperId,
} from "@/store/uiStore";
import { useWindowStore } from "@/store/windowStore";
import { confirmAction } from "@/store/dialogStore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";

type SectionId = "appearance" | "desktop" | "storage" | "runtime" | "about";

const SECTIONS: Array<{ id: SectionId; label: string; icon: LucideIcon; blurb: string }> = [
  { id: "appearance", label: "Appearance", icon: Palette, blurb: "Wallpaper, accent, motion" },
  { id: "desktop", label: "Desktop", icon: LayoutGrid, blurb: "Workspaces, windows, keys" },
  { id: "storage", label: "Storage", icon: HardDrive, blurb: "NVMe folder, OPFS, volatile" },
  { id: "runtime", label: "Runtime", icon: Cpu, blurb: "Mode, status, remount" },
  { id: "about", label: "About", icon: Info, blurb: "Build, evidence, reset" },
];

const VERSION = "0.5.0";

const AURORA_URL = `${import.meta.env.BASE_URL}wallpapers/cachy-aurora.png`;

function wallpaperPreview(id: WallpaperId): CSSProperties {
  if (id === "cachy-aurora") {
    return { backgroundImage: `url("${AURORA_URL}")`, backgroundSize: "cover", backgroundPosition: "center" };
  }
  if (id === "nebula") {
    return {
      backgroundImage:
        "radial-gradient(ellipse 60% 60% at 25% 20%, rgba(0,229,255,0.35), transparent 62%), radial-gradient(ellipse 60% 70% at 80% 70%, rgba(179,136,255,0.4), transparent 65%), linear-gradient(150deg,#0b0b14,#1b1b2c)",
    };
  }
  return {
    backgroundImage:
      "linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(150deg,#0a0a12,#161624)",
    backgroundSize: "16px 16px, 16px 16px, cover",
  };
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-[12.5px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-faint">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-[10px] border border-white/[0.07] bg-white/[0.022] p-3.5", className)}>
      {children}
    </div>
  );
}

/** Settings window. Every control writes real state; destructive actions confirm. */
export function SettingsApp() {
  const chrome = useWindowChrome();
  const { storage } = useRuntime();
  const { mode, status, telemetry, clearLogs, terminate, initialize } = useEmulator();
  const { openApp, closeAllWindows } = useWindowManager();

  const wallpaper = useUiStore((state) => state.wallpaper);
  const accent = useUiStore((state) => state.accent);
  const clock24h = useUiStore((state) => state.clock24h);
  const showSeconds = useUiStore((state) => state.showSeconds);
  const reduceMotion = useUiStore((state) => state.reduceMotion);
  const workspaceCount = useWindowStore((state) => state.workspaceCount);
  const windowCount = useWindowStore((state) => state.order.length);

  const initialSection = useMemo<SectionId>(() => {
    const requested = chrome.payload?.kind === "settings" ? chrome.payload.section : undefined;
    return SECTIONS.some((section) => section.id === requested)
      ? (requested as SectionId)
      : "appearance";
  }, [chrome.payload]);

  const [section, setSection] = useState<SectionId>(initialSection);
  const [probes, setProbes] = useState<StorageProbe[]>([]);
  const [busyBackend, setBusyBackend] = useState<StorageBackendId | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  const refreshProbes = useCallback(async (): Promise<void> => {
    setProbes(await storage.detectProbes());
  }, [storage]);

  useEffect(() => {
    void refreshProbes();
  }, [refreshProbes]);

  const selectedStorage = storage.describeSelected();

  const applyBackend = useCallback(
    async (backend: StorageBackendId): Promise<void> => {
      setBusyBackend(backend);
      setStorageError(null);
      try {
        await storage.select(backend);
        const state = storage.describeSelected();
        toast({ title: "Storage updated", message: state.detail, tone: "success" });
        await initialize(state.backend);
        await refreshProbes();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStorageError(message);
        toast({ title: "Storage change failed", message, tone: "danger" });
      } finally {
        setBusyBackend(null);
      }
    },
    [initialize, refreshProbes, storage],
  );

  const resetLayout = async (): Promise<void> => {
    const confirmed = await confirmAction({
      title: "Reset window layout?",
      body: "Every open window closes and workspace positions return to defaults. Library and preferences are kept.",
      confirmLabel: "Reset layout",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    if (telemetry?.state === "running") await terminate();
    useWindowStore.getState().resetLayout();
    toast({ title: "Layout reset", tone: "success", message: "Windows and workspaces cleared." });
  };

  const factoryReset = async (): Promise<void> => {
    const confirmed = await confirmAction({
      title: "Reset the whole desktop?",
      body: "Window layout, library entries, storage preference and appearance settings are cleared from this browser profile. Nothing outside the profile is touched.",
      confirmLabel: "Reset everything",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!confirmed) return;
    try {
      localStorage.removeItem("porthole.ui.windows.v2");
      localStorage.removeItem("porthole.ui.preferences.v2");
      localStorage.removeItem("porthole.ui.library.v2");
      localStorage.removeItem("porthole.ui.storage.v2");
    } catch {
      /* blocked storage: reload still resets in-memory state */
    }
    window.location.reload();
  };

  const canResetLayout = windowCount > 0;

  return (
    <div className="flex h-full min-h-0 bg-[#12121c]">
      <aside className="flex w-[204px] flex-none flex-col border-r border-white/[0.07] bg-black/20 p-2">
        <div className="flex items-center gap-2 px-2 py-2">
          <span className="grid h-7 w-7 place-items-center rounded-[7px] border border-warning/25 bg-warning/10 text-warning">
            <Settings2 size={14} aria-hidden />
          </span>
          <div>
            <p className="text-[11.5px] font-semibold text-ink">Settings</p>
            <p className="font-mono text-[9px] text-ink-ghost">v{VERSION}</p>
          </div>
        </div>

        <nav aria-label="Settings sections" className="mt-1 flex flex-col gap-0.5">
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active}
                onClick={() => setSection(item.id)}
                className={cn(
                  "flex items-start gap-2.5 rounded-[7px] px-2 py-1.5 text-left transition-colors",
                  active
                    ? "bg-white/[0.08] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
                    : "hover:bg-white/[0.04]",
                )}
              >
                <Icon
                  size={13}
                  className={cn("mt-0.5", active ? "text-accent" : "text-ink-faint")}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className={cn("block text-[11.5px]", active ? "text-ink" : "text-ink-muted")}>
                    {item.label}
                  </span>
                  <span className="block truncate text-[9px] text-ink-ghost">{item.blurb}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="mt-auto space-y-2 p-2">
          <Badge tone={mode === "mock" ? "warning" : "success"} dot className="w-fit">
            {mode} runtime
          </Badge>
          <p className="text-[9px] leading-relaxed text-ink-ghost">
            Preferences persist in <code className="font-mono">localStorage</code>. Folder access is
            session-scoped by the browser.
          </p>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {section === "appearance" && (
          <>
            <Section
              title="Wallpaper"
              description="The generated aurora plate ships with the shell; the other two are procedural CSS."
            >
              <div className="grid grid-cols-3 gap-2.5">
                {WALLPAPERS.map((option) => {
                  const active = wallpaper === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        useUiStore.getState().setWallpaper(option.id);
                      }}
                      className={cn(
                        "group overflow-hidden rounded-[9px] border text-left transition",
                        active
                          ? "border-accent/55 shadow-[0_0_0_1px_rgb(var(--accent-rgb)/0.25),0_14px_36px_-18px_rgba(0,0,0,0.8)]"
                          : "border-white/[0.08] hover:border-white/[0.18]",
                      )}
                    >
                      <div className="relative aspect-[16/9] w-full" style={wallpaperPreview(option.id)}>
                        {active && (
                          <span className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-accent text-[#06131b]">
                            <Check size={12} aria-hidden />
                          </span>
                        )}
                      </div>
                      <div className="bg-black/25 px-2.5 py-2">
                        <p className="text-[10.5px] font-medium text-ink">{option.label}</p>
                        <p className="mt-0.5 truncate text-[9px] text-ink-ghost">{option.blurb}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section
              title="Accent"
              description="Drives highlights, focus rings and the running-app indicator."
            >
              <div className="flex flex-wrap items-center gap-2">
                {(Object.keys(ACCENTS) as AccentId[]).map((id) => {
                  const option = ACCENTS[id];
                  const active = accent === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={active}
                      aria-label={`${option.label} accent`}
                      onClick={() => {
                        useUiStore.getState().setAccent(id);
                      }}
                      className={cn(
                        "flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 transition",
                        active
                          ? "border-white/[0.2] bg-white/[0.07]"
                          : "border-white/[0.08] hover:border-white/[0.16] hover:bg-white/[0.04]",
                      )}
                    >
                      <span
                        className="block h-5 w-5 rounded-full border border-white/15"
                        style={{
                          background: `linear-gradient(135deg, rgb(${option.accent.join(" ")}) 0%, rgb(${option.accentAlt.join(" ")}) 100%)`,
                        }}
                      />
                      <span className="text-[10.5px] text-ink-muted">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section title="Behaviour" description="Shell-level preferences. Motion respects the OS setting too.">
              <Card className="flex flex-col gap-4">
                <Switch
                  checked={clock24h}
                  onChange={(value) => useUiStore.getState().setClock24h(value)}
                  label="24-hour clock"
                  description="Show the panel clock as HH:MM instead of 12-hour time."
                />
                <Switch
                  checked={showSeconds}
                  onChange={(value) => useUiStore.getState().setShowSeconds(value)}
                  label="Show seconds"
                  description="Ticks the panel clock every second (slightly more wake-ups)."
                />
                <Switch
                  checked={reduceMotion}
                  onChange={(value) => useUiStore.getState().setReduceMotion(value)}
                  label="Reduce motion"
                  description="Disable window/card animations for this shell (OS preference still applies)."
                />
              </Card>
            </Section>
          </>
        )}

        {section === "desktop" && (
          <>
            <Section title="Workspaces" description="KDE-style virtual desktops. Windows remember their desktop.">
              <Card>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[11.5px] text-ink">Number of desktops</p>
                    <p className="mt-0.5 text-[10px] text-ink-faint">
                      Existing windows on removed desktops are moved back to desktop 1.
                    </p>
                  </div>
                  <SegmentedControl
                    ariaLabel="Workspace count"
                    value={String(workspaceCount)}
                    options={[
                      { value: "2", label: "2" },
                      { value: "4", label: "4" },
                      { value: "6", label: "6" },
                      { value: "8", label: "8" },
                    ]}
                    onChange={(value) => useWindowStore.getState().setWorkspaceCount(Number(value))}
                  />
                </div>
              </Card>
            </Section>

            <Section title="Windows" description="All actions are immediate unless marked destructive.">
              <Card className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={LayoutGrid}
                    onClick={() => openApp("system")}
                  >
                    System Monitor
                  </Button>
                  <Button size="sm" variant="secondary" icon={Monitor} onClick={() => void closeAllWindows()}>
                    Close all windows
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={RotateCcw}
                    disabled={!canResetLayout}
                    onClick={() => void resetLayout()}
                  >
                    Reset layout
                  </Button>
                </div>
                <p className="text-[10px] leading-relaxed text-ink-faint">
                  Closing a window with a live guest asks for confirmation before the process stops.
                  The layout survives a reload; the running process does not.
                </p>
              </Card>
            </Section>

            <Section title="Shortcuts" description="Global, always handled by the shell.">
              <Card>
                <ul className="grid grid-cols-2 gap-x-6 gap-y-2 text-[10.5px] text-ink-muted">
                  {[
                    { keys: ["Super"], label: "Toggle Overview" },
                    { keys: ["Super", "E"], label: "Application launcher" },
                    { keys: ["Super", "D"], label: "Overview (show desktops)" },
                    { keys: ["Super", "W"], label: "Workspace overview" },
                    { keys: ["Super", "L"], label: "Lock screen" },
                    { keys: ["Esc"], label: "Close Overview / launcher" },
                    { keys: ["Top-left"], label: "Hot corner → Overview" },
                    { keys: ["Double-click"], label: "Titlebar maximize" },
                  ].map((item) => (
                    <li key={item.label} className="flex items-center justify-between gap-3">
                      <span>{item.label}</span>
                      <span className="flex items-center gap-1">
                        {item.keys.map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 flex items-center gap-1.5 text-[9.5px] text-ink-ghost">
                  <Keyboard size={10} aria-hidden />
                  Tip: right-click a titlebar for move / workspace / close actions.
                </p>
              </Card>
            </Section>
          </>
        )}

        {section === "storage" && (
          <>
            <Section
              title="Current backend"
              description="Guest RAM overflow and VFS shards use this backend. Folder access is session-scoped."
            >
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <span className="grid h-9 w-9 place-items-center rounded-[9px] border border-accent/25 bg-accent/10 text-accent">
                      <HardDrive size={16} aria-hidden />
                    </span>
                    <div>
                      <p className="text-[12px] font-medium text-ink">{selectedStorage.label}</p>
                      <p className="mt-0.5 max-w-[52ch] text-[10px] leading-relaxed text-ink-faint">
                        {selectedStorage.detail}
                      </p>
                      <code className="mt-1 inline-block rounded-[4px] bg-black/30 px-1.5 py-0.5 font-mono text-[9px] text-ink-ghost">
                        {selectedStorage.backend}
                      </code>
                    </div>
                  </div>
                  <Badge tone="warning">session</Badge>
                </div>
              </Card>
            </Section>

            {storageError && (
              <div className="mb-4 flex items-start gap-2 rounded-[9px] border border-danger/25 bg-danger/[0.07] px-3 py-2">
                <AlertCircle size={12} className="mt-0.5 flex-none text-danger" aria-hidden />
                <p className="text-[10px] leading-relaxed text-danger/90">{storageError}</p>
              </div>
            )}

            <Section title="Available backends" description="Probed live from this browser. Availability is a fact, not a promise.">
              <div className="flex flex-col gap-2">
                {probes.map((probe) => {
                  const active = selectedStorage.backend === probe.backend;
                  return (
                    <Card key={probe.backend} className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-[11.5px] font-medium text-ink">
                          {probe.label}
                          {probe.recommended && <Badge tone="accent">recommended</Badge>}
                          {active && <Badge tone="success" dot>active</Badge>}
                        </p>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-ink-faint">
                          {probe.description}
                        </p>
                        <p className="mt-1 truncate font-mono text-[9px] text-ink-ghost">
                          {probe.detail}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={active ? "ghost" : "secondary"}
                        disabled={!probe.available || busyBackend !== null}
                        loading={busyBackend === probe.backend}
                        onClick={() => void applyBackend(probe.backend)}
                      >
                        {active ? "Re-mount" : probe.backend === "file-system-access" ? "Choose folder…" : "Use"}
                      </Button>
                    </Card>
                  );
                })}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Button size="xs" variant="ghost" icon={RefreshCw} onClick={() => void refreshProbes()}>
                  Rescan capabilities
                </Button>
                <span className="text-[9px] text-ink-ghost">
                  Changing the backend remounts the runtime immediately.
                </span>
              </div>
            </Section>

            <Section title="Why session-scoped?" description="Browser security, not a shell limitation.">
              <Card className="flex gap-2.5">
                <ShieldAlert size={13} className="mt-0.5 flex-none text-warning" aria-hidden />
                <p className="text-[10px] leading-relaxed text-ink-faint">
                  A directory handle cannot be persisted across reloads. After a refresh the shell
                  falls back to OPFS and says so instead of pretending the folder is still mounted.
                  Re-select the folder here to use it again.
                </p>
              </Card>
            </Section>
          </>
        )}

        {section === "runtime" && (
          <>
            <Section title="Runtime" description="This shell drives the labelled mock runtime behind ui/runtime/contracts.ts.">
              <div className="grid grid-cols-2 gap-2.5">
                <Card>
                  <p className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">Mode</p>
                  <p className="mt-1 flex items-center gap-2 text-[12px] text-ink">
                    {mode}
                    <Badge tone={mode === "mock" ? "warning" : "success"} dot>
                      {mode === "mock" ? "synthetic" : "wasm"}
                    </Badge>
                  </p>
                </Card>
                <Card>
                  <p className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">Shell status</p>
                  <p className="mt-1 text-[12px] text-ink">{status}</p>
                </Card>
                <Card>
                  <p className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">Guest state</p>
                  <p className="mt-1 text-[12px] text-ink">{telemetry?.state ?? "idle"}</p>
                </Card>
                <Card>
                  <p className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">Storage</p>
                  <p className="mt-1 truncate text-[12px] text-ink">{selectedStorage.label}</p>
                </Card>
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={RefreshCw}
                  onClick={() => {
                    void initialize(selectedStorage.backend);
                    toast({ title: "Runtime re-initialised", message: "Mock remount only.", tone: "info" });
                  }}
                >
                  Re-initialise
                </Button>
                <Button size="sm" variant="secondary" icon={Cpu} onClick={() => openApp("emulator")}>
                  Open Emulator
                </Button>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={clearLogs}>
                  Clear logs
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={XCircle}
                  disabled={telemetry?.state !== "running" && telemetry?.state !== "paused"}
                  onClick={() => void terminate()}
                >
                  Stop guest
                </Button>
              </div>
            </Section>

            <Section title="Swapping in the real core" description="The shell never imports the emulator directly.">
              <Card className="flex gap-2.5">
                <Info size={13} className="mt-0.5 flex-none text-accent" aria-hidden />
                <p className="text-[10px] leading-relaxed text-ink-faint">
                  Implement <code className="font-mono text-ink-muted">ExtendedEmulatorRuntime</code>{" "}
                  over <code className="font-mono text-ink-muted">BrowserX64Emulator</code> in{" "}
                  <code className="font-mono text-ink-muted">ui/runtime</code>, return it from{" "}
                  <code className="font-mono text-ink-muted">createRuntimeBundle()</code>, and every
                  window, dialog and telemetry surface keeps working. Frames must come from{" "}
                  <code className="font-mono text-ink-muted">guest_frame_rgba()</code> gated on{" "}
                  <code className="font-mono text-ink-muted">presented_frames()</code>.
                </p>
              </Card>
            </Section>
          </>
        )}

        {section === "about" && (
          <>
            <Section title="Porthole desktop" description="A browser desktop shell for the Porthole x86-64 runtime.">
              <Card>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[13px] font-semibold text-ink">Porthole {VERSION}</p>
                    <p className="mt-1 max-w-[60ch] text-[10.5px] leading-relaxed text-ink-faint">
                      React + TypeScript shell with Tailwind design tokens, CSS-module glass
                      materials, Zustand state and Framer Motion. The UI lives entirely in{" "}
                      <code className="font-mono">ui/</code> and consumes only{" "}
                      <code className="font-mono">ui/runtime/contracts.ts</code> shapes.
                    </p>
                  </div>
                  <Badge tone="accent">CachyOS-flavoured</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href="https://github.com/710862-beep/porthole"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex h-8 items-center gap-1.5 rounded-control border border-white/10 bg-white/[0.05] px-3 text-[11px] text-ink-muted transition hover:bg-white/[0.09] hover:text-ink"
                  >
                    <ExternalLink size={12} aria-hidden />
                    Repository
                  </a>
                  <a
                    href="https://github.com/710862-beep/porthole/blob/main/docs/FINAL-STATUS-REPORT.md"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex h-8 items-center gap-1.5 rounded-control border border-white/10 bg-white/[0.05] px-3 text-[11px] text-ink-muted transition hover:bg-white/[0.09] hover:text-ink"
                  >
                    <ExternalLink size={12} aria-hidden />
                    Evidence report
                  </a>
                  <a
                    href="https://github.com/710862-beep/porthole/blob/main/ARCHITECTURE.md"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex h-8 items-center gap-1.5 rounded-control border border-white/10 bg-white/[0.05] px-3 text-[11px] text-ink-muted transition hover:bg-white/[0.09] hover:text-ink"
                  >
                    <ExternalLink size={12} aria-hidden />
                    Architecture
                  </a>
                </div>
              </Card>
            </Section>

            <Section
              title="Factory reset"
              description="Clears this profile's desktop state. Does not touch your mounted folder or the repository."
            >
              <Card className="flex items-center justify-between gap-4 border-danger/20 bg-danger/[0.04]">
                <div>
                  <p className="text-[11.5px] text-ink">Reset windows, library and preferences</p>
                  <p className="mt-0.5 text-[10px] text-ink-faint">
                    The shell reloads into the first-run storage setup.
                  </p>
                </div>
                <Button size="sm" variant="danger" icon={RotateCcw} onClick={() => void factoryReset()}>
                  Factory reset
                </Button>
              </Card>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
