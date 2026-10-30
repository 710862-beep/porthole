import { clampPercent } from "@/lib/format";
import { cn } from "@/lib/cn";

export type ProgressTone = "accent" | "success" | "danger" | "warning";

interface ProgressBarProps {
  value?: number;
  indeterminate?: boolean;
  tone?: ProgressTone;
  size?: "xs" | "sm" | "md";
  label?: string;
  showValue?: boolean;
  className?: string;
}

const TONE_FILL: Record<ProgressTone, string> = {
  accent: "bg-[linear-gradient(90deg,rgb(var(--accent-rgb)),rgb(var(--accent-2-rgb)))]",
  success: "bg-[linear-gradient(90deg,#a6e3a1,#94e2d5)]",
  danger: "bg-[linear-gradient(90deg,#f38ba8,#f5a9e0)]",
  warning: "bg-[linear-gradient(90deg,#f9e2af,#fab387)]",
};

const HEIGHT: Record<NonNullable<ProgressBarProps["size"]>, string> = {
  xs: "h-1",
  sm: "h-1.5",
  md: "h-2.5",
};

export function ProgressBar({
  value = 0,
  indeterminate = false,
  tone = "accent",
  size = "sm",
  label,
  showValue = false,
  className,
}: ProgressBarProps) {
  const percent = clampPercent(value);

  return (
    <div className={cn("w-full", className)}>
      {(label || showValue) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          {label && <span className="text-[11px] text-ink-muted">{label}</span>}
          {showValue && !indeterminate && (
            <span className="font-mono text-[11px] tabular-nums text-ink-faint">
              {Math.round(percent)}%
            </span>
          )}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(percent)}
        aria-label={label ?? "Progress"}
        className={cn(
          "relative w-full overflow-hidden rounded-full bg-white/[0.07] shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)]",
          HEIGHT[size],
        )}
      >
        {indeterminate ? (
          <span
            className={cn(
              "absolute inset-y-0 left-0 w-1/3 animate-boot-sweep rounded-full",
              TONE_FILL[tone],
            )}
          />
        ) : (
          <span
            className={cn(
              "absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-kde",
              TONE_FILL[tone],
            )}
            style={{ width: `${percent}%` }}
          />
        )}
        {!indeterminate && percent > 0 && (
          <span
            className="pointer-events-none absolute inset-y-0 left-0 rounded-full blur-[6px] opacity-40"
            style={{ width: `${percent}%` }}
          >
            <span className={cn("block h-full w-full rounded-full", TONE_FILL[tone])} />
          </span>
        )}
      </div>
    </div>
  );
}
