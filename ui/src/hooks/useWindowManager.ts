import { useCallback } from "react";
import type { StoreGame } from "@runtime/types";
import { APPS, type AppId } from "@/store/apps";
import { useWindowStore, type WindowPayload } from "@/store/windowStore";
import { useUiStore, toast } from "@/store/uiStore";
import { useEmulatorStore } from "@/store/emulatorStore";
import { confirmAction } from "@/store/dialogStore";
import { useRuntime } from "./useRuntime";

/**
 * Shell-level window commands. Keeps confirmation / guest-teardown policy out of
 * presentation components: closing the emulator window stops its process, and
 * nothing closes a running guest without a Yes/No dialog.
 */
export function useWindowManager() {
  const { runtime } = useRuntime();

  const openApp = useCallback((appId: AppId, payload: WindowPayload | null = null): string => {
    const ui = useUiStore.getState();
    ui.closeLauncher();
    ui.closeOverview();
    return useWindowStore.getState().openWindow(appId, payload);
  }, []);

  const focusWindow = useCallback((id: string): void => {
    useWindowStore.getState().focusWindow(id);
  }, []);

  const minimizeWindow = useCallback((id: string): void => {
    useWindowStore.getState().minimizeWindow(id);
  }, []);

  const toggleMaximize = useCallback((id: string): void => {
    useWindowStore.getState().toggleMaximize(id);
  }, []);

  const terminateGuest = useCallback(async (): Promise<void> => {
    const emulator = useEmulatorStore.getState();
    const handle = emulator.processHandle;
    if (!handle) return;
    try {
      await runtime.terminate(handle);
    } catch {
      /* handle already gone — nothing to clean up */
    } finally {
      emulator.setProcessHandle(null);
    }
  }, [runtime]);

  const closeWindow = useCallback(
    async (id: string): Promise<void> => {
      const windowState = useWindowStore.getState();
      const instance = windowState.windows[id];
      if (!instance) return;

      const hasLiveGuest =
        instance.appId === "emulator" &&
        useEmulatorStore.getState().processHandle !== null;

      if (hasLiveGuest) {
        const confirmed = await confirmAction({
          title: "Stop the guest process?",
          body: "Closing the emulator window stops the running process and discards its session.",
          confirmLabel: "Stop and close",
          cancelLabel: "Keep running",
          danger: true,
        });
        if (!confirmed) return;
        await terminateGuest();
      }

      const store = useWindowStore.getState();
      store.beginClose(id);
      // Let the 180 ms Framer/CSS exit play before the window leaves the DOM.
      window.setTimeout(() => {
        useWindowStore.getState().closeWindow(id);
      }, 180);
    },
    [terminateGuest],
  );

  const closeAllWindows = useCallback(async (): Promise<void> => {
    if (useEmulatorStore.getState().processHandle) {
      const confirmed = await confirmAction({
        title: "Close everything?",
        body: "All windows will close and the running guest process will be stopped.",
        confirmLabel: "Close all",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!confirmed) return;
      await terminateGuest();
    }
    useWindowStore.getState().closeAll();
  }, [terminateGuest]);

  const launchGame = useCallback(
    (game: StoreGame): void => {
      if (game.status !== "in-library") {
        toast({
          title: `${game.title} is not in your library`,
          message: "Add the catalog entry to your local library first. This does not install the game.",
          tone: "warning",
        });
        return;
      }

      switch (game.appId) {
        case "chocolate-doom":
        case "7zip":
          toast({
            title: "Local guest files required",
            message: `Open the emulator and import ${game.exePath} from your own files. Store membership does not install a binary.`,
            tone: "info",
          });
          openApp("emulator");
          break;
        case "porthole-engine":
          openApp("system", { kind: "system-report" });
          break;
        case "gate4-probe":
          openApp("system", { kind: "system-report", section: "diagnostics" });
          break;
        case "freedoom":
          toast({
            title: "Asset pack, not an executable",
            message: "Freedoom is an IWAD consumed by Chocolate Doom — nothing to launch.",
            tone: "info",
          });
          break;
        default:
          toast({
            title: "No launcher for this entry",
            message: `${game.title} has no execution path in this shell.`,
            tone: "info",
          });
      }
    },
    [openApp],
  );

  const openSettings = useCallback(
    (section?: string): void => {
      openApp("settings", { kind: "settings", section });
    },
    [openApp],
  );

  const titleFor = useCallback((appId: AppId): string => APPS[appId].title, []);

  return {
    openApp,
    focusWindow,
    minimizeWindow,
    toggleMaximize,
    closeWindow,
    closeAllWindows,
    launchGame,
    openSettings,
    titleFor,
  };
}
