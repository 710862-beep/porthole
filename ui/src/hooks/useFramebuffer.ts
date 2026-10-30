import { useEffect, type RefObject } from "react";
import { useEmulatorStore } from "@/store/emulatorStore";
import { useRuntime } from "./useRuntime";

/**
 * Paints the runtime framebuffer into a canvas.
 *
 * Frame authority (contracts.ts): pixels come from `runtime.getFramebuffer()` only —
 * nothing is composed host-side. Repaints are coalesced to one per animation frame
 * and the canvas keeps the guest's native resolution (240×135 in mock mode), letting
 * CSS scale it with `image-rendering: pixelated` like a real low-res scanout.
 *
 * Pass `enabled: false` when the window is hidden/minimised: the hook detaches its
 * frame listener so the runtime can stop presenting.
 */
export function useFramebuffer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
): void {
  const { runtime } = useRuntime();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!enabled || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const staging = document.createElement("canvas");
    const stagingContext = staging.getContext("2d");
    let raf = 0;
    let cancelled = false;
    let lastWidth = -1;
    let lastHeight = -1;

    const paint = (): void => {
      raf = 0;
      if (cancelled) return;
      const frame = runtime.getFramebuffer();
      if (!frame || !stagingContext) return;

      if (frame.width !== lastWidth || frame.height !== lastHeight) {
        lastWidth = frame.width;
        lastHeight = frame.height;
        staging.width = frame.width;
        staging.height = frame.height;
        canvas.width = frame.width;
        canvas.height = frame.height;
        useEmulatorStore.getState().markFrame();
      }

      stagingContext.putImageData(frame, 0, 0);
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(staging, 0, 0);
    };

    const schedule = (): void => {
      if (raf === 0 && !cancelled) raf = requestAnimationFrame(paint);
    };

    runtime.onFrameReady(schedule);
    schedule();

    return () => {
      cancelled = true;
      runtime.offFrameReady(schedule);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [canvasRef, enabled, runtime]);
}
