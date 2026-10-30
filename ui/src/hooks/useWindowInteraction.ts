import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { AppSize } from "@/store/apps";
import { TASKBAR_HEIGHT, viewportSize, type Bounds } from "@/store/windowStore";

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface InteractionOptions {
  frameRef: RefObject<HTMLDivElement | null>;
  bounds: Bounds;
  minSize: AppSize;
  /** Maximised windows don't drag; geometry is owned by the store. */
  maximized: boolean;
  disabled: boolean;
  onFocus: () => void;
  onCommit: (bounds: Bounds) => void;
}

const TITLEBAR_GRAB = 40;

function dragBounds(start: Bounds, dx: number, dy: number): Bounds {
  const viewport = viewportSize();
  const usable = viewport.height - TASKBAR_HEIGHT;
  const x = Math.min(Math.max(start.x + dx, -(start.width - 140)), viewport.width - 140);
  const y = Math.min(Math.max(start.y + dy, 0), usable - TITLEBAR_GRAB);
  return { x: Math.round(x), y: Math.round(y), width: start.width, height: start.height };
}

function resizeBounds(
  start: Bounds,
  dx: number,
  dy: number,
  edge: ResizeEdge,
  minSize: AppSize,
): Bounds {
  const viewport = viewportSize();
  const usable = viewport.height - TASKBAR_HEIGHT;
  let { x, y, width, height } = start;

  if (edge.includes("e")) {
    width = Math.min(start.width + dx, viewport.width - start.x);
  }
  if (edge.includes("s")) {
    height = Math.min(start.height + dy, usable - start.y);
  }
  if (edge.includes("w")) {
    const maxDelta = Math.min(start.width - minSize.width, start.x);
    const delta = Math.min(Math.max(dx, -start.x), maxDelta);
    width = start.width - delta;
    x = start.x + delta;
  }
  if (edge.includes("n")) {
    const maxDelta = Math.min(start.height - minSize.height, start.y);
    const delta = Math.min(Math.max(dy, -start.y), maxDelta);
    height = start.height - delta;
    y = start.y + delta;
  }

  width = Math.max(minSize.width, width);
  height = Math.max(minSize.height, height);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * Pointer-driven move/resize.
 *
 * Performance contract: during an interaction we never touch Zustand or React —
 * geometry is written straight to the frame element inside a single rAF per pointer
 * burst. The store receives one commit on pointer-up, so the emulator's main thread
 * sees no 60 Hz render storm.
 */
export function useWindowInteraction(options: InteractionOptions) {
  const { frameRef, bounds, minSize, maximized, disabled, onFocus, onCommit } = options;
  const [interacting, setInteracting] = useState<"drag" | "resize" | null>(null);
  const boundsRef = useRef<Bounds>(bounds);

  useEffect(() => {
    if (!interacting) boundsRef.current = bounds;
  }, [bounds, interacting]);

  const apply = useCallback(
    (next: Bounds): void => {
      const element = frameRef.current;
      if (!element) return;
      element.style.left = `${next.x}px`;
      element.style.top = `${next.y}px`;
      element.style.width = `${next.width}px`;
      element.style.height = `${next.height}px`;
    },
    [frameRef],
  );

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>, mode: "drag" | "resize", edge: ResizeEdge = "se") => {
      if (disabled || event.button !== 0) return;
      if (mode === "drag" && maximized) return;
      event.preventDefault();
      event.stopPropagation();
      onFocus();

      const start = boundsRef.current;
      const originX = event.clientX;
      const originY = event.clientY;
      const pointerId = event.pointerId;
      const element = frameRef.current;
      let latest = start;
      let raf = 0;
      let finished = false;

      setInteracting(mode);
      if (element) element.dataset.interacting = "true";
      document.body.style.userSelect = "none";
      document.body.style.cursor = mode === "drag" ? "grabbing" : "default";

      const onMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        const dx = moveEvent.clientX - originX;
        const dy = moveEvent.clientY - originY;
        latest =
          mode === "drag"
            ? dragBounds(start, dx, dy)
            : resizeBounds(start, dx, dy, edge, minSize);
        if (raf === 0) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            apply(latest);
          });
        }
      };

      const finish = (cancelled: boolean): void => {
        if (finished) return;
        finished = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        if (raf !== 0) cancelAnimationFrame(raf);
        if (element) delete element.dataset.interacting;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        setInteracting(null);

        if (cancelled) {
          apply(start);
        } else {
          boundsRef.current = latest;
          apply(latest);
          onCommit(latest);
        }
      };

      const onUp = (upEvent: PointerEvent): void => {
        if (upEvent.pointerId !== pointerId) return;
        finish(false);
      };
      const onCancel = (): void => finish(true);
      const onKey = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key !== "Escape") return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        finish(true);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    },
    [apply, disabled, frameRef, maximized, minSize, onCommit, onFocus],
  );

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => begin(event, "drag"),
    [begin],
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>, edge: ResizeEdge): void => {
      begin(event, "resize", edge);
    },
    [begin],
  );

  return { interacting, startDrag, startResize };
}
