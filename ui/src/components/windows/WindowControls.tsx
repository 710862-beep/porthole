import type { PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, Minus, Square, X } from "lucide-react";
import { useWindowStore } from "@/store/windowStore";
import { useWindowManager } from "@/hooks/useWindowManager";
import styles from "@/styles/window.module.css";
import { cn } from "@/lib/cn";

interface WindowControlsProps {
  windowId: string;
  maximized: boolean;
}

/** KDE-ordered controls: minimize, maximize/restore, close (right side). */
export function WindowControls({ windowId, maximized }: WindowControlsProps) {
  const { closeWindow } = useWindowManager();

  const stop = (event: ReactPointerEvent<HTMLElement>): void => {
    event.stopPropagation();
  };

  return (
    <div className={styles.controls} onPointerDown={stop}>
      <button
        type="button"
        aria-label="Minimize window"
        title="Minimize"
        className={styles.control}
        onClick={(event) => {
          event.stopPropagation();
          useWindowStore.getState().minimizeWindow(windowId);
        }}
      >
        <Minus size={13} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore window" : "Maximize window"}
        title={maximized ? "Restore" : "Maximize"}
        className={styles.control}
        onClick={(event) => {
          event.stopPropagation();
          useWindowStore.getState().toggleMaximize(windowId);
        }}
      >
        {maximized ? <Square size={10} aria-hidden /> : <Maximize2 size={11} aria-hidden />}
      </button>
      <button
        type="button"
        aria-label="Close window"
        title="Close"
        className={cn(styles.control, styles.close)}
        onClick={(event) => {
          event.stopPropagation();
          void closeWindow(windowId);
        }}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}
