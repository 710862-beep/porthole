import { useEffect, useRef } from "react";
import { useUiStore } from "@/store/uiStore";

const CORNER_SIZE = 12; // px from (0,0)

/**
 * KDE-style hot corner + global shortcuts.
 *
 * - Pointer enters the top-left 12×12 px → open Overview.
 * - Super (Meta): tap → toggle Overview; combos never toggle it accidentally.
 * - Super+D desktop, Super+E launcher, Super+W workspaces, Super+L lock.
 * - Escape closes Overview / Launcher.
 *
 * Pointer work is throttled to one animation frame per burst, so moving the mouse
 * over the desktop costs one cheap comparison per frame — never a React render.
 */
export function useHotCorner(): void {
  const cornerArmed = useRef(true);
  const superUsedInCombo = useRef(false);
  const superHeld = useRef(false);

  useEffect(() => {
    let frame = 0;
    let lastX = 0;
    let lastY = 0;

    const evaluateCorner = (): void => {
      frame = 0;
      const ui = useUiStore.getState();
      if (ui.bootPhase !== "desktop" || ui.locked) return;
      const inCorner = lastX <= CORNER_SIZE && lastY <= CORNER_SIZE;
      if (inCorner && cornerArmed.current) {
        cornerArmed.current = false;
        if (!ui.overviewOpen) ui.openOverview();
      } else if (!inCorner) {
        cornerArmed.current = true;
      }
    };

    const onPointerMove = (event: PointerEvent): void => {
      lastX = event.clientX;
      lastY = event.clientY;
      if (frame === 0) frame = requestAnimationFrame(evaluateCorner);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const ui = useUiStore.getState();
      if (ui.bootPhase !== "desktop") return;

      if (event.key === "Meta" || event.key === "OS") {
        superHeld.current = true;
        if (!event.repeat) superUsedInCombo.current = false;
        return;
      }

      if (event.metaKey) {
        superUsedInCombo.current = true;
        if (event.key === "d" || event.key === "w") {
          ui.openOverview();
          event.preventDefault();
        } else if (event.key === "e") {
          ui.toggleLauncher();
          event.preventDefault();
        } else if (event.key === "l") {
          ui.lock();
          event.preventDefault();
        }
        return;
      }

      if (event.key === "Escape") {
        if (ui.overviewOpen) {
          ui.closeOverview();
          event.preventDefault();
        } else if (ui.launcherOpen) {
          ui.closeLauncher();
          event.preventDefault();
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key !== "Meta" && event.key !== "OS") return;
      const wasHeld = superHeld.current;
      superHeld.current = false;
      if (!wasHeld || superUsedInCombo.current) return;
      const ui = useUiStore.getState();
      if (ui.bootPhase === "desktop") ui.toggleOverview();
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);
}
