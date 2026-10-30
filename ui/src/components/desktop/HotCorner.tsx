import { useUiStore } from "@/store/uiStore";
import { cn } from "@/lib/cn";

/**
 * Visible affordance for the 12×12 hot corner (detection lives in useHotCorner).
 * Clicking it is equivalent to moving the pointer into the corner.
 */
export function HotCorner() {
  const openOverview = useUiStore((state) => state.openOverview);

  return (
    <button
      type="button"
      aria-label="Open Overview (top-left hot corner)"
      title="Overview — hot corner (or press Super)"
      onClick={openOverview}
      className={cn(
        "group fixed left-0 top-0 z-30 h-3 w-3 cursor-default outline-none",
        "focus-visible:ring-2 focus-visible:ring-accent/70",
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 h-20 w-20 opacity-0 transition-opacity duration-500 ease-kde group-hover:opacity-100"
        style={{
          background:
            "radial-gradient(circle at 0 0, rgb(var(--accent-rgb) / 0.32), transparent 68%)",
        }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 h-[2px] w-0 rounded-full bg-accent shadow-glow-sm transition-all duration-500 ease-kde group-hover:w-16"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 h-0 w-[2px] rounded-full bg-accent shadow-glow-sm transition-all duration-500 ease-kde group-hover:h-16"
      />
    </button>
  );
}
