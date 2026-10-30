import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRightLeft, Maximize2, Minus, Square, X } from "lucide-react";
import { useWindowStore, type WindowInstance } from "@/store/windowStore";
import { useWindowManager } from "@/hooks/useWindowManager";
import glass from "@/styles/glass.module.css";
import { cn } from "@/lib/cn";
import { EASE_KDE } from "@/lib/motion";

interface WindowMenuProps {
  instance: WindowInstance;
  x: number;
  y: number;
  onClose: () => void;
}

const MENU_WIDTH = 244;
const MENU_HEIGHT = 298;

/** Right-click window menu. Portalled so window clipping/backdrop filters can't cut it. */
export function WindowMenu({ instance, x, y, onClose }: WindowMenuProps) {
  const { closeWindow } = useWindowManager();
  const [position] = useState(() => ({
    left: Math.min(x, window.innerWidth - MENU_WIDTH - 8),
    top: Math.min(y, window.innerHeight - MENU_HEIGHT - 8),
  }));
  const maximized = instance.status === "maximized";
  const workspaceCount = useWindowStore((state) => state.workspaceCount);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  const item =
    "flex h-8 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[11.5px] text-ink-muted transition-colors hover:bg-white/[0.07] hover:text-ink";

  return createPortal(
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[70]"
        onPointerDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <motion.div
          role="menu"
          aria-label={`Window menu — ${instance.title}`}
          initial={{ opacity: 0, scale: 0.96, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.16, ease: EASE_KDE }}
          style={{ left: Math.max(8, position.left), top: Math.max(8, position.top) }}
          onPointerDown={(event) => event.stopPropagation()}
          className={cn(glass.popover, "absolute w-[244px] rounded-[12px] p-1.5")}
        >
          <p className="truncate px-2.5 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-ghost">
            {instance.title}
          </p>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              useWindowStore.getState().focusWindow(instance.id);
              onClose();
            }}
          >
            <ArrowRightLeft size={13} aria-hidden />
            Bring to front
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              useWindowStore.getState().minimizeWindow(instance.id);
              onClose();
            }}
          >
            <Minus size={13} aria-hidden />
            Minimize
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              useWindowStore.getState().toggleMaximize(instance.id);
              onClose();
            }}
          >
            {maximized ? <Square size={11} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
            {maximized ? "Restore" : "Maximize"}
          </button>

          <div className="my-1.5 h-px bg-white/[0.07]" />

          <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-ghost">
            Move to workspace
          </p>
          <div className="grid grid-cols-4 gap-1 px-1 pb-1">
            {Array.from({ length: workspaceCount }, (_, index) => (
              <button
                key={index}
                type="button"
                role="menuitem"
                aria-current={instance.workspace === index}
                onClick={() => {
                  useWindowStore.getState().moveToWorkspace(instance.id, index);
                  onClose();
                }}
                className={cn(
                  "flex h-7 items-center justify-center rounded-[6px] border text-[10.5px] font-medium transition",
                  instance.workspace === index
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-white/[0.07] bg-white/[0.03] text-ink-muted hover:border-white/15 hover:text-ink",
                )}
              >
                {index + 1}
              </button>
            ))}
          </div>

          <div className="my-1.5 h-px bg-white/[0.07]" />

          <button
            type="button"
            role="menuitem"
            className={cn(item, "text-danger/90 hover:bg-danger/10 hover:text-danger")}
            onClick={() => {
              onClose();
              void closeWindow(instance.id);
            }}
          >
            <X size={13} aria-hidden />
            Close window
          </button>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body,
  );
}
