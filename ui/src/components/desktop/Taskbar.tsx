import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Activity,
  Cpu,
  HardDrive,
  Info,
  LayoutGrid,
  Lock,
  Settings2,
  Volume1,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { APPS, PINNED_APPS, type AppDefinition, type AppId } from "@/store/apps";
import { useUiStore } from "@/store/uiStore";
import { useEmulatorStore } from "@/store/emulatorStore";
import { useWindowStore, type WindowInstance } from "@/store/windowStore";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useClock } from "@/hooks/useClock";
import { AppIcon } from "@/components/ui/AppIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PortholeMark } from "@/components/ui/PortholeMark";
import styles from "@/styles/desktop.module.css";
import { cn } from "@/lib/cn";
import { TrayPopover } from "./TrayPopover";

type TrayMenu = "volume" | "network" | "clock" | null;

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

interface TaskbarAppButtonProps {
  app: AppDefinition;
  running: boolean;
  active: boolean;
  onClick: () => void;
}

function TaskbarAppButton({ app, running, active, onClick }: TaskbarAppButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={styles.appButton}
      data-running={running || undefined}
      data-active={active || undefined}
      aria-label={`${app.title}${running ? " (running)" : ""}`}
      title={`${app.title} — ${running ? "focus or minimise" : "open"}`}
    >
      <AppIcon icon={app.icon} tint={app.tint} size={26} iconSize={16} bare />
    </button>
  );
}

interface TrayRowProps {
  icon: LucideIcon;
  label: string;
  value: string;
  valueClassName?: string;
}

function TrayRow({ icon: Icon, label, value, valueClassName }: TrayRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[7px] px-2 py-[7px]">
      <span className="flex items-center gap-2 text-[11px] text-ink-muted">
        <Icon size={12} className="text-ink-faint" aria-hidden />
        {label}
      </span>
      <span className={cn("truncate font-mono text-[10.5px] text-ink", valueClassName)}>
        {value}
      </span>
    </div>
  );
}

/**
 * Bottom panel: launcher, pinned + running apps, overview toggle, tray flyouts
 * and the clock. Height 48px, frosted glass, running indicators per app.
 */
