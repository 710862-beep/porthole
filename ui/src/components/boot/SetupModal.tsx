import { motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  HardDrive,
  Info,
  MemoryStick,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { RuntimeMode, StorageBackendId, StorageProbe } from "@runtime/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PortholeMark } from "@/components/ui/PortholeMark";
import { Skeleton } from "@/components/ui/Skeleton";
import glass from "@/styles/glass.module.css";
import { cn } from "@/lib/cn";
import { EASE_KDE } from "@/lib/motion";

interface SetupModalProps {
  probes: StorageProbe[] | null;
  busy: boolean;
  error: string | null;
  mode: RuntimeMode;
  onNvme: () => void;
  onOpfs: () => void;
  onMemory: () => void;
}

const BACKEND_ICON: Record<StorageBackendId, LucideIcon> = {
  "file-system-access": HardDrive,
  opfs: Database,
  memory: MemoryStick,
};

const BACKEND_CTA: Record<StorageBackendId, string> = {
  "file-system-access": "Choose folder…",
  opfs: "Use browser storage",
  memory: "Use volatile mode",
};

/**
 * First-run storage selection.
 *
 * Primary path: a real folder via showDirectoryPicker. Automatic fallback: OPFS,
 * offered inline (and as a follow-up dialog when the picker fails). The modal cannot
 * be dismissed without choosing a backend — that is the only honest exit.
 */
export function SetupModal({
  probes,
  busy,
  error,
  mode,
  onNvme,
  onOpfs,
  onMemory,
}: SetupModalProps) {
  const handlers: Record<StorageBackendId, () => void> = {
    "file-system-access": onNvme,
    opfs: onOpfs,
    memory: onMemory,
  };
  const fsaAvailable = probes?.some(
    (probe) => probe.backend === "file-system-access" && probe.available,
  ) ?? false;

  return (
    <div className="relative z-20 flex h-full w-full items-center justify-center overflow-y-auto p-6">
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-title"
        initial={{ opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.34, ease: EASE_KDE }}
        className={cn(glass.dialog, "my-auto w-full max-w-[900px] overflow-hidden rounded-[18px]")}
      >
        <div className="grid md:grid-cols-[1.02fr_1fr]">
          {/* Brand / reasoning */}
          <div className="relative overflow-hidden border-b border-white/[0.07] p-7 md:border-b-0 md:border-r">
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(ellipse 70% 60% at 15% 0%, rgb(var(--accent-rgb) / 0.14), transparent 62%), radial-gradient(ellipse 70% 60% at 100% 90%, rgba(179,136,255,0.14), transparent 62%)",
              }}
              aria-hidden
            />
            <div className="relative">
              <div className="flex items-center gap-2.5">
                <PortholeMark size={30} />
                <div>
                  <p className="text-[13px] font-semibold tracking-[-0.01em] text-ink">Porthole</p>
                  <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-ghost">
                    desktop 0.5.0
                  </p>
                </div>
              </div>

              <h1 className="mt-6 text-[20px] font-semibold leading-snug tracking-[-0.02em] text-ink">
                Your desktop needs a disk.
              </h1>
              <p className="mt-2 max-w-[38ch] text-[11.5px] leading-relaxed text-ink-muted">
                Guest memory overflow and the virtual file system persist through one host
                protocol. Pick where the shards should live.
              </p>

              <ul className="mt-5 flex flex-col gap-2 text-[10.5px] leading-relaxed text-ink-muted">
                <li className="flex gap-2">
                  <CheckCircle2 size={12} className="mt-0.5 flex-none text-success" aria-hidden />
                  Runs entirely in this browser tab — no install, no native window.
                </li>
                <li className="flex gap-2">
                  <CheckCircle2 size={12} className="mt-0.5 flex-none text-success" aria-hidden />
                  The runtime is the labelled <strong className="font-semibold text-ink">mock</strong>{" "}
                  today; telemetry says so everywhere.
                </li>
                <li className="flex gap-2">
                  <CheckCircle2 size={12} className="mt-0.5 flex-none text-success" aria-hidden />
                  Custom dialogs only — never the browser&apos;s{" "}
                  <code className="font-mono">alert</code> /{" "}
                  <code className="font-mono">confirm</code> prompts.
                </li>
              </ul>

              <div className="mt-6 flex items-start gap-2 rounded-[9px] border border-white/[0.07] bg-black/20 p-2.5">
                <ShieldCheck size={12} className="mt-0.5 flex-none text-accent" aria-hidden />
                <p className="text-[9.5px] leading-relaxed text-ink-ghost">
                  Core and Gate evidence ship with the repository. This shell never invents a
                  compatibility result.
                </p>
              </div>

              <div className="mt-5 flex items-center gap-2 text-[9px] text-ink-ghost">
                <Badge tone={mode === "mock" ? "warning" : "success"} dot>
                  {mode} runtime
                </Badge>
                <span>CachyOS-inspired · dark</span>
              </div>
            </div>
          </div>

          {/* Storage choices */}
          <div className="p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 id="setup-title" className="text-[13.5px] font-semibold text-ink">
                Choose storage
              </h2>
              <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-ghost">
                step 1 of 1
              </span>
            </div>
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink-faint">
              Availability is probed in this browser right now, not assumed.
            </p>

            {error && (
              <div className="mt-3 flex items-start gap-2 rounded-[9px] border border-danger/25 bg-danger/[0.07] px-2.5 py-2">
                <AlertCircle size={12} className="mt-0.5 flex-none text-danger" aria-hidden />
                <p className="text-[10px] leading-relaxed text-danger/90">{error}</p>
              </div>
            )}

            <div className="mt-3.5 flex flex-col gap-2">
              {probes === null
                ? [0, 1, 2].map((index) => (
                    <Skeleton key={index} className="h-[84px] w-full rounded-[11px]" />
                  ))
                : probes.map((probe) => {
                    const Icon = BACKEND_ICON[probe.backend];
                    const primary =
                      probe.backend === "file-system-access"
                        ? probe.available
                        : probe.backend === "opfs"
                          ? probe.recommended && !fsaAvailable
                          : false;
                    return (
                      <div
                        key={probe.backend}
                        className={cn(
                          "rounded-[11px] border p-3 transition-colors",
                          primary
                            ? "border-accent/25 bg-accent/[0.055]"
                            : "border-white/[0.08] bg-white/[0.02]",
                          !probe.available && "opacity-70",
                        )}
                      >
                        <div className="flex items-start gap-2.5">
                          <span
                            className={cn(
                              "grid h-8 w-8 flex-none place-items-center rounded-[8px] border",
                              probe.available
                                ? "border-accent/25 bg-accent/10 text-accent"
                                : "border-white/[0.08] bg-white/[0.03] text-ink-ghost",
                            )}
                          >
                            <Icon size={14} aria-hidden />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] font-medium text-ink">
                              {probe.label}
                              {probe.recommended && <Badge tone="accent">recommended</Badge>}
                              {!probe.available && <Badge tone="danger">unavailable</Badge>}
                            </p>
                            <p className="mt-0.5 text-[10px] leading-relaxed text-ink-muted">
                              {probe.description}
                            </p>
                            <p className="mt-1 flex items-start gap-1 font-mono text-[9px] leading-relaxed text-ink-ghost">
                              {probe.available ? (
                                <CheckCircle2 size={9} className="mt-0.5 flex-none text-success" aria-hidden />
                              ) : (
                                <XCircle size={9} className="mt-0.5 flex-none text-danger/80" aria-hidden />
                              )}
                              {probe.detail}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant={
                              primary ? "primary" : probe.backend === "memory" ? "ghost" : "secondary"
                            }
                            disabled={!probe.available || busy}
                            loading={busy && probe.backend === "file-system-access"}
                            onClick={handlers[probe.backend]}
                            className="mt-0.5 flex-none"
                          >
                            {BACKEND_CTA[probe.backend]}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
            </div>

            <div className="mt-4 flex items-start gap-2 text-[9.5px] leading-relaxed text-ink-ghost">
              <Info size={11} className="mt-0.5 flex-none text-ink-faint" aria-hidden />
              <p>
                Folder permission is session-scoped: after a reload the shell falls back to OPFS and
                tells you. Change this any time in{" "}
                <span className="text-ink-muted">Settings → Storage</span>.
              </p>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
