import { useCallback } from "react";
import type { StorageBackendId } from "@runtime/types";
import { useEmulatorStore, guestStateOf } from "@/store/emulatorStore";
import { useUiStore, toast } from "@/store/uiStore";
import { reportError } from "@/store/dialogStore";
import { useRuntime } from "./useRuntime";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Actions + observed state for the emulator. The desktop consumes only this hook;
 * nothing here knows how the runtime produces frames.
 */
export function useEmulator() {
  const { runtime, storage } = useRuntime();

  const telemetry = useEmulatorStore((state) => state.telemetry);
  const status = useEmulatorStore((state) => state.status);
  const error = useEmulatorStore((state) => state.error);
  const logs = useEmulatorStore((state) => state.logs);
  const logsOpen = useEmulatorStore((state) => state.logsOpen);
  const processHandle = useEmulatorStore((state) => state.processHandle);
  const mode = useEmulatorStore((state) => state.mode);
  const guestState = guestStateOf(telemetry);

  const initialize = useCallback(
    async (backend: StorageBackendId): Promise<void> => {
      const store = useEmulatorStore.getState();
      store.setStatus("initializing");
      store.setError(null);
      try {
        await runtime.initialize(backend);
        store.setStatus("ready");
        store.setStorage(storage.describeSelected());
      } catch (cause) {
        const message = errorMessage(cause);
        store.setStatus("error");
        store.setError(message);
        await reportError({
          title: "Runtime failed to initialize",
          body: "The desktop is running, but the emulator surface could not start.",
          details: message,
        });
      }
    },
    [runtime, storage],
  );

  const loadAndLaunch = useCallback(
    async (path: string): Promise<void> => {
      try {
        const handle = await runtime.loadExecutable(path);
        useEmulatorStore.getState().setProcessHandle(handle);
        await runtime.launch(handle);
      } catch (cause) {
        const message = errorMessage(cause);
        useEmulatorStore.getState().setError(message);
        await reportError({
          title: "Launch failed",
          body: `The runtime refused to start “${path}”.`,
          details: message,
        });
      }
    },
    [runtime],
  );

  const pause = useCallback(async (): Promise<void> => {
    const handle = useEmulatorStore.getState().processHandle;
    if (!handle) return;
    try {
      await runtime.pause(handle);
    } catch (cause) {
      await reportError({
        title: "Pause failed",
        body: "The process handle is no longer valid.",
        details: errorMessage(cause),
      });
    }
  }, [runtime]);

  const resume = useCallback(async (): Promise<void> => {
    const handle = useEmulatorStore.getState().processHandle;
    if (!handle) return;
    try {
      await runtime.launch(handle);
    } catch (cause) {
      await reportError({
        title: "Resume failed",
        body: "The process handle is no longer valid.",
        details: errorMessage(cause),
      });
    }
  }, [runtime]);

  const terminate = useCallback(async (): Promise<void> => {
    const handle = useEmulatorStore.getState().processHandle;
    if (!handle) return;
    try {
      await runtime.terminate(handle);
      toast({ title: "Guest terminated", tone: "info", message: "The mock process was stopped." });
    } catch (cause) {
      useEmulatorStore.getState().setError(errorMessage(cause));
    } finally {
      useEmulatorStore.getState().setProcessHandle(null);
    }
  }, [runtime]);

  const clearLogs = useCallback((): void => {
    runtime.clearLogs();
    useEmulatorStore.getState().clearLogs();
  }, [runtime]);

  const toggleLogs = useCallback((): void => {
    useEmulatorStore.getState().toggleLogs();
  }, []);

  const sendKey = useCallback(
    (key: string, state: "down" | "up"): void => {
      runtime.sendKeyEvent(key, state);
    },
    [runtime],
  );

  const notifyUnavailable = useCallback((): void => {
    const ui = useUiStore.getState();
    ui.pushToast({
      title: "Input forwarding pending (KI-04)",
      message: "Keys are counted by the shell; the core does not deliver them to a guest yet.",
      tone: "warning",
    });
  }, []);

  return {
    runtime,
    mode,
    telemetry,
    guestState,
    status,
    error,
    logs,
    logsOpen,
    processHandle,
    initialize,
    loadAndLaunch,
    launch: resume,
    pause,
    resume,
    terminate,
    clearLogs,
    toggleLogs,
    sendKey,
    notifyUnavailable,
  };
}
