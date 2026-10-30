import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Gauge,
  Globe2,
  HardDrive,
  MemoryStick,
  RefreshCw,
  ScrollText,
  Settings2,
  ShieldAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { StorageProbe } from "@runtime/types";
import { useRuntime } from "@/hooks/useRuntime";
import { useEmulator } from "@/hooks/useEmulator";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useWindowChrome } from "@/components/windows/WindowChromeContext";
import { copyText } from "@/lib/clipboard";
import { formatDuration, formatNumber, shortHash } from "@/lib/format";
import { toast } from "@/store/uiStore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { LogConsole } from "@/components/ui/LogConsole";
import { ProgressBar } from "@/components/ui/ProgressBar";

interface Capability {
  id: string;
  label: string;
  detail: string;
  ok: boolean;
}

function detectHostCapabilities(): Capability[] {
  const wasm =
    typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
  const threads =
    typeof SharedArrayBuffer === "function" &&
    typeof crossOriginIsolated !== "undefined" &&
    crossOriginIsolated;
  const webgpu = typeof navigator !== "undefined" && "gpu" in navigator;

  let webgl2 = false;
  try {
    const canvas = document.createElement("canvas");
    webgl2 = canvas.getContext("webgl2") !== null;
  } catch {
    webgl2 = false;
  }

  const opfs =
    typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";

  return [
    {
      id: "wasm",
      label: "WebAssembly",
      detail: wasm ? "instantiate() available" : "unavailable in this engine",
      ok: wasm,
    },
    {
      id: "threads",
      label: "Shared memory threads",
      detail: threads
        ? "crossOriginIsolated with SharedArrayBuffer"
        : "not isolated — threaded Wasm disabled",
      ok: threads,
    },
    {
      id: "webgpu",
      label: "WebGPU",
      detail: webgpu ? "navigator.gpu present" : "no navigator.gpu",
      ok: webgpu,
    },
    {
      id: "webgl2",
      label: "WebGL2",
      detail: webgl2 ? "context created" : "context unavailable",
      ok: webgl2,
    },
    {
      id: "opfs",
      label: "Origin private FS",
      detail: opfs ? "navigator.storage.getDirectory()" : "missing",
      ok: opfs,
    },
  ];
}

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  tone?: "accent" | "violet" | "success" | "warning" | "danger";
}

