import { Check, Loader2 } from "lucide-react";
import type { RuntimeMode } from "@runtime/types";
import { PortholeMark } from "@/components/ui/PortholeMark";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

interface BootStep {
  label: string;
  detail: string;
}

const BOOT_STEPS: BootStep[] = [
  { label: "Cold start", detail: "Secure context check" },
  { label: "Probing host", detail: "Storage, Wasm and GPU tiers" },
  { label: "Loading shell", detail: "Design tokens, fonts, modules" },
  { label: "Seating desktop", detail: "Restoring the session" },
];

const START_STEPS: BootStep[] = [
  { label: "Mounting storage", detail: "Guest RAM overflow + VFS shards" },
  { label: "Seating runtime", detail: "Wasm core handshake" },
  { label: "Restoring desktop", detail: "Panel, windows and workspaces" },
];

const BOOT_PROGRESS = [8, 34, 62, 88];
const START_PROGRESS = [22, 58, 88];

interface BootScreenProps {
  variant: "boot" | "starting";
  stage: number;
  storageLabel?: string;
  mode: RuntimeMode;
}

/** Full-screen boot / start surface. No external assets beyond the wallpaper. */
export function BootScreen({ variant, stage, storageLabel, mode }: BootScreenProps) {
  const steps = variant === "boot" ? BOOT_STEPS : START_STEPS;
  const progressValues = variant === "boot" ? BOOT_PROGRESS : START_PROGRESS;
  const clamped = Math.min(stage, steps.length - 1);
  const percent = progressValues[clamped] ?? 92;
  const activeStep = steps[clamped];

  return (
    <div className="relative z-10 flex h-full w-full items-center justify-center">
      <div className="flex w-full max-w-[520px] flex-col items-center px-8 text-center">
        <div className="relative grid place-items-center">
          <span className="absolute h-[104px] w-[104px] animate-porthole-spin rounded-full border border-dashed border-accent/20" aria-hidden />
          <span className="absolute h-[84px] w-[84px] rounded-full border border-violet/15" aria-hidden />
          <span className="relative grid h-[68px] w-[68px] place-items-center rounded-[20px] border border-white/[0.1] bg-white/[0.04] shadow-[0_18px_50px_-16px_rgba(0,0,0,0.8)]">
            <PortholeMark size={38} />
          </span>
        </div>

        <h1 className="mt-7 text-[26px] font-extralight uppercase tracking-[0.42em] text-[#eef2ff]">
          Porthole
        </h1>
        <p className="mt-1.5 text-[9.5px] uppercase tracking-[0.3em] text-ink-faint">
          browser desktop environment
        </p>

        <div className="mt-9 w-full max-w-[360px]">
          <ProgressBar value={percent} size="xs" tone="accent" />
          <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[9px] text-ink-ghost">
            <span className="flex items-center gap-1.5">
              <Loader2 size={9} className="animate-spin text-accent" aria-hidden />
              {activeStep?.label}
            </span>
            <span className="tabular-nums">{percent}%</span>
          </div>
        </div>

        <ul className="mt-7 flex w-full max-w-[360px] flex-col gap-1.5 text-left">
          {steps.map((step, index) => {
            const done = index < clamped;
            const active = index === clamped;
            return (
              <li
                key={step.label}
                className={cn(
                  "flex items-center gap-2 rounded-[7px] px-2 py-1 text-[10.5px] transition-colors",
                  active ? "bg-white/[0.04] text-ink" : done ? "text-ink-muted" : "text-ink-ghost",
                )}
              >
                <span className="grid h-3.5 w-3.5 flex-none place-items-center">
                  {done ? (
                    <Check size={10} className="text-success" aria-hidden />
                  ) : active ? (
                    <Loader2 size={9} className="animate-spin text-accent" aria-hidden />
                  ) : (
                    <span className="block h-1 w-1 rounded-full bg-ink-ghost" />
                  )}
                </span>
                <span className="truncate">{step.label}</span>
                <span className="ml-auto truncate font-mono text-[8.5px] text-ink-ghost">
                  {step.detail}
                </span>
              </li>
            );
          })}
        </ul>

        {variant === "starting" && storageLabel && (
          <p className="mt-5 font-mono text-[9.5px] text-ink-faint">
            storage · {storageLabel}
          </p>
        )}

        <div className="absolute bottom-6 left-0 right-0 flex items-center justify-center gap-3 text-[9px] text-ink-ghost">
          <span>Porthole 0.5.0</span>
          <span className="h-2.5 w-px bg-white/10" aria-hidden />
          <Badge tone={mode === "mock" ? "warning" : "success"} dot>
            {mode} runtime
          </Badge>
          <span className="h-2.5 w-px bg-white/10" aria-hidden />
          <span>CachyOS-inspired shell</span>
        </div>
      </div>
    </div>
  );
}
