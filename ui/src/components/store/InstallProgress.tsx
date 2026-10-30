import { Check, CircleDashed, Loader2 } from "lucide-react";
import type { InstallPhase, InstallProgress as InstallProgressState } from "@runtime/types";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { cn } from "@/lib/cn";

const STEPS: Array<{ phase: InstallPhase; label: string }> = [
  { phase: "queued", label: "Queued" },
  { phase: "preparing", label: "Preparing" },
  { phase: "transferring", label: "Transferring" },
  { phase: "verifying", label: "Verifying" },
  { phase: "writing", label: "Writing" },
  { phase: "complete", label: "Complete" },
];

function stepIndex(phase: InstallPhase): number {
  const index = STEPS.findIndex((step) => step.phase === phase);
  return index === -1 ? 0 : index;
}

interface InstallProgressProps {
  progress: InstallProgressState;
  compact?: boolean;
}

/** Phase checklist + determinate bar for a simulated library install. */
export function InstallProgress({ progress, compact = false }: InstallProgressProps) {
  const current = stepIndex(progress.phase);
  const complete = progress.phase === "complete";
  const failed = progress.phase === "failed";

  return (
    <div
      className={cn(
        "rounded-[10px] border border-white/[0.08] bg-black/20",
        compact ? "p-2.5" : "p-3.5",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-medium text-ink">
          {complete ? "Installed" : failed ? "Install failed" : "Installing…"}
        </span>
        <span className="font-mono text-[10.5px] tabular-nums text-ink-faint">
          {Math.round(progress.percent)}%
        </span>
      </div>

      <ProgressBar
        value={progress.percent}
        tone={complete ? "success" : failed ? "danger" : "accent"}
        size="sm"
        className="mt-2"
      />

      <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">{progress.detail}</p>

      {!compact && (
        <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {STEPS.map((step, index) => {
            const done = complete || index < current;
            const active = !complete && index === current;
            return (
              <li
                key={step.phase}
                className={cn(
                  "flex items-center gap-1.5 text-[10px]",
                  done ? "text-success" : active ? "text-accent" : "text-ink-ghost",
                )}
              >
                {done ? (
                  <Check size={10} aria-hidden />
                ) : active ? (
                  <Loader2 size={10} className="animate-spin" aria-hidden />
                ) : (
                  <CircleDashed size={10} aria-hidden />
                )}
                {step.label}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
