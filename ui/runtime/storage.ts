/*
 * Host storage selection for the desktop.
 *
 * Preference order mirrors the runtime's hybrid model:
 *   File System Access (a folder the user picks — "External NVMe")
 *     → OPFS (origin-private, persistent)
 *       → in-memory (volatile).
 *
 * Honesty rules kept from ui/README.md:
 *  - A directory handle cannot survive a reload; on restore we fall back to OPFS
 *    instead of pretending the NVMe mount is still there.
 *  - Choosing a folder performs a write/delete probe before we call it mounted.
 */

import type {
  NvmeSelection,
  PortholeStorageService,
  StorageBackendId,
  StorageCapability,
  StorageProbe,
  StorageState,
} from "./types";

const PREF_KEY = "porthole.ui.storage.v2";
const PROBE_FILE = ".porthole-probe";

function describeError(error: unknown): string {
  if (error instanceof DOMException) {
    return `${error.name}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function readPreference(): StorageBackendId | null {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw === "file-system-access" || raw === "opfs" || raw === "memory") return raw;
  } catch {
    /* storage can be blocked; the shell still works in memory */
  }
  return null;
}

function writePreference(backend: StorageBackendId): void {
  try {
    if (backend === "file-system-access") localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, backend);
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

export class BrowserStorageService implements PortholeStorageService {
  private backend: StorageBackendId = "opfs";
  private directory: FileSystemDirectoryHandle | null = null;
  private detail = "";

  constructor() {
    const preference = readPreference();
    // A folder handle is session-scoped, so a stored FSA preference cannot be
    // honoured after reload — fall back to OPFS and say so in the boot flow.
    this.backend = preference === "memory" ? "memory" : "opfs";
    if (preference === "file-system-access") {
      this.detail = "Folder access is session-scoped and was not preserved across reload.";
    }
  }

  selected(): StorageBackendId {
    return this.backend;
  }

  /** StorageSelector contract: async because FSA needs a user-gesture picker. */
  async select(backend: StorageBackendId): Promise<void> {
    if (backend === "file-system-access") {
      const result = await this.requestNvme();
      if (!result.ok) throw new Error(result.reason);
      return;
    }
    this.setSelected(backend);
  }

  describeSelected(): StorageState {
    return {
      backend: this.backend,
      label: this.labelFor(this.backend),
      detail:
        this.detail ||
        (this.backend === "file-system-access"
          ? "Guest RAM overflow and VFS shards are written to the selected folder."
          : this.backend === "opfs"
            ? "Guest RAM overflow and VFS shards are stored in this origin's OPFS."
            : "Volatile: everything is lost when the tab closes."),
    };
  }

  setSelected(backend: StorageBackendId, detail?: string): StorageState {
    if (backend === "file-system-access" && !this.directory) {
      throw new Error(
        "A folder has to be picked first — call requestNvme() to open the directory picker.",
      );
    }
    this.backend = backend;
    if (detail !== undefined) this.detail = detail;
    writePreference(backend);
    return this.describeSelected();
  }

  clearSelection(): void {
    this.directory = null;
    this.backend = "opfs";
    this.detail = "";
    try {
      localStorage.removeItem(PREF_KEY);
    } catch {
      /* ignore */
    }
  }

  /**
   * "External NVMe" mount. Opens the directory picker, verifies permission and
   * proves writability with a probe file before reporting success.
   */
  async requestNvme(): Promise<NvmeSelection> {
    const picker = typeof window !== "undefined" ? window.showDirectoryPicker : undefined;
    if (typeof picker !== "function") {
      return {
        ok: false,
        reason:
          "File System Access API is unavailable (Chromium-based browser over HTTPS required).",
      };
    }

    let handle: FileSystemDirectoryHandle;
    try {
      handle = await picker({ id: "porthole-nvme", mode: "readwrite", startIn: "downloads" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return { ok: false, reason: "Folder selection was cancelled." };
      }
      return { ok: false, reason: `Directory picker failed — ${describeError(error)}` };
    }

    try {
      let permission: PermissionState = "granted";
      if (typeof handle.queryPermission === "function") {
        permission = await handle.queryPermission({ mode: "readwrite" });
        if (permission === "prompt" && typeof handle.requestPermission === "function") {
          permission = await handle.requestPermission({ mode: "readwrite" });
        }
      }
      if (permission === "denied") {
        return { ok: false, reason: "Write permission for that folder was denied." };
      }

      const probe = await handle.getFileHandle(PROBE_FILE, { create: true });
      const writable = await probe.createWritable();
      await writable.write("porthole");
      await writable.close();
      await handle.removeEntry(PROBE_FILE);
    } catch (error) {
      return { ok: false, reason: `Folder is not usable — ${describeError(error)}` };
    }

    this.directory = handle;
    this.backend = "file-system-access";
    this.detail = `Mounted “${handle.name}/” for the current session (write probe passed).`;
    writePreference("file-system-access");
    return {
      ok: true,
      label: `${handle.name}/`,
      detail: this.detail,
    };
  }

  async detect(): Promise<StorageCapability[]> {
    const probes = await this.detectProbes();
    return probes.map(({ backend, available, detail }) => ({ backend, available, detail }));
  }

  async detectProbes(): Promise<StorageProbe[]> {
    const hasPicker =
      typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
    const opfsDetail = await this.probeOpfs();

    const probes: StorageProbe[] = [
      {
        backend: "file-system-access",
        label: "External NVMe drive",
        description:
          "Mount a real folder. Guest RAM overflow and the virtual disk land on disk you control.",
        available: hasPicker,
        recommended: false,
        detail: hasPicker
          ? "showDirectoryPicker() is available in this browser."
          : "Unavailable: this browser does not expose showDirectoryPicker().",
      },
      {
        backend: "opfs",
        label: "Local browser storage (OPFS)",
        description:
          "Origin-private file system. No dialog, survives reloads, bounded by the browser's quota.",
        available: opfsDetail.startsWith("OPFS write"),
        recommended: false,
        detail: opfsDetail,
      },
      {
        backend: "memory",
        label: "In-memory only",
        description: "Volatile fallback. Nothing is written; closing the tab discards the disk.",
        available: true,
        recommended: false,
        detail: "Always available. Data is lost when the tab closes.",
      },
    ];

    const preferred = probes.find((probe) => probe.backend === "opfs" && probe.available) ??
      probes.find((probe) => probe.backend === "file-system-access" && probe.available);
    if (preferred) preferred.recommended = true;
    return probes;
  }

  private async probeOpfs(): Promise<string> {
    const manager = typeof navigator !== "undefined" ? navigator.storage : undefined;
    if (!manager || typeof manager.getDirectory !== "function") {
      return "Unavailable: navigator.storage.getDirectory() is missing.";
    }
    try {
      const root = await manager.getDirectory();
      const handle = await root.getFileHandle(PROBE_FILE, { create: true });
      const writable = await handle.createWritable();
      await writable.write("porthole");
      await writable.close();
      await root.removeEntry(PROBE_FILE);
      return "OPFS write/read probe passed.";
    } catch (error) {
      return `OPFS available but the probe failed — ${describeError(error)}`;
    }
  }

  private labelFor(backend: StorageBackendId): string {
    if (backend === "file-system-access") {
      return this.directory ? `${this.directory.name}/` : "External drive (not mounted)";
    }
    if (backend === "opfs") return "Browser storage (OPFS)";
    return "In-memory (volatile)";
  }
}
