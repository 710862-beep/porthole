import { useCallback, useEffect, useState } from "react";
import { MotionConfig, useReducedMotion } from "framer-motion";
import type { StorageBackendId, StorageProbe } from "@runtime/types";
import { RuntimeProvider, useRuntime } from "@/hooks/useRuntime";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { DialogHost } from "@/components/ui/DialogHost";
import { ToastHost } from "@/components/ui/ToastHost";
import { BootExperience } from "@/components/boot/BootExperience";
import { Desktop } from "@/components/desktop/Desktop";
import { ACCENTS, toast, useUiStore } from "@/store/uiStore";
import { useEmulatorStore } from "@/store/emulatorStore";
import { confirmAction, reportError } from "@/store/dialogStore";

const MIN_START_MS = 720;

function Shell() {
  const { runtime, storage } = useRuntime();
  const phase = useUiStore((state) => state.bootPhase);
  const accent = useUiStore((state) => state.accent);
  const reduceMotion = useUiStore((state) => state.reduceMotion);
  const runtimeMode = useEmulatorStore((state) => state.mode);
  const systemReduced = useReducedMotion();

  const [bootStage, setBootStage] = useState(0);
  const [startingStage, setStartingStage] = useState(0);
  const [probes, setProbes] = useState<StorageProbe[] | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  /* ---- theme + motion ---------------------------------------------------- */
  useEffect(() => {
    const option = ACCENTS[accent];
    const root = document.documentElement;
    root.style.setProperty("--accent-rgb", option.accent.join(" "));
    root.style.setProperty("--accent-2-rgb", option.accentAlt.join(" "));
  }, [accent]);

  useEffect(() => {
    document.documentElement.dataset.motion = reduceMotion ? "reduced" : "full";
  }, [reduceMotion]);

  /* ---- session start ----------------------------------------------------- */
  const beginSession = useCallback(
    async (requested: StorageBackendId): Promise<void> => {
      const ui = useUiStore.getState();
      if (ui.bootPhase === "starting" || ui.bootPhase === "desktop") return;

      setSetupError(null);
      ui.setBootPhase("starting");
      setStartingStage(0);
      useEmulatorStore.getState().setStatus("initializing");
      useEmulatorStore.getState().setError(null);

      try {
        const capabilities = await storage.detectProbes();
        const available = capabilities
          .filter((capability) => capability.available)
          .map((capability) => capability.backend);

        let backend = requested;
        if (!available.includes(backend)) {
          backend = available.includes("opfs") ? "opfs" : "memory";
          toast({
            title: "Storage fallback",
            message: `${requested} is unavailable here — using ${backend} instead.`,
            tone: "warning",
            duration: 6200,
          });
        }
        if (backend !== requested) storage.setSelected(backend);

        const label = storage.describeSelected().label;
        await runtime.initialize(backend);
        // Mirror the runtime handshake into the shell store: the emulator surface
        // gates its Launch button on "ready", so this is the only place it is set.
        const emulator = useEmulatorStore.getState();
        emulator.setMode(runtime.mode);
        emulator.setStatus("ready");
        emulator.setStorage(storage.describeSelected());

        // Give the start screen enough time to show real stages without lying.
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, MIN_START_MS);
        });

        const state = useUiStore.getState();
        if (state.bootPhase !== "starting") return;
        state.markSetupComplete();
        state.setBootPhase("desktop");
        state.pushToast({
          title: "Desktop ready",
          message: `${label} · ${runtime.mode} runtime · shell 0.5.0`,
          tone: "info",
          duration: 3600,
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        useEmulatorStore.getState().setStatus("error");
        useEmulatorStore.getState().setError(message);
        setSetupError(message);
        useUiStore.getState().setBootPhase("setup");
        await reportError({
          title: "Could not start the desktop",
          body: "The runtime refused to initialize with the selected storage backend. Pick another backend to continue.",
          details: message,
        });
      }
    },
    [runtime, storage],
  );

  /* ---- cold start sequence ---------------------------------------------- */
  useEffect(() => {
    if (phase !== "boot") return;
    const timers: number[] = [
      window.setTimeout(() => setBootStage(1), 420),
      window.setTimeout(() => setBootStage(2), 980),
      window.setTimeout(() => setBootStage(3), 1500),
      window.setTimeout(() => {
        const ui = useUiStore.getState();
        if (ui.bootPhase !== "boot") return;

        if (ui.setupComplete) {
          void beginSession(storage.selected());
          return;
        }

        void storage
          .detectProbes()
          .then((result) => {
            setProbes(result);
            useUiStore.getState().setBootPhase("setup");
          })
          .catch(() => {
            setProbes([]);
            useUiStore.getState().setBootPhase("setup");
          });
      }, 1900),
    ];

    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [beginSession, phase, storage]);

  /* ---- setup probes if boot failed before probing ------------------------ */
  useEffect(() => {
    if (phase !== "setup" || probes !== null) return;
    let cancelled = false;
    void storage
      .detectProbes()
      .then((result) => {
        if (!cancelled) setProbes(result);
      })
      .catch(() => {
        if (!cancelled) setProbes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [phase, probes, storage]);

  /* ---- start-screen stages ---------------------------------------------- */
  useEffect(() => {
    if (phase !== "starting") return;
    const timers = [1, 2].map((stage) =>
      window.setTimeout(() => setStartingStage(stage), stage * 260),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [phase]);

  /* ---- setup handlers ---------------------------------------------------- */
  const chooseNvme = useCallback(async (): Promise<void> => {
    if (setupBusy) return;
    setSetupBusy(true);
    setSetupError(null);
    try {
      const result = await storage.requestNvme();
      if (!result.ok) {
        setSetupError(result.reason);
        setSetupBusy(false);
        const fallback = await confirmAction({
          title: "External drive not mounted",
          body: `${result.reason} Use local browser storage (OPFS) instead?`,
          confirmLabel: "Use browser storage",
          cancelLabel: "Go back",
        });
        if (fallback) await beginSession("opfs");
        return;
      }
      await beginSession("file-system-access");
    } finally {
      setSetupBusy(false);
    }
  }, [beginSession, setupBusy, storage]);

  const chooseBackend = useCallback(
    (backend: StorageBackendId): void => {
      void beginSession(backend);
    },
    [beginSession],
  );

  const reducedMotion =
    reduceMotion || systemReduced === true ? "always" : ("user" as const);

  return (
    <MotionConfig reducedMotion={reducedMotion}>
      <div className="h-full w-full bg-crust text-ink">
        {phase === "desktop" ? (
          <Desktop />
        ) : (
          <BootExperience
            phase={phase}
            stage={phase === "starting" ? startingStage : bootStage}
            storageLabel={storage.describeSelected().label}
            mode={runtimeMode}
            probes={probes}
            busy={setupBusy}
            error={setupError}
            onNvme={() => {
              void chooseNvme();
            }}
            onOpfs={() => chooseBackend("opfs")}
            onMemory={() => chooseBackend("memory")}
          />
        )}
      </div>
    </MotionConfig>
  );
}

/**
 * Root. Providers are intentionally boring: runtime context, global dialogs and
 * notifications, and a crash boundary that never leaves a white screen.
 */
export function App() {
  return (
    <ErrorBoundary>
      <RuntimeProvider>
        <Shell />
        <ToastHost />
        <DialogHost />
      </RuntimeProvider>
    </ErrorBoundary>
  );
}
