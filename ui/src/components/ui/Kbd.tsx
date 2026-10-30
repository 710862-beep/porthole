import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Keycap. Purely presentational — shortcuts are wired in useHotCorner. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("kbd", className)}>{children}</kbd>;
}