export function Taskbar() {
  const { openApp } = useWindowManager();
  const windows = useWindowStore((state) => state.windows);
  const order = useWindowStore((state) => state.order);
  const focusedId = useWindowStore((state) => state.focusedId);
  const workspace = useWindowStore((state) => state.workspace);
  const workspaceCount = useWindowStore((state) => state.workspaceCount);
  const setWorkspace = useWindowStore((state) => state.setWorkspace);

  const launcherOpen = useUiStore((state) => state.launcherOpen);
  const toggleLauncher = useUiStore((state) => state.toggleLauncher);
  const overviewOpen = useUiStore((state) => state.overviewOpen);
  const openOverview = useUiStore((state) => state.openOverview);
  const closeOverview = useUiStore((state) => state.closeOverview);
  const lock = useUiStore((state) => state.lock);
  const clock24h = useUiStore((state) => state.clock24h);
  const showSeconds = useUiStore((state) => state.showSeconds);

  const clock = useClock(clock24h, showSeconds);
  const online = useOnlineStatus();
  const storage = useEmulatorStore((state) => state.storage);
  const mode = useEmulatorStore((state) => state.mode);
  const telemetry = useEmulatorStore((state) => state.telemetry);

  const [menu, setMenu] = useState<TrayMenu>(null);
  const [volume, setVolume] = useState(62);
  const [muted, setMuted] = useState(false);

  const runningApps = useMemo(() => {
    const apps = new Set<AppId>();
    for (const id of order) {
      const instance = windows[id];
      if (instance) apps.add(instance.appId);
    }
    return apps;
  }, [order, windows]);

  const activeApp = useMemo<AppId | null>(() => {
    if (!focusedId) return null;
    const focused = windows[focusedId];
    if (!focused || focused.status === "minimized") return null;
    return focused.appId;
  }, [focusedId, windows]);

  const taskbarApps = useMemo(() => {
    const extras = [...runningApps].filter((appId) => !PINNED_APPS.includes(appId));
    return [...PINNED_APPS, ...extras].map((appId) => APPS[appId]);
  }, [runningApps]);

  const closeMenu = useCallback(() => setMenu(null), []);
  const toggleMenu = useCallback(
    (which: Exclude<TrayMenu, null>) => setMenu((current) => (current === which ? null : which)),
    [],
  );

  const handleAppClick = useCallback(
    (appId: AppId) => {
      closeMenu();
      const state = useWindowStore.getState();
      const instances = state.order
        .map((id) => state.windows[id])
        .filter((instance): instance is WindowInstance => Boolean(instance))
        .filter((instance) => instance.appId === appId);

      if (instances.length === 0) {
        openApp(appId);
        return;
      }

      const focusedHere = instances.find(
        (instance) =>
          instance.id === state.focusedId &&
          instance.workspace === state.workspace &&
          instance.status !== "minimized",
      );
      if (focusedHere) {
        state.minimizeWindow(focusedHere.id);
        return;
      }

      const target =
        instances
          .filter((instance) => instance.status !== "minimized")
          .sort((a, b) => b.zIndex - a.zIndex)[0] ?? instances[0];
      if (!target) return;
      state.restoreWindow(target.id);
      state.focusWindow(target.id);
    },
    [closeMenu, openApp],
  );

  const handleLauncher = (): void => {
    setMenu(null);
    toggleLauncher();
  };

  const volumeIcon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  return (
    <nav className={styles.taskbar} aria-label="Desktop panel">
      <button
        type="button"
        className={styles.launcherButton}
        data-open={launcherOpen || undefined}
        aria-haspopup="dialog"
        aria-expanded={launcherOpen}
        aria-label="Application launcher"
        title="Application launcher (Super+E)"
        onClick={handleLauncher}
      >
        <PortholeMark size={22} className={styles.logoMark} />
        <span className="hidden text-[12px] font-semibold tracking-[-0.01em] text-ink lg:block">
          Porthole
        </span>
      </button>

      <span className={styles.panelDivider} aria-hidden />

      <div
        className="flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-hidden"
        role="toolbar"
        aria-label="Applications"
      >
        {taskbarApps.map((app) => (
          <TaskbarAppButton
            key={app.id}
            app={app}
            running={runningApps.has(app.id)}
            active={activeApp === app.id}
            onClick={() => handleAppClick(app.id)}
          />
        ))}
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          className={styles.trayButton}
          data-open={overviewOpen || undefined}
          aria-label={overviewOpen ? "Close Overview" : "Open Overview"}
          aria-pressed={overviewOpen}
          title="Overview (Super)"
          onClick={() => {
            closeMenu();
            if (overviewOpen) closeOverview();
            else openOverview();
          }}
        >
          <LayoutGrid size={15} aria-hidden />
        </button>

        <span className={styles.panelDivider} aria-hidden />

        <button
          type="button"
          className={styles.trayButton}
          data-open={menu === "volume" || undefined}
          aria-label={`Audio${muted ? ", muted" : `, ${volume} percent`}`}
          aria-haspopup="dialog"
          aria-expanded={menu === "volume"}
          onClick={() => toggleMenu("volume")}
        >
          {(() => {
            const VolumeIcon = volumeIcon;
            return <VolumeIcon size={15} aria-hidden />;
          })()}
        </button>

        <button
          type="button"
          className={styles.trayButton}
          data-open={menu === "network" || undefined}
          aria-label={online ? "Network: online" : "Network: offline"}
          aria-haspopup="dialog"
          aria-expanded={menu === "network"}
          onClick={() => toggleMenu("network")}
        >
          {online ? (
            <Wifi size={15} aria-hidden />
          ) : (
            <WifiOff size={15} className="text-danger" aria-hidden />
          )}
        </button>

        <button
          type="button"
          className={cn(styles.clock, "ml-0.5 flex-col items-end justify-center gap-0 !py-0")}
          data-open={menu === "clock" || undefined}
          aria-label={`${clock.time}, ${clock.date}. Open clock and session menu`}
          aria-haspopup="dialog"
          aria-expanded={menu === "clock"}
          onClick={() => toggleMenu("clock")}
        >
          <span className="text-[11.5px] font-medium leading-tight">{clock.time}</span>
          <span className="text-[8.5px] leading-tight text-ink-faint">{clock.date}</span>
        </button>
      </div>

      <TrayPopover open={menu === "volume"} onClose={closeMenu} label="Audio" width={292}>
        <div className="p-2">
          <div className="flex items-center justify-between px-1 pb-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              Audio
            </span>
            <span className="font-mono text-[10.5px] text-ink-muted">
              {muted ? "muted" : `${volume}%`}
            </span>
          </div>
          <div className="flex items-center gap-2.5 px-1">
            <button
              type="button"
              aria-label={muted ? "Unmute" : "Mute"}
              onClick={() => setMuted((value) => !value)}
              className="grid h-8 w-8 flex-none place-items-center rounded-[7px] text-ink-muted transition hover:bg-white/[0.07] hover:text-ink"
            >
              {muted ? <VolumeX size={15} aria-hidden /> : <Volume2 size={15} aria-hidden />}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={muted ? 0 : volume}
              aria-label="Shell output volume"
              onChange={(event) => {
                setVolume(Number(event.target.value));
                setMuted(false);
              }}
              className={styles.range}
              style={{ "--range-progress": `${muted ? 0 : volume}%` } as CSSProperties}
            />
          </div>
          <p className="mt-3 px-1 text-[10.5px] leading-relaxed text-ink-ghost">
            Shell output level only. The guest audio device is not exposed in this build.
          </p>
        </div>
      </TrayPopover>

      <TrayPopover open={menu === "network"} onClose={closeMenu} label="Network" width={318}>
        <div className="p-2">
          <div className="flex items-center justify-between px-1 pb-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              Network
            </span>
            <Badge tone={online ? "success" : "danger"} dot>
              {online ? "online" : "offline"}
            </Badge>
          </div>
          <div className="rounded-[9px] border border-white/[0.06] bg-black/20">
            <TrayRow
              icon={online ? Wifi : WifiOff}
              label="Browser link"
              value={online ? "connected" : "disconnected"}
            />
            <TrayRow icon={Cpu} label="Runtime" value={mode} />
            <TrayRow icon={HardDrive} label="Storage" value={storage?.label ?? "OPFS"} />
            <TrayRow
              icon={Activity}
              label="Guest transport"
              value="not exposed"
              valueClassName="text-ink-faint"
            />
          </div>
          <p className="mt-2 px-1 text-[10.5px] leading-relaxed text-ink-ghost">
            Networking is provided by the browser. This desktop does not claim guest
            connectivity.
          </p>
          <div className="mt-2.5 grid grid-cols-2 gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              icon={Activity}
              onClick={() => {
                closeMenu();
                openApp("system");
              }}
            >
              Monitor
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={Settings2}
              onClick={() => {
                closeMenu();
                openApp("settings");
              }}
            >
              Settings
            </Button>
          </div>
        </div>
      </TrayPopover>

      <TrayPopover open={menu === "clock"} onClose={closeMenu} label="Clock and session" width={338}>
        <div className="p-3">
          <p className="text-[26px] font-extralight leading-none tracking-[-0.02em] tabular-nums text-ink">
            {clock.time}
          </p>
          <p className="mt-1.5 text-[11.5px] text-ink-muted">
            {new Date(clock.iso).toLocaleDateString(undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>

          <div className="my-3 h-px bg-white/[0.07]" />

          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              Workspaces
            </span>
            <span className="font-mono text-[10.5px] text-ink-muted">
              {workspace + 1}/{workspaceCount}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {Array.from({ length: workspaceCount }, (_, index) => (
              <button
                key={index}
                type="button"
                onClick={() => {
                  setWorkspace(index);
                  closeMenu();
                }}
                className={cn(
                  "flex h-8 items-center justify-center rounded-[7px] border text-[11px] font-medium transition",
                  index === workspace
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-white/[0.07] bg-white/[0.03] text-ink-muted hover:border-white/15 hover:text-ink",
                )}
              >
                {index + 1}
              </button>
            ))}
          </div>

          <div className="mt-3 rounded-[9px] border border-white/[0.06] bg-black/20">
            <TrayRow icon={HardDrive} label="Storage" value={storage?.label ?? "OPFS"} />
            <TrayRow
              icon={Cpu}
              label="Guest"
              value={telemetry?.state ?? "idle"}
              valueClassName={telemetry?.state === "running" ? "text-success" : undefined}
            />
          </div>

          <div className="mt-2.5 grid grid-cols-2 gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              icon={LayoutGrid}
              onClick={() => {
                closeMenu();
                openOverview();
              }}
            >
              Overview
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={Lock}
              onClick={() => {
                closeMenu();
                lock();
              }}
            >
              Lock screen
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={Settings2}
              onClick={() => {
                closeMenu();
                openApp("settings");
              }}
            >
              Settings
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={Info}
              onClick={() => {
                closeMenu();
                openApp("welcome");
              }}
            >
              About
            </Button>
          </div>
        </div>
      </TrayPopover>
    </nav>
  );
}
