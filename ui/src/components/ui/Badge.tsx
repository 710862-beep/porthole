import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "accent" | "violet" | "success" | "warning" | "danger";

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  icon?: LucideIcon;
  dot?: boolean;
  mono?: boolean;
  className?: string;
}

const TONE: Record<BadgeTone, string> = {
  neutral: "border-white/10 bg-white/[0.05] text-ink-muted",
  accent: "border-accent/25 bg-accent/[0.09] text-accent",
  violet: "border-violet/25 bg-violet/[0.09] text-violet",
  success: "border-success/25 bg-success/[0.09] text-success",
  warning: "border-warning/25 bg-warning/[0.09] text-warning",
  danger: "border-danger/25 bg-danger/[0.09] text-danger",
};

const DOT_TONE: Record<BadgeTone, string> = {
  neutral: "bg-overlay",
  accent: "bg-accent shadow-[0_0_6px_rgb(var(--accent-rgb)/0.8)]",
  violet: "bg-violet shadow-[0_0_6px_rgba(179,136,255,0.7)]",
  success: "bg-success shadow-[0_0_6px_rgba(166,227,161,0.7)]",
  warning: "bg-warning shadow-[0_0_6px_rgba(249,226,175,0.7)]",
  danger: "bg-danger shadow-[0_0_6px_rgba(243,139,168,0.7)]",
};

export function Badge({ children, tone = "neutral", icon: Icon, dot, mono, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-[10.5px] font-medium tracking-[0.01em]",
        TONE[tone],
        mono && "font-mono",
        className,
      )}
    >
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", DOT_TONE[tone])} />}
      {Icon && <Icon size={11} aria-hidden />}
      {children}
    </span>
  );
}
