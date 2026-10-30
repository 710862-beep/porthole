import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

interface AppIconProps {
  icon: LucideIcon;
  tint: string;
  size?: number;
  iconSize?: number;
  className?: string;
  /** Drop the tile background (taskbar / inline usage). */
  bare?: boolean;
}

/** Tinted, glassy app tile. Hex tint × alpha gives every app its own identity. */
export function AppIcon({
  icon: Icon,
  tint,
  size = 34,
  iconSize = 17,
  className,
  bare = false,
}: AppIconProps) {
  return (
    <span
      className={cn(
        "relative grid flex-none place-items-center overflow-hidden rounded-[9px]",
        !bare && "border border-white/[0.07]",
        className,
      )}
      style={{
        width: size,
        height: size,
        color: tint,
        backgroundColor: bare ? "transparent" : `${tint}17`,
        backgroundImage: bare
          ? undefined
          : `linear-gradient(140deg, ${tint}2b, transparent 64%)`,
        boxShadow: bare ? undefined : `inset 0 0 0 1px ${tint}22`,
      }}
    >
      <Icon size={iconSize} strokeWidth={1.85} aria-hidden />
    </span>
  );
}
