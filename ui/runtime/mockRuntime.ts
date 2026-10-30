/*
 * MOCK EMULATOR RUNTIME — frames are synthetic and always labelled as such.
 *
 * This class exists so the desktop can be built, exercised and demoed without the
 * compiled Wasm artifact. It implements the same `ExtendedEmulatorRuntime` contract
 * the real BrowserX64Emulator adapter will implement. It NEVER claims guest
 * execution: logs say "mock", the UI shows a "SYNTHETIC SCANOUT" badge, and
 * telemetry is explicitly not evidence.
 *
 * Frame authority: `getFramebuffer()` returns pixels produced here, not by a guest.
 * Do not ship this mode as emulator evidence (ARCHITECTURE rule 5).
 */

import type {
  EmulatorState,
  ExtendedEmulatorRuntime,
  ProcessHandle,
  RuntimeLogEntry,
  RuntimeLogLevel,
  RuntimeMode,
  RuntimeTelemetry,
  StorageBackendId,
} from "./types";

const FRAME_WIDTH = 240;
const FRAME_HEIGHT = 135;
const FRAME_INTERVAL_MS = 1000 / 30;
const TELEMETRY_INTERVAL_MS = 500;
const MAX_LOGS = 500;
const MAX_RESIDENT_PAGES = 192;
const MOCK_IPS = 2_400_000; // instructions/second, synthetic pace

const TAU = Math.PI * 2;
const SIN_SIZE = 2048;
const SIN_TABLE = new Float32Array(SIN_SIZE);
for (let i = 0; i < SIN_SIZE; i += 1) {
  SIN_TABLE[i] = Math.sin((i / SIN_SIZE) * TAU);
}

/** Table-driven sine — keeps the 30 fps generator off the hot Math.sin path. */
function fastSin(phase: number): number {
  return SIN_TABLE[((phase * (SIN_SIZE / TAU)) | 0) & (SIN_SIZE - 1)] ?? 0;
}

