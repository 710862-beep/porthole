import { useId } from "react";
import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { EASE_KDE } from "@/lib/motion";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  const groupId = useId();

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-control border border-white/10 bg-black/25 p-[3px]",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[11.5px] font-medium transition-colors duration-150",
              active ? "text-[#08121a]" : "text-ink-muted hover:text-ink",
            )}
          >
            {active && (
              <motion.span
                layoutId={`segment-${groupId}`}
                transition={{ duration: 0.24, ease: EASE_KDE }}
                className="absolute inset-0 rounded-[6px] bg-accent shadow-glow-sm"
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              {Icon && <Icon size={12} aria-hidden />}
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
