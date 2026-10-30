import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import styles from "@/styles/desktop.module.css";
import glass from "@/styles/glass.module.css";
import { cn } from "@/lib/cn";
import { EASE_KDE } from "@/lib/motion";

interface TrayPopoverProps {
  open: boolean;
  onClose: () => void;
  label: string;
  width?: number;
  children: ReactNode;
  align?: "right" | "center";
}

/** Frosted tray flyout. Closes on outside pointer-down and Escape. */
export function TrayPopover({
  open,
  onClose,
  label,
  width = 300,
  children,
  align = "right",
}: TrayPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose, open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          role="dialog"
          aria-label={label}
          initial={{ opacity: 0, y: 10, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.985 }}
          transition={{ duration: 0.2, ease: EASE_KDE }}
          style={{ width }}
          className={cn(
            styles.trayPopover,
            glass.popover,
            "overflow-hidden p-1.5",
            align === "right" ? "right-2 origin-bottom-right" : "left-1/2 -translate-x-1/2 origin-bottom",
          )}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
