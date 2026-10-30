import { cn } from "@/lib/cn";

interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

/** Two-tone ring spinner; no layout shift, no images. */
export function Spinner({ size = 18, className, label }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label ?? "Loading"}
      className={cn("relative inline-flex flex-none", className)}
      style={{ width: size, height: size }}
    >
      <span
        className="absolute inset-0 rounded-full border-white/[0.12]"
        style={{ borderWidth: Math.max(1.5, size / 9) }}
      />
      <span
        className="absolute inset-0 animate-spin rounded-full border-transparent border-t-accent"
        style={{ borderWidth: Math.max(1.5, size / 9) }}
      />
    </span>
  );
}
