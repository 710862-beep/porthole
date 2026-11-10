import { create } from "zustand";
import type {
  EmulatorState,
  ProcessHandle,
  RuntimeLogEntry,
  RuntimeMode,
  RuntimeTelemetry,
  StorageState,
} from "@runtime/types";

/** Shell-level lifecycle, distinct from guest state in RuntimeTelemetry. */
export type ShellRuntimeStatus = "cold" | "initializing" | "ready" | "error";

interface EmulatorStore {
  status: ShellRuntimeStatus;
  mode: RuntimeMode;
  error: string | null;
  storage: StorageState | null;
  telemetry: RuntimeTelemetry | null;
  processHandle: ProcessHandle | null;
  selectedProfileId: string | null;
  selectedGuestExecutable: string | null;
  logs: RuntimeLogEntry[];
  logsOpen: boolean;
  lastFrameAt: number | null;

  setStatus: (status: ShellRuntimeStatus) => void;
  setMode: (mode: RuntimeMode) => void;
  setError: (error: string | null) => void;
  setStorage: (storage: StorageState | null) => void;
  setTelemetry: (telemetry: RuntimeTelemetry) => void;
  setProcessHandle: (handle: ProcessHandle | null) => void;
  setSelectedProfileId: (appId: string | null) => void;
  setSelectedGuestExecutable: (path: string | null) => void;
  pushLog: (entry: RuntimeLogEntry) => void;
  replaceLogs: (logs: readonly RuntimeLogEntry[]) => void;
  clearLogs: () => void;
  setLogsOpen: (open: boolean) => void;
  toggleLogs: () => void;
  markFrame: () => void;
}

const MAX_MIRRORED_LOGS = 400;

/** Guest state is derived from the runtime, never tracked separately. */
export function guestStateOf(telemetry: RuntimeTelemetry | null): EmulatorState {
  return telemetry?.state ?? "idle";
}

export const useEmulatorStore = create<EmulatorStore>()((set, get) => ({
  status: "cold",
  mode: "unavailable",
  error: null,
  storage: null,
  telemetry: null,
  processHandle: null,
  selectedProfileId: null,
  selectedGuestExecutable: null,
  logs: [],
  logsOpen: false,
  lastFrameAt: null,

  setStatus: (status) => set({ status }),
  setMode: (mode) => set({ mode }),
  setError: (error) => set({ error }),
  setStorage: (storage) => set({ storage }),
  setTelemetry: (telemetry) => set({ telemetry }),
  setProcessHandle: (processHandle) => set({ processHandle }),
  setSelectedProfileId: (selectedProfileId) => set({ selectedProfileId }),
  setSelectedGuestExecutable: (selectedGuestExecutable) => set({ selectedGuestExecutable }),
  pushLog: (entry) =>
    set((state) => ({
      logs: [...state.logs, entry].slice(-MAX_MIRRORED_LOGS),
    })),
  replaceLogs: (logs) => set({ logs: [...logs].slice(-MAX_MIRRORED_LOGS) }),
  clearLogs: () => set({ logs: [] }),
  setLogsOpen: (logsOpen) => set({ logsOpen }),
  toggleLogs: () => {
    const { logsOpen } = get();
    set({ logsOpen: !logsOpen });
  },
  markFrame: () => set({ lastFrameAt: Date.now() }),
}));
