import {
  memo,
  useCallback,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { motion } from "framer-motion";
import { APPS } from "@/store/apps";
import { useWindowStore, type Bounds, type WindowInstance } from "@/store/windowStore";
import { useWindowInteraction, type ResizeEdge } from "@/hooks/useWindowInteraction";
import { cn } from "@/lib/cn";
import { EASE_KDE } from "@/lib/motion";
import styles from "@/styles/window.module.css";
import glass from "@/styles/glass.module.css";
import { WindowContent } from "./WindowContent";
import { TitleBar } from "./TitleBar";
import { WindowMenu } from "./WindowMenu";

interface WindowFrameProps {
  instance: WindowInstance;
  focused: boolean;
  onWorkspace: boolean;
  overviewOpen: boolean;
  closing: boolean;
}

const EDGES: Array<{ edge: ResizeEdge; className: string }> = [
  { edge: "n", className: styles.handleN },
  { edge: "s", className: styles.handleS },
  { edge: "e", className: styles.handleE },
  { edge: "w", className: styles.handleW },
  { edge: "ne", className: styles.handleNE },
  { edge: "nw", className: styles.handleNW },
  { edge: "se", className: styles.handleSE },
  { edge: "sw", className: styles.handleSW },
];

/**
 * A draggable, resizable, focusable window. Motion owns opacity/scale; geometry is
 * written directly to the DOM during a drag and committed once on pointer-up, so
 * dragging never re-renders this component (or its app) at 60 Hz.
 */
export const WindowFrame = memo(function WindowFrame({
  instance,
  focused,
  onWorkspace,
  overviewOpen,
  closing,
}: WindowFrameProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const app = APPS[instance.appId];
  const minimized = instance.status === "minimized";
  const maximized = instance.status === "maximized";
  const visible = !minimized && !overviewOpen && onWorkspace && !closing;

  const focus = useCallback(() => {
    useWindowStore.getState().focusWindow(instance.id);
  }, [instance.id]);

  const commit = useCallback(
    (next: Bounds) => {
      useWindowStore.getState().commitBounds(instance.id, next);
    },
    [instance.id],
  );

  const { interacting, startDrag, startResize } = useWindowInteraction({
    frameRef,
    bounds: instance.bounds,
    minSize: app.minSize,
    maximized,
    disabled: minimized || overviewOpen || closing,
    onFocus: focus,
    onCommit: commit,
  });

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  }, []);

  return (
    <>
      <motion.div
        ref={frameRef}
        role="region"
        aria-label={instance.title}
        aria-hidden={!onWorkspace || undefined}
        aria-modal={false}
        tabIndex={-1}
        data-window-id={instance.id}
        data-focused={focused && visible ? "true" : undefined}
        data-interacting={interacting !== null || undefined}
        data-animate-geometry={interacting === null || undefined}
        data-closing={closing || undefined}
        data-minimized={minimized ? "true" : undefined}
        initial={{ opacity: 0, scale: 0.965, y: 10 }}
        animate={{
          opacity: minimized || closing ? 0 : 1,
          scale: closing ? 0.965 : minimized ? 0.92 : 1,
          y: minimized ? 28 : 0,
        }}
        transition={{ duration: 0.2, ease: EASE_KDE }}
        className={cn(styles.frame, glass.window, "outline-none")}
        style={{
          left: instance.bounds.x,
          top: instance.bounds.y,
          width: instance.bounds.width,
          height: instance.bounds.height,
          zIndex: instance.zIndex,
          pointerEvents: minimized || closing || !onWorkspace ? "none" : undefined,
          visibility: onWorkspace ? "visible" : "hidden",
        }}
        onPointerDown={focus}
        onContextMenu={handleContextMenu}
      >
        <TitleBar
          instance={instance}
          focused={focused && visible}
          onDragStart={startDrag}
          onOpenMenu={(x, y) => setMenu({ x, y })}
        />

        <div className={styles.content}>
          <WindowContent instance={instance} visible={visible} />
        </div>

        {!maximized && (
          <>
            {EDGES.map(({ edge, className }) => (
              <div
                key={edge}
                className={cn(styles.handle, className)}
                onPointerDown={(event) => startResize(event, edge)}
                aria-hidden
              />
            ))}
          </>
        )}
      </motion.div>

      {menu && (
        <WindowMenu
          instance={instance}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
});
