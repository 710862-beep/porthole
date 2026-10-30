import { useId } from "react";
import { cn } from "@/lib/cn";

interface PortholeMarkProps {
  size?: number;
  className?: string;
  /** Dim the outer rings for watermark usage. */
  muted?: boolean;
}

/** The Porthole mark: a portal ring with an aperture core. */
export function PortholeMark({ size = 22, className, muted = false }: PortholeMarkProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const ring = `ring-${uid}`;
  const core = `core-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden
      className={cn("flex-none", className)}
    >
      <defs>
        <linearGradient id={ring} x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="rgb(var(--accent-rgb))" />
          <stop offset="1" stopColor="rgb(var(--accent-2-rgb))" />
        </linearGradient>
        <radialGradient id={core} cx="0" cy="0" r="1" gradientTransform="translate(32 32) rotate(90) scale(14)">
          <stop stopColor="rgb(var(--accent-rgb))" stopOpacity="0.55" />
          <stop offset="1" stopColor="rgb(var(--accent-2-rgb))" stopOpacity="0.08" />
        </radialGradient>
      </defs>
      <circle
        cx="32"
        cy="32"
        r="27"
        stroke={`url(#${ring})`}
        strokeWidth="3"
        opacity={muted ? 0.4 : 1}
      />
      <circle
        cx="32"
        cy="32"
        r="17"
        stroke={`url(#${ring})`}
        strokeOpacity={muted ? 0.25 : 0.6}
        strokeWidth="1.5"
      />
      <circle cx="32" cy="32" r="12" fill={`url(#${core})`} />
      <path
        d="M32 5v9M32 50v9M5 32h9M50 32h9"
        stroke={`url(#${ring})`}
        strokeWidth="3"
        strokeLinecap="round"
        opacity={muted ? 0.5 : 1}
      />
      <circle cx="32" cy="32" r="4" fill="#eaf6ff" opacity={muted ? 0.7 : 1} />
    </svg>
  );
}