function clampByte(value: number): number {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return value | 0;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** ImageData is DOM-only; tests can polyfill it, browser gets the real one. */
function createFrame(width: number, height: number): ImageData {
  if (typeof ImageData !== "undefined") {
    return new ImageData(width, height);
  }
  const data = new Uint8ClampedArray(width * height * 4);
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

export class MockEmulatorRuntime implements ExtendedEmulatorRuntime {
  readonly mode: RuntimeMode = "mock";

  private state: EmulatorState = "idle";
  private processId: ProcessHandle | null = null;
  private executable: string | null = null;
  private storageBackend: StorageBackendId = "opfs";
  private initialized = false;
  private disposed = false;

  private frame: ImageData | null = null;
  private pixels: Uint32Array | null = null;
  private paintPhase = 0;
  private presented = 0;
  private residentPages = 0;
  private checksum = "";
  private fps = 0;
  private lastPaintAt = 0;
  private frameGaps: number[] = [];

  private runningSince: number | null = null;
  private accumulatedUptime = 0;
  private inputEvents = 0;

  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;

  private logSequence = 1;
  private logs: RuntimeLogEntry[] = [];

  private readonly stateListeners = new Set<(state: EmulatorState) => void>();
  private readonly frameListeners = new Set<() => void>();
  private readonly telemetryListeners = new Set<(telemetry: RuntimeTelemetry) => void>();
  private readonly logListeners = new Set<(entry: RuntimeLogEntry) => void>();

  /* ---------------------------------------------------------------- lifecycle */

  async initialize(storage: StorageBackendId): Promise<void> {
    if (this.disposed) return;
    this.storageBackend = storage;
    if (!this.initialized) {
      this.initialized = true;
      this.emitLog("info", "runtime", `mock runtime initialised · storage=${storage}`);
      this.emitLog(
        "warn",
        "runtime",
        "MOCK MODE — frames and counters are synthetic. Not guest evidence.",
      );
      this.emitLog(
        "info",
        "hle",
        "mock surface: kernel32 · user32 · gdi32 · sdl2 · d3d12-fixture",
      );
    } else {
      this.emitLog("info", "storage", `backend remounted: ${storage}`);
    }
    await delay(120);
    this.emitTelemetry();
  }

  async loadExecutable(path: string): Promise<ProcessHandle> {
    if (this.disposed) throw new Error("runtime disposed");
    if (this.state === "running" || this.state === "paused") {
      await this.terminate(this.processId ?? "");
    }
    this.stopFrameLoop();
    this.stopTelemetryTimer();
    this.resetSession();
    this.executable = path;
    this.setState("loading");
    this.emitLog("info", "loader", `accepted ${path} (mock: no PE bytes read)`);
    await delay(160);
    if (this.disposed) throw new Error("runtime disposed");
    this.processId = `proc-${this.logSequence.toString(36)}-${Date.now().toString(36)}`;
    this.setState("idle");
    this.emitLog("info", "loader", `process ${this.processId} queued · entry not executed`);
    return this.processId;
  }

  async launch(handle: ProcessHandle): Promise<void> {
    if (this.disposed) throw new Error("runtime disposed");
    if (!this.processId || handle !== this.processId) {
      throw new Error(`launch: unknown process handle (${handle})`);
    }
    if (this.state === "running") return;
    if (!this.frame) this.ensureFrame();
    this.runningSince = now();
    this.lastPaintAt = 0;
    this.frameGaps = [];
    this.setState("running");
    this.emitLog("info", "runtime", `launch ${handle} · mock frame source @30fps`);
    this.startTelemetryTimer();
    this.paintFrame();
    this.ensureFrameLoop();
    this.emitTelemetry();
  }

  async pause(handle: ProcessHandle): Promise<void> {
    if (this.processId && handle !== this.processId) {
      throw new Error(`pause: unknown process handle (${handle})`);
    }
    if (this.state !== "running") return;
    this.stopFrameLoop();
    this.stopTelemetryTimer();
    this.accumulateUptime();
    this.setState("paused");
    this.emitLog("info", "runtime", "guest paused (mock scheduler halted)");
    this.emitTelemetry();
  }

  async terminate(handle: ProcessHandle): Promise<void> {
    if (this.state === "exited" || this.state === "faulted") return;
    if (this.processId && handle !== this.processId) {
      throw new Error(`terminate: unknown process handle (${handle})`);
    }
    this.stopFrameLoop();
    this.stopTelemetryTimer();
    this.accumulateUptime();
    const finished = this.processId;
    this.processId = null;
    this.setState("exited");
    this.emitLog("info", "runtime", `process ${finished ?? "(none)"} terminated`);
    this.emitTelemetry();
  }

  dispose(): void {
    this.disposed = true;
    this.stopFrameLoop();
    this.stopTelemetryTimer();
    this.stateListeners.clear();
    this.frameListeners.clear();
    this.telemetryListeners.clear();
    this.logListeners.clear();
  }

  /* --------------------------------------------------------------- observation */

  getState(): EmulatorState {
    return this.state;
  }

  onStateChange(callback: (state: EmulatorState) => void): void {
    this.stateListeners.add(callback);
  }

  offStateChange(callback: (state: EmulatorState) => void): void {
    this.stateListeners.delete(callback);
  }

  onFrameReady(callback: () => void): void {
    this.frameListeners.add(callback);
    if (this.state === "running") this.ensureFrameLoop();
  }

  offFrameReady(callback: () => void): void {
    this.frameListeners.delete(callback);
    if (this.frameListeners.size === 0) this.stopFrameLoop();
  }

  onTelemetry(callback: (telemetry: RuntimeTelemetry) => void): () => void {
    this.telemetryListeners.add(callback);
    return () => {
      this.telemetryListeners.delete(callback);
    };
  }

  onLog(callback: (entry: RuntimeLogEntry) => void): () => void {
    this.logListeners.add(callback);
    return () => {
      this.logListeners.delete(callback);
    };
  }

  getLogs(): readonly RuntimeLogEntry[] {
    return this.logs;
  }

  clearLogs(): void {
    this.logs = [];
  }

  getTelemetry(): RuntimeTelemetry {
    const runningMs =
      this.accumulatedUptime +
      (this.runningSince !== null ? now() - this.runningSince : 0);
    return {
      state: this.state,
      processId: this.processId,
      executable: this.executable,
      instructionsExecuted:
        Math.floor((runningMs / 1000) * MOCK_IPS) + this.presented * 1024,
      presentedFrames: this.presented,
      residentPages: this.residentPages,
      maxResidentPages: MAX_RESIDENT_PAGES,
      fps: this.state === "running" ? Math.round(this.fps) : 0,
      frameChecksum: this.checksum,
      uptimeMs: Math.round(runningMs),
      storageBackend: this.storageBackend,
      inputEvents: this.inputEvents,
    };
  }

  /* ------------------------------------------------------------------- input */

  sendKeyEvent(key: string, state: "down" | "up"): void {
    this.inputEvents += 1;
    if (this.inputEvents === 1 || this.inputEvents % 40 === 0) {
      this.emitLog(
        "debug",
        "input",
        `key ${state} ${key} accepted by shell (KI-04: no guest delivery yet)`,
      );
    }
  }

  sendMouseEvent(button: 0 | 1 | 2, x: number, y: number): void {
    this.inputEvents += 1;
    if (this.inputEvents === 1 || this.inputEvents % 40 === 0) {
      this.emitLog(
        "debug",
        "input",
        `mouse ${button} @${Math.round(x)},${Math.round(y)} accepted (KI-04)`,
      );
    }
  }

  getFramebuffer(): ImageData | null {
    return this.frame;
  }

  /* ----------------------------------------------------------------- internals */

  private setState(next: EmulatorState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
    this.emitTelemetry();
  }

  private emitTelemetry(): void {
    const snapshot = this.getTelemetry();
    for (const listener of this.telemetryListeners) listener(snapshot);
  }

  private emitLog(level: RuntimeLogLevel, source: string, message: string): void {
    const entry: RuntimeLogEntry = {
      id: this.logSequence,
      ts: Date.now(),
      level,
      source,
      message,
    };
    this.logSequence += 1;
    this.logs = [...this.logs, entry].slice(-MAX_LOGS);
    for (const listener of this.logListeners) listener(entry);
  }

  private resetSession(): void {
    this.accumulatedUptime = 0;
    this.runningSince = null;
    this.presented = 0;
    this.paintPhase = 0;
    this.checksum = "";
    this.residentPages = 0;
    this.fps = 0;
    this.lastPaintAt = 0;
    this.frameGaps = [];
    this.inputEvents = 0;
  }

  private accumulateUptime(): void {
    if (this.runningSince !== null) {
      this.accumulatedUptime += now() - this.runningSince;
      this.runningSince = null;
    }
  }

  private ensureFrame(): void {
    if (!this.frame) {
      this.frame = createFrame(FRAME_WIDTH, FRAME_HEIGHT);
      this.pixels = new Uint32Array(
        this.frame.data.buffer,
        this.frame.data.byteOffset,
        FRAME_WIDTH * FRAME_HEIGHT,
      );
    }
  }

  private ensureFrameLoop(): void {
    if (this.disposed || this.frameTimer !== null) return;
    if (this.state !== "running" || this.frameListeners.size === 0) return;
    const tick = (): void => {
      this.frameTimer = null;
      if (this.statusFinished()) return;
      this.paintFrame();
      this.frameTimer = setTimeout(tick, FRAME_INTERVAL_MS);
    };
    this.frameTimer = setTimeout(tick, 0);
  }

  private stopFrameLoop(): void {
    if (this.frameTimer !== null) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
  }

  private startTelemetryTimer(): void {
    this.stopTelemetryTimer();
    this.telemetryTimer = setInterval(() => {
      this.emitTelemetry();
    }, TELEMETRY_INTERVAL_MS);
  }

  private stopTelemetryTimer(): void {
    if (this.telemetryTimer !== null) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
  }

  /** True when the guest may no longer produce frames. */
  private statusFinished(): boolean {
    return this.state !== "running" || this.disposed;
  }

  /**
   * Synthetic scanout: a 240×135 aurora plasma, deliberately low-resolution so the
   * desktop can scale it (like a real guest framebuffer). All pixels are host-made.
   */
  private paintFrame(): void {
    this.ensureFrame();
    const frame = this.frame;
    const pixels = this.pixels;
    if (!frame || !pixels) return;

    const t = this.paintPhase * 0.09;
    const cx = 0.5 + fastSin(t * 0.42) * 0.16;
    const cy = 0.45 + fastSin(t * 0.31 + 1.7) * 0.08;

    for (let y = 0; y < FRAME_HEIGHT; y += 1) {
      const py = y / FRAME_HEIGHT;
      for (let x = 0; x < FRAME_WIDTH; x += 1) {
        const px = x / FRAME_WIDTH;
        const wave =
          fastSin(px * 8.5 + t * 1.2) * 0.5 +
          fastSin(py * 6.0 - t * 0.8) * 0.35 +
          fastSin((px + py) * 4.5 + t * 0.5) * 0.15;
        const dx = px - cx;
        const dy = py - cy;
        const radial = 1 / (1 + (dx * dx * 1.1 + dy * dy * 2.4) * 64);
        const horizonY = 0.64 + fastSin(px * 4.2 + t * 0.6) * 0.05;
        const hd = py - horizonY;
        const horizon = 1 / (1 + hd * hd * 520);
        const hue = 0.5 + 0.5 * fastSin(px * 2.6 - py * 1.8 + t * 0.55);
        let energy = 0.08 + Math.max(wave, 0) * 0.4 + radial * 0.46 + horizon * 0.5;
        if (energy > 1) energy = 1;

        const scanline = (y & 1) === 0 ? 1 : 0.84;
        const vignette =
          1 - 0.42 * (Math.abs(px - 0.5) * 1.2 + Math.abs(py - 0.5) * 0.6);
        const shade = scanline * vignette;

        const r = (10 + energy * (28 + hue * 152)) * shade;
        const g = (12 + energy * (118 + hue * 82)) * shade;
        const b = (22 + energy * (178 + hue * 64)) * shade;

        pixels[y * FRAME_WIDTH + x] =
          0xff000000 |
          (clampByte(b) << 16) |
          (clampByte(g) << 8) |
          clampByte(r);
      }
    }

    this.paintPhase += 1;
    this.presented += 1;
    this.residentPages = Math.round(
      108 + fastSin(this.paintPhase * 0.06) * 18 + fastSin(this.paintPhase * 0.013) * 12,
    );

    const paintedAt = now();
    if (this.lastPaintAt > 0) {
      this.frameGaps.push(paintedAt - this.lastPaintAt);
      if (this.frameGaps.length > 20) this.frameGaps.shift();
      const total = this.frameGaps.reduce((sum, gap) => sum + gap, 0);
      this.fps = total > 0 ? (this.frameGaps.length * 1000) / total : 0;
    }
    this.lastPaintAt = paintedAt;

    if (this.presented % 24 === 0) {
      this.checksum = this.computeChecksum(frame.data);
    }
    if (this.presented % 90 === 0) {
      this.emitLog(
        "debug",
        "sdl",
        `present #${this.presented} · ${FRAME_WIDTH}×${FRAME_HEIGHT} (synthetic)`,
      );
    }

    for (const listener of this.frameListeners) listener();
  }

  /** FNV-1a-style digest over a sparse sample; clearly a mock checksum shape. */
  private computeChecksum(data: Uint8ClampedArray): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < data.length; i += 997) {
      const byte = data[i] ?? 0;
      h1 ^= byte;
      h1 = Math.imul(h1, 16777619);
      h2 = Math.imul(h2 ^ byte, 2246822519);
    }
    const hex = (h1 >>> 0).toString(16).padStart(8, "0");
    const hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
    return `fnv1a64:${hex}${hex2}`;
  }
}
