import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRuntimeBundle, type RuntimeBundle } from "@runtime/index";
import type { ExtendedEmulatorRuntime, GameStoreService, PortholeStorageService } from "@runtime/types";
import { useEmulatorStore } from "@/store/emulatorStore";
import { useLibraryStore } from "@/store/libraryStore";

interface RuntimeContextValue extends RuntimeBundle {
  runtime: ExtendedEmulatorRuntime;
  store: GameStoreService;
  storage: PortholeStorageService;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

/**
 * Owns the single runtime bundle for the shell and mirrors observation channels
 * (telemetry + logs + library) into Zustand. Components never construct runtimes.
 */
export function RuntimeProvider({ children }: { children: ReactNode }): ReactElement {
  const bundleRef = useRef<RuntimeBundle | null>(null);
  if (bundleRef.current === null) {
    bundleRef.current = createRuntimeBundle();
  }
  const bundle = bundleRef.current;

  useEffect(() => {
    const emulator = useEmulatorStore.getState();
    emulator.setMode(bundle.runtime.mode);
    emulator.replaceLogs(bundle.runtime.getLogs());

    const offTelemetry = bundle.runtime.onTelemetry((telemetry) => {
      useEmulatorStore.getState().setTelemetry(telemetry);
    });
    const offLog = bundle.runtime.onLog((entry) => {
      useEmulatorStore.getState().pushLog(entry);
    });
    useLibraryStore.getState().hydrate(bundle.store);

    return () => {
      offTelemetry();
      offLog();
    };
  }, [bundle]);

  const value = useMemo<RuntimeContextValue>(
    () => ({ runtime: bundle.runtime, store: bundle.store, storage: bundle.storage }),
    [bundle],
  );

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): RuntimeContextValue {
  const context = useContext(RuntimeContext);
  if (!context) {
    throw new Error("useRuntime must be used inside <RuntimeProvider>");
  }
  return context;
}
