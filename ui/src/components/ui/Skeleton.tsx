import { cn } from "@/lib/cn";

/** Shimmering placeholder — used while the library/runtime warm up. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-shimmer rounded-[8px] bg-[linear-gradient(90deg,rgba(255,255,255,0.04)_25%,rgba(255,255,255,0.09)_50%,rgba(255,255,255,0.04)_75%)] bg-[length:200%_100%]",
        className,
      )}
    />
  );
}
