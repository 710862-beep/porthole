import type { StoreGame } from "./types";

/*
 * The Game Store library.
 *
 * Every entry is something this repository actually exercised. Evidence strings
 * are copied from docs/FINAL-STATUS-REPORT.md / the original shell catalog — they
 * are receipts, not marketing. Installation in the desktop is simulated locally:
 * no game bytes are downloaded by this shell.
 */
export const STORE_CATALOG: readonly StoreGame[] = [
  {
    appId: "chocolate-doom",
    title: "Chocolate Doom 3.1.1",
    kind: "game",
    category: "games",
    exePath: "C:\\Games\\ChocolateDoom\\chocolate-doom.exe",
    sha256: "15e81c194df270fbd71450222e71846247926fabfb889e72e7d855903454d752",
    status: "installed",
    version: "3.1.1 · Freedoom Phase 1",
    sizeMb: 24.6,
    genre: "Classic FPS",
    summary:
      "A conservative Doom source port running against the Freedoom Phase 1 WAD. This is the workload the Wasm core was validated on end-to-end.",
    evidence:
      "Gate 1 Tier B + Gate 2 PASS in CI: timedemo 2664 gametics == Wine 9.0; 1,782 distinct guest frames; title frame 64,000/64,000 px vs independent reference.",
    provenance:
      "Pinned CI fixture. The desktop opens the labelled mock runtime; the real Wasm core is a separate CI artifact.",
  },
  {
    appId: "freedoom",
    title: "Freedoom: Phase 1",
    kind: "game",
    category: "games",
    exePath: "C:\\Games\\ChocolateDoom\\freedoom.wad",
    status: "not-installed",
    version: "0.13 · IWAD",
    sizeMb: 31.2,
    genre: "Asset pack",
    summary:
      "The free Doom-compatible IWAD used by the Gate 2 run. Installing here registers the library entry only — bytes never leave your machine.",
    evidence:
      "Asset fixture for the Chocolate Doom Gate 2 workload. No standalone runtime claim is made for this WAD.",
    provenance:
      "Local asset provenance only. Storefront install is a simulated registration (no download).",
  },
  {
    appId: "7zip",
    title: "7-Zip 21.07",
    kind: "utility",
    category: "utilities",
    exePath: "C:\\Tools\\7za.exe",
    sha256: "b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95",
    status: "installed",
    version: "21.07 · console",
    sizeMb: 1.4,
    genre: "Utility",
    summary:
      "The 7za console binary used to prove the PE loader, Win32 file HLE and persistence path with a byte-identical archive round-trip.",
    evidence:
      "Gate 1 Tier A PASS in CI: real .7z create + extract round-trip, byte-identical.",
    provenance:
      "Console workload. Launch opens the shell terminal with the recorded CI evidence; there is no interactive session in this desktop.",
  },
  {
    appId: "porthole-engine",
    title: "Porthole x86-64 Engine",
    kind: "system",
    category: "system",
    exePath: "",
    status: "installed",
    version: "0.4.0 · Wasm",
    sizeMb: 3.8,
    genre: "Runtime",
    summary:
      "CPU interpreter, sparse VMM, PE32+ loader, Win32/SDL HLE and D3D12 fixture path, compiled to WebAssembly.",
    evidence:
      "Rust core + compatibility gates are covered by CI. This shell currently drives a clearly labelled mock runtime behind the same contract.",
    provenance:
      "Runtime core. The UI consumes only ui/runtime/contracts.ts shapes (ARCHITECTURE.md rule 3).",
  },
  {
    appId: "gate4-probe",
    title: "Gate 4 Device Probe",
    kind: "utility",
    category: "utilities",
    exePath: "C:\\Porthole\\gate4-probe.html",
    status: "not-installed",
    version: "probe-ready",
    sizeMb: 0.8,
    genre: "Diagnostics",
    summary:
      "Chromebook capability probe: storage policy, GPU tier and Wasm feature detection. Gate 4 is probe-ready; device results are not claimed.",
    evidence:
      "Probe implementation exists in the repository (gate4-probe.html, docs/gate4-chromebook-probe.md). No per-device pass is asserted here.",
    provenance:
      "Diagnostics entry. Launch opens the shell's system report, not the probe page.",
  },
];

/** Library entries present before the user installs anything. */
export const DEFAULT_INSTALLED_IDS: readonly string[] = [
  "chocolate-doom",
  "7zip",
  "porthole-engine",
];

export function findGame(appId: string): StoreGame | null {
  return STORE_CATALOG.find((game) => game.appId === appId) ?? null;
}