const TONE_TEXT: Record<NonNullable<StatCardProps["tone"]>, string> = {
  accent: "text-accent",
  violet: "text-violet",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

function StatCard({ icon: Icon, label, value, hint, tone = "accent" }: StatCardProps) {
  return (
    <div className="rounded-[10px] border border-white/[0.07] bg-white/[0.025] p-3">
      <div className="flex items-center gap-1.5">
        <Icon size={12} className={TONE_TEXT[tone]} aria-hidden />
        <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-ink-ghost">
          {label}
        </span>
      </div>
      <p className="mt-1.5 truncate font-mono text-[15px] tabular-nums text-ink">{value}</p>
      {hint && <p className="mt-0.5 truncate text-[9.5px] text-ink-ghost">{hint}</p>}
    </div>
  );
}

/** Live telemetry, storage probes and host capabilities. Explicitly labels mock data. */
export function SystemMonitorApp() {
  const chrome = useWindowChrome();
  const { storage, runtime } = useRuntime();
  const { telemetry, guestState, mode, status, logs, logsOpen, clearLogs, toggleLogs, terminate } =
    useEmulator();
  const { openApp } = useWindowManager();

  const [probes, setProbes] = useState<StorageProbe[]>([]);
  const [probing, setProbing] = useState(false);
  const diagnosticsRef = useRef<HTMLDivElement | null>(null);
  const capabilities = useMemo(detectHostCapabilities, []);
  const selectedStorage = storage.describeSelected();

  const refreshProbes = useCallback(async (): Promise<void> => {
    setProbing(true);
    try {
      setProbes(await storage.detectProbes());
    } finally {
      setProbing(false);
    }
  }, [storage]);

  useEffect(() => {
    void refreshProbes();
  }, [refreshProbes]);

  useEffect(() => {
    if (chrome.payload?.kind !== "system-report" || chrome.payload.section !== "diagnostics") return;
    const timer = window.setTimeout(() => {
      const target = diagnosticsRef.current;
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [chrome.payload]);

  const residentRatio = telemetry
    ? (telemetry.residentPages / Math.max(1, telemetry.maxResidentPages)) * 100
    : 0;

  const copyReport = async (): Promise<void> => {
    const report = {
      generatedAt: new Date().toISOString(),
      shell: "porthole-desktop@0.5.0",
      runtimeMode: mode,
      runtimeStatus: status,
      guestState,
      telemetry,
      storage: selectedStorage,
      probes,
      capabilities,
    };
    const ok = await copyText(JSON.stringify(report, null, 2));
    toast({
      title: ok ? "Report copied" : "Copy failed",
      message: ok ? "Paste it into a bug report or PR." : "Clipboard permission was denied.",
      tone: ok ? "success" : "danger",
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#12121c]">
      <header className="flex flex-none items-center gap-3 border-b border-white/[0.07] px-4 py-2.5">
        <span className="grid h-8 w-8 flex-none place-items-center rounded-[8px] border border-info/25 bg-info/10 text-info">
          <Activity size={15} aria-hidden />
        </span>
        <div>
          <h1 className="text-[13px] font-semibold text-ink">System Monitor</h1>
          <p className="text-[9.5px] text-ink-faint">
            shell telemetry · storage probes · host capabilities
          </p>
        </div>
        <div className="ml-2 flex items-center gap-1.5">
          <Badge tone={mode === "mock" ? "warning" : "success"} dot>
            {mode} runtime
          </Badge>
          <Badge tone={guestState === "running" ? "success" : "neutral"} dot>
            {guestState}
          </Badge>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => void refreshProbes()} loading={probing}>
            Rescan
          </Button>
          <Button size="sm" variant="secondary" icon={Cpu} onClick={() => openApp("emulator")}>
            Emulator
          </Button>
          <Button size="sm" variant="ghost" icon={ScrollText} aria-pressed={logsOpen} onClick={toggleLogs}>
            Console
          </Button>
          <Button size="sm" variant="primary" icon={Gauge} onClick={() => void copyReport()}>
            Copy report
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {mode === "mock" && (
          <div className="mb-3 flex items-start gap-2.5 rounded-[10px] border border-warning/25 bg-warning/[0.07] px-3.5 py-2.5">
            <AlertTriangle size={14} className="mt-0.5 flex-none text-warning" aria-hidden />
            <p className="text-[10.5px] leading-relaxed text-warning/90">
              <strong className="font-semibold">Mock runtime.</strong> Frames, instructions and
              present counts below are synthetic. Swap the runtime adapter in{" "}
              <code className="font-mono">ui/runtime</code> for the Wasm core and the same UI shows
              guest evidence — nothing in this screen is a compatibility claim.
            </p>
          </div>
        )}

        <div className="grid grid-cols-4 gap-2.5">
          <StatCard
            icon={Activity}
            label="Guest state"
            value={guestState}
            hint={telemetry?.executable ?? "no executable"}
            tone={guestState === "running" ? "success" : guestState === "faulted" ? "danger" : "accent"}
          />
          <StatCard
            icon={Cpu}
            label="Instructions"
            value={telemetry ? formatNumber(telemetry.instructionsExecuted) : "—"}
            hint="synthetic pace in mock mode"
            tone="violet"
          />
          <StatCard
            icon={Gauge}
            label="Presented frames"
            value={telemetry ? formatNumber(telemetry.presentedFrames) : "—"}
            hint={telemetry?.fps ? `${telemetry.fps} fps host present` : "not presenting"}
          />
          <StatCard
            icon={MemoryStick}
            label="Resident pages"
            value={telemetry ? `${telemetry.residentPages} / ${telemetry.maxResidentPages}` : "—"}
            hint={`${Math.round(residentRatio)}% of the sparse window`}
            tone={residentRatio > 85 ? "warning" : "success"}
          />
        </div>

        <div className="mt-2.5 grid grid-cols-3 gap-2.5">
          <div className="col-span-2 rounded-[10px] border border-white/[0.07] bg-white/[0.025] p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                VMM resident window
              </span>
              <span className="font-mono text-[10px] text-ink-muted">
                {telemetry ? `${Math.round(residentRatio)}%` : "idle"}
              </span>
            </div>
            <ProgressBar
              value={residentRatio}
              size="md"
              tone={residentRatio > 85 ? "warning" : "accent"}
              className="mt-2"
            />
            <div className="mt-2.5 grid grid-cols-3 gap-2 font-mono text-[9.5px] text-ink-ghost">
              <span>process {telemetry?.processId ?? "none"}</span>
              <span>uptime {telemetry ? formatDuration(telemetry.uptimeMs) : "0:00"}</span>
              <span className="truncate">
                checksum{" "}
                {telemetry?.frameChecksum
                  ? shortHash(telemetry.frameChecksum, 10, 4)
                  : "—"}
              </span>
            </div>
          </div>

          <div className="rounded-[10px] border border-white/[0.07] bg-white/[0.025] p-3.5">
            <div className="flex items-center gap-1.5">
              <HardDrive size={12} className="text-accent" aria-hidden />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Storage backend
              </span>
            </div>
            <p className="mt-1.5 truncate text-[11.5px] font-medium text-ink">
              {selectedStorage.label}
            </p>
            <p className="mt-1 line-clamp-3 text-[9.5px] leading-relaxed text-ink-ghost">
              {selectedStorage.detail}
            </p>
            <Button
              size="xs"
              variant="secondary"
              icon={Settings2}
              className="mt-2"
              onClick={() => openApp("settings")}
            >
              Manage storage
            </Button>
          </div>
        </div>

        <div ref={diagnosticsRef} className="mt-2.5 grid grid-cols-2 gap-2.5">
          <div className="rounded-[10px] border border-white/[0.07] bg-white/[0.025] p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Storage capabilities
              </span>
              <button
                type="button"
                onClick={() => void refreshProbes()}
                disabled={probing}
                className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[9px] text-ink-faint transition hover:bg-white/[0.06] hover:text-ink disabled:opacity-50"
              >
                <RefreshCw size={9} className={probing ? "animate-spin" : undefined} aria-hidden />
                rescan
              </button>
            </div>
            <ul className="mt-2 flex flex-col gap-1.5">
              {probes.map((probe) => (
                <li
                  key={probe.backend}
                  className="flex items-start gap-2 rounded-[7px] border border-white/[0.05] bg-black/15 px-2 py-1.5"
                >
                  {probe.available ? (
                    <CheckCircle2 size={11} className="mt-0.5 flex-none text-success" aria-hidden />
                  ) : (
                    <XCircle size={11} className="mt-0.5 flex-none text-ink-ghost" aria-hidden />
                  )}
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-[10.5px] text-ink">
                      {probe.label}
                      {probe.recommended && (
                        <span className="rounded-full bg-accent/15 px-1.5 py-px font-mono text-[8px] uppercase tracking-[0.08em] text-accent">
                          recommended
                        </span>
                      )}
                    </p>
                    <p className="truncate text-[9px] text-ink-ghost">{probe.detail}</p>
                  </div>
                </li>
              ))}
              {probes.length === 0 && (
                <li className="text-[10px] text-ink-ghost">Probing storage…</li>
              )}
            </ul>
          </div>

          <div className="rounded-[10px] border border-white/[0.07] bg-white/[0.025] p-3.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Host capabilities
            </span>
            <ul className="mt-2 flex flex-col gap-1.5">
              {capabilities.map((capability) => (
                <li key={capability.id} className="flex items-start gap-2">
                  {capability.ok ? (
                    <CheckCircle2 size={11} className="mt-0.5 flex-none text-success" aria-hidden />
                  ) : (
                    <ShieldAlert size={11} className="mt-0.5 flex-none text-warning" aria-hidden />
                  )}
                  <div className="min-w-0">
                    <p className="text-[10.5px] text-ink">{capability.label}</p>
                    <p className="truncate text-[9px] text-ink-ghost">{capability.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 flex items-center gap-1.5 text-[9px] text-ink-ghost">
              <Globe2 size={9} aria-hidden />
              GPU tier selection happens in the runtime, not the shell.
            </p>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-[10px] border border-white/[0.07] bg-white/[0.02] px-3 py-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Actions</span>
          <Button
            size="xs"
            variant="secondary"
            icon={RefreshCw}
            onClick={() => {
              void runtime.initialize(selectedStorage.backend);
              toast({ title: "Runtime re-initialised", tone: "info", message: "Mock remount only." });
            }}
          >
            Re-initialise
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon={ScrollText}
            onClick={clearLogs}
          >
            Clear logs
          </Button>
          <Button
            size="xs"
            variant="danger"
            icon={XCircle}
            disabled={guestState !== "running" && guestState !== "paused"}
            onClick={() => void terminate()}
          >
            Stop guest
          </Button>
          <span className="ml-auto font-mono text-[9px] text-ink-ghost">
            shell {chrome.appId} · mode {mode}
          </span>
        </div>
      </div>

      <LogConsole
        entries={logs}
        open={logsOpen}
        onToggle={toggleLogs}
        onClear={clearLogs}
        title="Runtime console"
        height={150}
      />
    </div>
  );
}
