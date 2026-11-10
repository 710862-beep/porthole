import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Archive,
  BriefcaseBusiness,
  Boxes,
  Code2,
  Cpu,
  Download,
  FileQuestion,
  Film,
  Gamepad2,
  Globe2,
  HardDrive,
  MessagesSquare,
  Package,
  Palette,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
  ScrollText,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  ChocolateyPackageMetadata,
  ChocolateyRefreshResult,
  RuntimeLogEntry,
  RuntimeLogLevel,
  StoreCategoryId,
  StoreGame,
  StoredPackageArchive,
} from "@runtime/types";
import {
  chocolateyPackageFileName,
  downloadChocolateyPackage,
  searchChocolateyPackages,
  type ChocolateyPackageDownloadProgress,
} from "@runtime/chocolateyMetadata";
import { useRuntime } from "@/hooks/useRuntime";
import { inspectChocolateyArchive, type ChocolateyArchiveInspection, type EmbeddedGuestExecutable, type PackagePayloadFile } from "@runtime/chocolateyInstaller";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useLibraryStore } from "@/store/libraryStore";
import { useEmulatorStore } from "@/store/emulatorStore";
import { toast } from "@/store/uiStore";
import { confirmAction, reportError } from "@/store/dialogStore";
import { AppIcon } from "@/components/ui/AppIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LogConsole } from "@/components/ui/LogConsole";
import { Skeleton } from "@/components/ui/Skeleton";
import { GameGrid } from "./GameGrid";
import { GameDetails, type PackageDownloadStatus } from "./GameDetails";
import { cn } from "@/lib/cn";
import { coverStyle } from "./cover";

type StoreSection = "explore" | "chocolatey" | "downloads";
type LibraryFilter = "all" | StoreCategoryId;

const CATEGORY_LABELS: Record<StoreCategoryId, { label: string; icon: LucideIcon }> = {
  games: { label: "Games", icon: Gamepad2 },
  utilities: { label: "Utilities", icon: Wrench },
  system: { label: "System", icon: Cpu },
  development: { label: "Development", icon: Code2 },
  browsers: { label: "Browsers", icon: Globe2 },
  media: { label: "Media", icon: Film },
  creativity: { label: "Creativity", icon: Palette },
  productivity: { label: "Productivity", icon: BriefcaseBusiness },
  communications: { label: "Communications", icon: MessagesSquare },
};

const FILTERS: Array<{ id: LibraryFilter; label: string; icon: LucideIcon }> = [
  { id: "all", label: "All apps", icon: Store },
  ...(
    ["games", "utilities", "system", "development", "browsers", "media", "creativity", "productivity", "communications"] as const
  ).map((id) => ({ id, ...CATEGORY_LABELS[id] })),
];

const SECTIONS: Array<{ id: StoreSection; label: string; icon: LucideIcon }> = [
  { id: "explore", label: "Explore", icon: Store },
  { id: "chocolatey", label: "Chocolatey", icon: Boxes },
  { id: "downloads", label: "Downloads", icon: Archive },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stableArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function safePackagePathSegment(value: string): string {
  return value
    .replaceAll("/", "_")
    .replaceAll("\\", "_")
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/^\.+$/, "_")
    .trim()
    .slice(0, 120) || "package";
}

function payloadFileForGuest(payload: PackagePayloadFile, archiveName: string): File {
  const file = new File([stableArrayBuffer(payload.bytes)], payload.name, { type: "application/octet-stream" });
  const archiveFolder = safePackagePathSegment(archiveName.replace(/\.nupkg$/i, ""));
  Object.defineProperty(file, "portholeRelativePath", {
    value: `StorePackages/${archiveFolder}/${payload.path}`,
    configurable: false,
    enumerable: false,
  });
  return file;
}

function packageArchivesFor(game: StoreGame, archives: StoredPackageArchive[]): StoredPackageArchive[] {
  if (!game.chocolateyPackageId) return [];
  const prefix = `chocolatey-${game.chocolateyPackageId.toLowerCase()}-`;
  return archives.filter((archive) => {
    const name = archive.name.toLowerCase();
    return name.startsWith(prefix) && name.endsWith(".nupkg");
  });
}

function currentPackagePath(game: StoreGame, archives: StoredPackageArchive[]): string | null {
  if (!game.chocolateyPackageId) return null;
  try {
    const expectedName = chocolateyPackageFileName(
      game.chocolateyPackageId,
      game.chocolatey?.version || "latest",
    ).toLowerCase();
    return archives.find((archive) => archive.name.toLowerCase() === expectedName)?.path ?? null;
  } catch {
    return null;
  }
}

function categoryForPackage(metadata: ChocolateyPackageMetadata): StoreCategoryId {
  const text = `${metadata.packageId} ${metadata.title} ${metadata.tags.join(" ")}`.toLowerCase();
  if (/browser|chrome|firefox|edge|brave/.test(text)) return "browsers";
  if (/game|steam|minecraft|doom|gog|epicgames/.test(text)) return "games";
  if (/code|developer|visual.?studio|python|nodejs|git|compiler|sdk/.test(text)) return "development";
  if (/audio|video|media|vlc|audacity|obs/.test(text)) return "media";
  if (/image|photo|graphics|gimp|inkscape|blender/.test(text)) return "creativity";
  if (/office|document|pdf|libreoffice|sumatra/.test(text)) return "productivity";
  if (/chat|messag|discord|telegram|signal/.test(text)) return "communications";
  if (/system|driver|runtime|directx|dotnet|visual.?c\+\+/.test(text)) return "system";
  return "utilities";
}

function gameFromChocolatey(metadata: ChocolateyPackageMetadata): StoreGame {
  const title = metadata.title.trim() || metadata.packageId;
  return {
    appId: `chocolatey:${metadata.packageId.toLowerCase()}`,
    title,
    kind: "utility",
    category: categoryForPackage(metadata),
    exePath: "",
    status: "not-in-library",
    version: metadata.version || "Latest version",
    sizeMb: 0,
    genre: "Chocolatey package",
    summary: metadata.summary || metadata.description || "Community package listing from Chocolatey.",
    chocolateyPackageId: metadata.packageId,
    chocolatey: metadata,
    evidence: "Live Chocolatey repository metadata only. No install, executable, or Porthole compatibility has been verified.",
    provenance: "Chocolatey Community Repository search result. Porthole can save the .nupkg archive, inspect it for direct PE32+ x64 executables, and—after confirmation—launch an embedded EXE inside its Wasm guest. Package scripts, MSI installers, and external download links are not executed or followed.",
  };
}

function gameFromStoredArchive(archive: StoredPackageArchive): StoreGame | null {
  const stem = archive.name.replace(/^chocolatey-/i, "").replace(/\.nupkg$/i, "");
  const match = /^(.+)-([0-9][a-z0-9.+_-]*)$/i.exec(stem) ?? /^(.+)-(latest)$/i.exec(stem);
  const packageId = match?.[1];
  const version = match?.[2];
  if (!packageId || !version) return null;
  return gameFromChocolatey({
    packageId,
    version,
    title: packageId,
    summary: "Saved Chocolatey archive. Package metadata is not currently loaded.",
    description: "Inspect this archive to find directly embedded PE32+ x64 executables. Package scripts are not executed.",
    projectUrl: `https://community.chocolatey.org/packages/${encodeURIComponent(packageId)}`,
    tags: [],
    publishedAt: "",
    downloadCount: null,
    fetchedAt: archive.lastModified,
    source: "Chocolatey Community Repository",
  });
}

function packageLabel(archive: StoredPackageArchive): string {
  return archive.name
    .replace(/^chocolatey-/i, "")
    .replace(/\.nupkg$/i, "")
    .replace(/-([0-9][a-z0-9.+_-]*)$/i, " · $1");
}

/**
 * Porthole App Store: curated app profiles plus live Chocolatey package search.
 * Package archives remain separate from guest files; direct embedded x64 EXEs
 * may be explicitly launched inside the Wasm guest, but Chocolatey scripts/URLs
 * and MSI packages are never executed.
 */
export function GameStoreApp() {
  const { runtime, store: gameStore, storage } = useRuntime();
  const { openApp } = useWindowManager();
  const games = useLibraryStore((state) => state.games);
  const runtimeLogs = useEmulatorStore((state) => state.logs);
  const logsOpen = useEmulatorStore((state) => state.logsOpen);
  const runtimeMode = useEmulatorStore((state) => state.mode);
  const runtimeStatus = useEmulatorStore((state) => state.status);
  const guestState = useEmulatorStore((state) => state.telemetry?.state ?? "idle");
  const mountedStorageLabel = useEmulatorStore((state) => state.storage?.label ?? "");
  const storageBackend = useEmulatorStore((state) => state.storage?.backend ?? storage.selected());
  const storageLabel = mountedStorageLabel || storage.describeSelected().label;

  const [section, setSection] = useState<StoreSection>("explore");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [query, setQuery] = useState("");
  const [detailsGame, setDetailsGame] = useState<StoreGame | null>(null);
  const [localLogs, setLocalLogs] = useState<RuntimeLogEntry[]>([]);
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [metadataResult, setMetadataResult] = useState<ChocolateyRefreshResult | null>(null);
  const [storedPackages, setStoredPackages] = useState<StoredPackageArchive[]>([]);
  const [storedPackagesLoading, setStoredPackagesLoading] = useState(false);
  const [packageDownloadStatus, setPackageDownloadStatus] = useState<PackageDownloadStatus | null>(null);
  const [archiveInspection, setArchiveInspection] = useState<(ChocolateyArchiveInspection & { archiveName: string; error: string | null }) | null>(null);
  const [inspectingArchive, setInspectingArchive] = useState(false);
  const [installerArguments, setInstallerArguments] = useState("");
  const [installerLaunchBusy, setInstallerLaunchBusy] = useState(false);
  const [chocolateyPackages, setChocolateyPackages] = useState<ChocolateyPackageMetadata[]>([]);
  const [searchedTerm, setSearchedTerm] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchNextUrl, setSearchNextUrl] = useState<string | null>(null);
  const [searchTotal, setSearchTotal] = useState<number | null>(null);

  const logSequence = useRef(-1);
  const seeded = useRef(false);
  const metadataStarted = useRef(false);
  const packageDownloadController = useRef<AbortController | null>(null);
  const searchController = useRef<AbortController | null>(null);

  const appendLog = useCallback((level: RuntimeLogLevel, message: string): void => {
    const entry: RuntimeLogEntry = {
      id: logSequence.current--,
      ts: Date.now(),
      level,
      source: "store",
      message,
    };
    setLocalLogs((previous) => [...previous, entry].slice(-80));
  }, []);

  const refreshStoredPackages = useCallback(async (): Promise<StoredPackageArchive[] | null> => {
    setStoredPackagesLoading(true);
    try {
      const archives = await storage.listStoredPackageArchives();
      if (storage.selected() !== storageBackend) return null;
      setStoredPackages(archives);
      return archives;
    } catch (error) {
      appendLog("warn", `could not inspect Porthole package storage: ${errorMessage(error)}`);
      return null;
    } finally {
      setStoredPackagesLoading(false);
    }
  }, [appendLog, storage, storageBackend]);

  useEffect(() => {
    void refreshStoredPackages();
  }, [refreshStoredPackages]);

  useEffect(() => () => {
    packageDownloadController.current?.abort();
    searchController.current?.abort();
  }, []);

  const refreshMetadata = useCallback(async (): Promise<void> => {
    if (metadataBusy) return;
    setMetadataBusy(true);
    appendLog("info", "Refreshing curated Chocolatey package metadata");
    try {
      const result = await gameStore.refreshChocolateyMetadata();
      setMetadataResult(result);
      const cacheLabel = result.fromCache ? (result.error ? " · cached fallback" : " · cache hit") : " · live feed";
      if (result.error) {
        appendLog("warn", `Chocolatey metadata: ${result.updated} updated, ${result.missing} missing${cacheLabel} · ${result.error}`);
      } else {
        appendLog("info", `Chocolatey metadata: ${result.updated} records refreshed${cacheLabel}`);
      }
    } catch (error) {
      const message = errorMessage(error);
      setMetadataResult({
        updated: 0,
        missing: games.filter((game) => Boolean(game.chocolateyPackageId)).length,
        fetchedAt: 0,
        fromCache: false,
        error: message,
        source: "Chocolatey Community Repository",
      });
      appendLog("error", `Chocolatey metadata refresh failed · ${message}`);
    } finally {
      setMetadataBusy(false);
    }
  }, [appendLog, gameStore, games, metadataBusy]);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    appendLog("info", "App Store ready · curated profiles and live Chocolatey search available");
    appendLog("info", "Download saves a .nupkg archive; direct embedded x64 EXEs require inspection and explicit guest-run confirmation");
  }, [appendLog]);

  useEffect(() => {
    if (metadataStarted.current) return;
    metadataStarted.current = true;
    void refreshMetadata();
  }, [refreshMetadata]);

  const curatedFiltered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return games.filter((game) => {
      const matchesFilter = filter === "all" || game.category === filter;
      const matchesQuery =
        !needle ||
        [
          game.title,
          game.summary,
          game.genre,
          game.version,
          game.chocolatey?.title ?? "",
          game.chocolatey?.summary ?? "",
          game.chocolatey?.tags.join(" ") ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      return matchesFilter && matchesQuery;
    });
  }, [filter, games, query]);

  const remoteGames = useMemo(() => chocolateyPackages.map(gameFromChocolatey), [chocolateyPackages]);
  const featuredGame = games.find((game) => game.appId === "7zip") ?? games.find((game) => game.chocolateyPackageId);
  const inLibraryCount = games.filter((game) => game.status === "in-library").length;
  const downloadedPackageIds = useMemo(() => {
    const allGames = [...games, ...remoteGames];
    return new Set(allGames
      .filter((game) => packageArchivesFor(game, storedPackages).length > 0)
      .map((game) => game.appId));
  }, [games, remoteGames, storedPackages]);

  const detailsIsCatalogEntry = detailsGame
    ? games.some((game) => game.appId === detailsGame.appId)
    : false;
  const detailsStoredArchives = detailsGame ? packageArchivesFor(detailsGame, storedPackages) : [];
  const detailsDownloadedPackagePaths = detailsStoredArchives.map((archive) => `${storageLabel}/${archive.path}`);
  const detailsCurrentPackagePath = detailsGame ? currentPackagePath(detailsGame, storedPackages) : null;
  const detailsInstallerArchive = detailsStoredArchives.find((archive) => archive.path === detailsCurrentPackagePath) ?? detailsStoredArchives[0] ?? null;
  const currentArchiveInspection = archiveInspection?.archiveName === detailsInstallerArchive?.name ? archiveInspection : null;
  const installerRunDisabledReason = runtimeMode !== "wasm"
    ? "Initialize the ABI-v3 Wasm runtime in Emulator first."
    : runtimeStatus !== "ready"
      ? "The Emulator runtime is not ready."
      : !runtime.supportsGuestFilePersistence()
        ? "The loaded Wasm artifact cannot persist guest installs yet. Wait for the updated CI-published runtime."
        : !["idle", "exited", "faulted"].includes(guestState)
        ? "Stop or finish the current guest workload before starting an installer."
        : null;
  const packageDownloadDisabledReason = !detailsGame?.chocolateyPackageId
    ? null
    : storedPackagesLoading
      ? "Checking stored package archives…"
      : packageDownloadStatus && packageDownloadStatus.appId !== detailsGame.appId
        ? `Another download is in progress: ${packageDownloadStatus.title}.`
        : null;
  const packageDownloadEnabled = Boolean(
    detailsGame?.chocolateyPackageId &&
    !storedPackagesLoading &&
    (!packageDownloadStatus || packageDownloadStatus.appId === detailsGame.appId),
  );

  useEffect(() => {
    setArchiveInspection(null);
    setInspectingArchive(false);
    setInstallerArguments("");
  }, [detailsGame?.appId, detailsInstallerArchive?.name]);

  const handleChocolateySearch = useCallback(async (
    term: string,
    pageUrl: string | null = null,
    append = false,
  ): Promise<void> => {
    const normalizedTerm = term.trim();
    searchController.current?.abort();
    searchController.current = null;
    setSearchBusy(false);
    if (normalizedTerm.length < 2) {
      setSearchError("Enter at least two characters to search the live Chocolatey repository.");
      setChocolateyPackages([]);
      setSearchNextUrl(null);
      setSearchedTerm("");
      return;
    }
    const controller = new AbortController();
    searchController.current = controller;
    setSearchBusy(true);
    setSearchError(null);
    if (!append) {
      setChocolateyPackages([]);
      setSearchNextUrl(null);
      setSearchTotal(null);
      setSearchedTerm(normalizedTerm);
    }
    appendLog("info", `${append ? "loading more" : "searching"} Chocolatey for “${normalizedTerm}”`);
    try {
      const page = await searchChocolateyPackages(normalizedTerm, controller.signal, pageUrl);
      if (controller.signal.aborted) return;
      setChocolateyPackages((previous) => {
        if (!append) return page.packages;
        const byId = new Map(previous.map((item) => [item.packageId.toLowerCase(), item]));
        for (const item of page.packages) byId.set(item.packageId.toLowerCase(), item);
        return [...byId.values()];
      });
      setSearchNextUrl(page.nextUrl);
      setSearchTotal(page.totalHits);
      appendLog("info", `Chocolatey search returned ${page.packages.length} packages${page.nextUrl ? " · more results available" : ""}`);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = errorMessage(error);
      setSearchError(message);
      appendLog("error", `Chocolatey search failed: ${message}`);
    } finally {
      if (searchController.current === controller) {
        searchController.current = null;
        setSearchBusy(false);
      }
    }
  }, [appendLog]);

  const handleSearchSubmit = useCallback((event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSection("chocolatey");
    setDetailsGame(null);
    void handleChocolateySearch(query);
  }, [handleChocolateySearch, query]);

  const handleAddToLibrary = useCallback(async (game: StoreGame): Promise<void> => {
    if (!games.some((candidate) => candidate.appId === game.appId)) {
      toast({ title: "Search result only", message: "Live Chocolatey results can be downloaded, but are not added to the curated browser library.", tone: "info" });
      return;
    }
    try {
      await gameStore.addToLibrary(game.appId);
      appendLog("info", `saved listing ${game.appId} to this browser's library`);
      toast({
        title: "Listing saved",
        message: `${game.title} is bookmarked in this browser profile. This does not install the app.`,
        tone: "success",
      });
    } catch (error) {
      const message = errorMessage(error);
      appendLog("error", `library update failed: ${message}`);
      await reportError({
        title: "Could not save listing",
        body: `The catalog record for ${game.title} could not be saved.`,
        details: message,
      });
    }
  }, [appendLog, gameStore, games]);

  const handleRemoveFromLibrary = useCallback(async (game: StoreGame): Promise<void> => {
    const confirmed = await confirmAction({
      title: `Remove ${game.title} from the library?`,
      body: "This only removes the browser-local catalog bookmark. It does not uninstall or delete saved package archives.",
      confirmLabel: "Remove listing",
      cancelLabel: "Keep",
      danger: true,
    });
    if (!confirmed) return;
    await gameStore.removeFromLibrary(game.appId);
    appendLog("info", `removed ${game.appId} from the browser library`);
    toast({ title: "Listing removed", tone: "info", message: "No guest files or package archives were changed." });
  }, [appendLog, gameStore]);

  const handleDownloadPackage = useCallback(async (game: StoreGame): Promise<void> => {
    const packageId = game.chocolateyPackageId;
    const version = game.chocolatey?.version || null;
    if (!packageId) {
      toast({ title: "No Chocolatey package", message: "This entry does not have a Chocolatey package ID.", tone: "warning" });
      return;
    }
    const displayVersion = version ?? "latest";
    if (packageDownloadController.current) return;

    const controller = new AbortController();
    packageDownloadController.current = controller;
    setPackageDownloadStatus({ appId: game.appId, title: game.title, phase: "downloading", receivedBytes: 0, totalBytes: null });
    appendLog("info", `starting ${packageId}@${displayVersion} .nupkg download from Chocolatey`);
    try {
      const onProgress = (progress: ChocolateyPackageDownloadProgress): void => {
        setPackageDownloadStatus({
          appId: game.appId,
          title: game.title,
          phase: "downloading",
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes,
        });
      };
      const { file, url } = await downloadChocolateyPackage(packageId, version, controller.signal, onProgress);
      if (controller.signal.aborted) throw new DOMException("Package download cancelled.", "AbortError");
      setPackageDownloadStatus({ appId: game.appId, title: game.title, phase: "saving", receivedBytes: file.size, totalBytes: file.size });
      appendLog("info", `${file.name} downloaded (${formatBytes(file.size)}); saving to Porthole package storage`);
      const archive = await storage.storePackageArchive(file);
      const refreshedArchives = await refreshStoredPackages();
      if (!refreshedArchives) {
        setStoredPackages((previous) => [archive, ...previous.filter((item) => item.name !== archive.name)]);
      }
      const storageKind = storage.selected();
      appendLog("info", `saved ${file.name} to ${archive.path} · source ${url}`);
      toast({
        title: "Package archive saved",
        message: `${file.name} (${formatBytes(file.size)}) → ${storageLabel ? `${storageLabel}/` : ""}${archive.path}${storageKind === "memory" ? " (temporary; lost when the tab closes)" : ""}. Not installed.`,
        tone: "success",
        duration: 7000,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        appendLog("info", `cancelled package download ${packageId}@${displayVersion}`);
        toast({ title: "Package download cancelled", tone: "info" });
      } else {
        const message = errorMessage(error);
        appendLog("error", `package download failed for ${packageId}@${displayVersion}: ${message}`);
        await reportError({
          title: "Package download failed",
          body: "The Chocolatey archive was not saved. The repository must allow browser access, the package must fit the Store limit, and the selected Porthole storage must be writable.",
          details: message,
        });
      }
    } finally {
      if (packageDownloadController.current === controller) {
        packageDownloadController.current = null;
        setPackageDownloadStatus(null);
      }
    }
  }, [appendLog, refreshStoredPackages, storage, storageLabel]);

  const handleCancelPackageDownload = useCallback((): void => {
    packageDownloadController.current?.abort();
  }, []);

  const handleInspectSavedArchive = useCallback(async (): Promise<void> => {
    const archiveName = detailsInstallerArchive?.name;
    if (!archiveName) {
      toast({ title: "No saved archive", message: "Download the Chocolatey .nupkg before inspecting it.", tone: "warning" });
      return;
    }
    setInspectingArchive(true);
    appendLog("info", `inspecting ${archiveName} for directly embedded PE32+ x64 executables`);
    try {
      const archive = await storage.readStoredPackageArchive(archiveName);
      if (!archive) throw new Error(`Saved package archive was not found: ${archiveName}`);
      const inspection = await inspectChocolateyArchive(archive);
      setArchiveInspection({ ...inspection, archiveName, error: null });
      appendLog("info", `${archiveName}: ${inspection.executables.length} embedded x64 executable(s), ${inspection.unsupportedExecutables.length} unsupported executable(s), ${inspection.skippedScripts} script/command file(s) excluded`);
      toast({
        title: inspection.executables.length > 0 ? "Embedded executable found" : "No supported installer executable found",
        message: inspection.executables.length > 0
          ? "Only directly embedded PE32+ x64 files can be explicitly launched in the Wasm guest. Package scripts and URLs are not run."
          : "This package may be a Chocolatey script wrapper or use an unsupported installer format.",
        tone: inspection.executables.length > 0 ? "success" : "warning",
      });
    } catch (error) {
      const message = errorMessage(error);
      setArchiveInspection({ archiveName, executables: [], unsupportedExecutables: [], skippedScripts: 0, error: message });
      appendLog("error", `package inspection failed for ${archiveName}: ${message}`);
    } finally {
      setInspectingArchive(false);
    }
  }, [appendLog, detailsInstallerArchive, storage]);

  const handleRunEmbeddedInstaller = useCallback(async (
    executable: EmbeddedGuestExecutable,
    argumentsLine: string,
  ): Promise<void> => {
    if (!detailsGame || !detailsInstallerArchive) return;
    if (installerRunDisabledReason) {
      toast({ title: "Emulator not ready", message: installerRunDisabledReason, tone: "warning" });
      openApp("emulator");
      return;
    }
    const accepted = await confirmAction({
      title: `Run ${executable.name} inside Porthole?`,
      body: `This untrusted PE32+ x64 executable will run only inside Porthole's Wasm guest, never as a host process. Porthole copies the executable and same-folder non-script payloads to guest storage. Chocolatey PowerShell/batch scripts, MSI files, and package URLs are not executed or followed. Guest filesystem writes are saved on the selected backend when the process exits. Keyboard and mouse-button input are not delivered yet; supply installer-specific arguments if needed. Launching does not verify that the app installed successfully.`,
      confirmLabel: "Run in Emulator",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!accepted) return;
    if (!runtime.supportsGuestFilePersistence()) {
      toast({ title: "Updated guest storage runtime required", message: "Wait for CI to publish the ABI-v3 guest filesystem exports before running installers.", tone: "warning" });
      return;
    }
    if (!["idle", "exited", "faulted"].includes(runtime.getState())) {
      toast({ title: "Stop the current guest first", message: "Porthole will not replace an active workload without an explicit stop.", tone: "warning" });
      return;
    }

    setInstallerLaunchBusy(true);
    try {
      if (!runtime.importFiles) throw new Error("The active runtime does not support guest file import.");
      const files = executable.payload.map((payload) => payloadFileForGuest(payload, detailsInstallerArchive.name));
      const importedPaths = await runtime.importFiles(files);
      const executableIndex = executable.payload.findIndex((payload) => payload.path === executable.archivePath);
      const guestPath = executableIndex >= 0 ? importedPaths[executableIndex] : undefined;
      if (!guestPath) throw new Error("The embedded executable was not copied into the guest C: filesystem.");

      const emulatorStore = useEmulatorStore.getState();
      emulatorStore.setSelectedProfileId(null);
      emulatorStore.setSelectedGuestExecutable(guestPath);
      emulatorStore.setError(null);
      openApp("emulator");
      const handle = await runtime.loadExecutable(guestPath, argumentsLine);
      emulatorStore.setProcessHandle(handle);
      await runtime.launch(handle);
      appendLog("info", `started ${executable.archivePath} inside the Wasm guest as ${guestPath}${argumentsLine.trim() ? ` ${argumentsLine.trim()}` : ""}`);
      toast({
        title: "Installer started in Emulator",
        message: "It is running inside the Porthole guest. Process launch is not proof of successful installation; inspect guest status and logs.",
        tone: "success",
        duration: 7000,
      });
    } catch (error) {
      const message = errorMessage(error);
      useEmulatorStore.getState().setProcessHandle(null);
      useEmulatorStore.getState().setError(message);
      appendLog("error", `guest installer launch failed for ${executable.archivePath}: ${message}`);
      await reportError({
        title: "Could not run embedded executable",
        body: "The executable was not confirmed as a successful installation. It must be a compatible x64 PE and use APIs supported by the current guest runtime.",
        details: message,
      });
    } finally {
      setInstallerLaunchBusy(false);
    }
  }, [appendLog, detailsGame, detailsInstallerArchive, installerRunDisabledReason, openApp, runtime]);

  const handleOpenEmulator = useCallback((game: StoreGame): void => {
    useEmulatorStore.getState().setSelectedGuestExecutable(null);
    const profileId = game.appId === "freedoom"
      ? "chocolate-doom"
      : /\.exe$/i.test(game.exePath)
        ? game.appId
        : null;
    if (profileId) useEmulatorStore.getState().setSelectedProfileId(profileId);
    appendLog("info", `open ${profileId ?? "default"} guest profile; import local files before launch`);
    openApp("emulator");
  }, [appendLog, openApp]);

  const handleClearLogs = useCallback((): void => {
    useEmulatorStore.getState().clearLogs();
    setLocalLogs([]);
    appendLog("info", "console cleared (store view)");
  }, [appendLog]);

  const toggleLogs = useCallback((): void => {
    useEmulatorStore.getState().toggleLogs();
  }, []);

  const logs = useMemo<RuntimeLogEntry[]>(
    () => [...runtimeLogs, ...localLogs].sort((a, b) => a.ts - b.ts),
    [localLogs, runtimeLogs],
  );

  const openDetails = (game: StoreGame): void => setDetailsGame(game);
  const downloadInProgressId = packageDownloadStatus?.appId ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#15151d]">
      <header className="flex flex-none flex-wrap items-center gap-3 border-b border-white/[0.07] bg-[#1a1a23] px-4 py-3 sm:px-5">
        <AppIcon icon={Store} tint="#8bd5ca" size={34} iconSize={17} />
        <div className="min-w-[130px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[14px] font-semibold tracking-[-0.01em] text-ink">App Store</h1>
            <Badge tone="neutral">{inLibraryCount} saved listings</Badge>
            <Badge tone={metadataResult?.error ? "warning" : metadataResult ? "success" : "neutral"} title={metadataResult?.error ?? "Curated Chocolatey metadata status"}>
              {metadataBusy ? "Refreshing…" : metadataResult?.error && metadataResult.updated === 0 ? "Metadata unavailable" : `${metadataResult?.updated ?? 0} curated updates`}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-[10px] text-ink-faint">Discover Windows packages and Porthole profiles</p>
        </div>

        <form className="flex min-w-[220px] flex-[1.2] items-center gap-2 sm:max-w-[430px]" onSubmit={handleSearchSubmit} role="search">
          <div className="relative min-w-0 flex-1">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search apps and Chocolatey…"
              aria-label="Search apps and Chocolatey packages"
              className="h-9 w-full rounded-full border border-white/[0.09] bg-black/25 pl-9 pr-9 text-[11.5px] text-ink placeholder:text-ink-ghost focus:border-accent/45 focus:outline-none focus:ring-1 focus:ring-accent/20"
            />
            {query && (
              <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-ink-faint hover:bg-white/[0.08] hover:text-ink">
                <X size={11} aria-hidden />
              </button>
            )}
          </div>
          <Button size="sm" variant="primary" type="submit" icon={Search} loading={searchBusy}>
            Search
          </Button>
        </form>

        <div className="ml-auto flex flex-none items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={metadataBusy} aria-label="Refresh curated metadata" title={metadataResult?.error ?? "Refresh curated package metadata"} onClick={() => { void refreshMetadata(); }} />
          <Button size="sm" variant="ghost" icon={ScrollText} aria-pressed={logsOpen} onClick={toggleLogs} title="Toggle runtime console" className={logsOpen ? "bg-white/[0.06] text-ink" : undefined} />
        </div>
      </header>

      <nav className="flex flex-none items-center gap-1 border-b border-white/[0.06] bg-[#181820] px-4 py-2 sm:px-5" aria-label="Store sections">
        {SECTIONS.map((item) => {
          const Icon = item.icon;
          const active = section === item.id && !detailsGame;
          const count = item.id === "explore" ? games.length : item.id === "downloads" ? storedPackages.length : undefined;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              onClick={() => { setDetailsGame(null); setSection(item.id); }}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-full px-3 text-[11px] font-medium transition",
                active ? "bg-white/[0.1] text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]" : "text-ink-muted hover:bg-white/[0.05] hover:text-ink",
              )}
            >
              <Icon size={13} className={active ? "text-accent" : "text-ink-faint"} aria-hidden />
              {item.label}
              {count !== undefined && <span className="font-mono text-[9px] text-ink-ghost">{count}</span>}
            </button>
          );
        })}
        <div className="ml-auto hidden min-w-0 items-center gap-1.5 text-[9.5px] text-ink-ghost sm:flex" title={storage.describeSelected().detail}>
          <HardDrive size={11} className="flex-none text-accent/70" aria-hidden />
          <span className="max-w-[160px] truncate">{storageLabel || "Porthole storage"}</span>
          <span>·</span>
          <span>{storedPackages.length} packages saved</span>
        </div>
      </nav>

      {detailsGame ? (
        <div className="min-h-0 flex-1">
          <GameDetails
            game={detailsGame}
            logsOpen={logsOpen}
            storageLabel={storageLabel}
            currentPackagePath={detailsCurrentPackagePath}
            downloadedPackagePaths={detailsDownloadedPackagePaths}
            packageDownloadEnabled={packageDownloadEnabled}
            packageDownloadDisabledReason={packageDownloadDisabledReason}
            packageDownloadStatus={packageDownloadStatus}
            installerArchiveName={detailsInstallerArchive?.name ?? null}
            installerInspected={currentArchiveInspection !== null}
            installerExecutables={currentArchiveInspection?.executables ?? []}
            unsupportedExecutables={currentArchiveInspection?.unsupportedExecutables ?? []}
            installerInspectionError={currentArchiveInspection?.error ?? null}
            skippedInstallerScripts={currentArchiveInspection?.skippedScripts ?? 0}
            inspectingArchive={inspectingArchive}
            installerRunDisabledReason={installerRunDisabledReason}
            installerRunBusy={installerLaunchBusy}
            installerArguments={installerArguments}
            canAddToLibrary={detailsIsCatalogEntry}
            onBack={() => setDetailsGame(null)}
            onAdd={() => { void handleAddToLibrary(detailsGame); }}
            onDownloadPackage={() => { void handleDownloadPackage(detailsGame); }}
            onCancelDownload={handleCancelPackageDownload}
            onInspectSavedArchive={() => { void handleInspectSavedArchive(); }}
            onInstallerArgumentsChange={setInstallerArguments}
            onRunEmbeddedInstaller={(executable, argumentsLine) => { void handleRunEmbeddedInstaller(executable, argumentsLine); }}
            onLaunch={() => handleOpenEmulator(detailsGame)}
            onRemove={() => { void handleRemoveFromLibrary(detailsGame); }}
            onToggleLogs={toggleLogs}
          />
        </div>
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto" aria-label="Store content">
          {section === "explore" && (
            <div className="mx-auto max-w-[1450px] p-4 sm:p-5">
              <section className="relative overflow-hidden rounded-[18px] border border-white/[0.08] bg-[#22232d] p-5 sm:p-7">
                <div className="absolute inset-0 opacity-75" style={{ backgroundImage: "radial-gradient(ellipse at 5% 0%, rgba(139,213,202,0.24), transparent 40%), radial-gradient(ellipse at 85% 105%, rgba(203,166,247,0.2), transparent 44%), linear-gradient(130deg, #22242c, #181820 72%)" }} aria-hidden />
                <div className="absolute -right-10 -top-16 h-64 w-64 rounded-full border border-white/[0.05] bg-white/[0.025]" aria-hidden />
                <div className="absolute right-10 top-8 hidden h-40 w-40 rounded-full border border-white/[0.06] sm:block" aria-hidden />
                <div className="relative grid items-center gap-6 md:grid-cols-[minmax(0,1fr)_minmax(230px,330px)]">
                  <div className="max-w-2xl">
                    <Badge tone="accent" dot>Discover</Badge>
                    <h2 className="mt-3 text-[25px] font-semibold leading-tight tracking-[-0.03em] text-ink sm:text-[32px]">Find your next app</h2>
                    <p className="mt-2 max-w-xl text-[11px] leading-relaxed text-ink-muted sm:text-[12px]">
                      Browse curated Porthole profiles or search the live Chocolatey Community Repository. Saved archives are not installations; directly embedded x64 EXEs can be explicitly run inside the Wasm guest, while package scripts and MSI installers remain unsupported.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button variant="primary" size="sm" icon={Boxes} onClick={() => setSection("chocolatey")}>Browse Chocolatey</Button>
                      {featuredGame?.chocolateyPackageId && (
                        <Button variant="secondary" size="sm" icon={Download} loading={downloadInProgressId === featuredGame.appId} disabled={Boolean(downloadInProgressId && downloadInProgressId !== featuredGame.appId)} onClick={() => { void handleDownloadPackage(featuredGame); }}>
                          Get 7-Zip package
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="relative hidden min-h-[150px] items-center justify-center md:flex">
                    {featuredGame && (() => {
                      const cover = coverStyle(featuredGame.appId);
                      return (
                        <button type="button" onClick={() => openDetails(featuredGame)} className="group relative flex w-full max-w-[290px] items-center gap-4 rounded-[14px] border border-white/[0.1] bg-black/25 p-4 text-left backdrop-blur-sm transition hover:-translate-y-1 hover:bg-black/35">
                          <div className="grid h-[70px] w-[70px] flex-none place-items-center rounded-[15px] border border-white/[0.12] bg-black/20" style={{ backgroundImage: cover.gradient }}>
                            <AppIcon icon={cover.icon} tint={cover.tint} size={55} iconSize={29} />
                          </div>
                          <span className="min-w-0">
                            <span className="block text-[9px] font-semibold uppercase tracking-[0.14em] text-accent">Popular package</span>
                            <span className="mt-1 block truncate text-[14px] font-semibold text-ink">{featuredGame.chocolatey?.title || featuredGame.title}</span>
                            <span className="mt-1 block truncate text-[10px] text-ink-faint">{featuredGame.chocolatey?.version || featuredGame.version} · Chocolatey</span>
                          </span>
                        </button>
                      );
                    })()}
                  </div>
                </div>
              </section>

              <section className="mt-5" aria-label="Browse app categories">
                <div className="mb-2 flex items-end justify-between gap-2">
                  <div>
                    <h3 className="text-[13px] font-semibold text-ink">Browse by category</h3>
                    <p className="mt-0.5 text-[9.5px] text-ink-faint">Curated profiles and package listings</p>
                  </div>
                  <span className="text-[9px] text-ink-ghost">{games.length} curated entries</span>
                </div>
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {FILTERS.map((item) => {
                    const Icon = item.icon;
                    const active = filter === item.id;
                    const count = item.id === "all" ? games.length : games.filter((game) => game.category === item.id).length;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setFilter(item.id)}
                        className={cn("inline-flex h-8 flex-none items-center gap-1.5 rounded-full border px-3 text-[10px] transition", active ? "border-accent/30 bg-accent/[0.1] text-ink" : "border-white/[0.07] bg-white/[0.025] text-ink-muted hover:bg-white/[0.06] hover:text-ink")}
                      >
                        <Icon size={11} className={active ? "text-accent" : "text-ink-faint"} aria-hidden />
                        {item.label}<span className="font-mono text-[9px] text-ink-ghost">{count}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="mt-5" aria-label="Recommended applications">
                <div className="mb-3 flex items-end justify-between gap-3">
                  <div>
                    <h3 className="text-[14px] font-semibold text-ink">Recommended for you</h3>
                    <p className="mt-0.5 text-[10px] text-ink-faint">One click downloads a package archive when a Chocolatey source is available.</p>
                  </div>
                  <Button size="xs" variant="ghost" icon={Boxes} onClick={() => setSection("chocolatey")}>Search all packages</Button>
                </div>
                {games.length === 0 ? (
                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">
                    {[0, 1, 2, 3, 4, 5].map((index) => <Skeleton key={index} className="h-[128px] rounded-[12px]" />)}
                  </div>
                ) : curatedFiltered.length === 0 ? (
                  <EmptyState icon={FileQuestion} title="No matching apps" body={`Nothing in this category matches “${query}”.`} action={<Button size="sm" onClick={() => { setFilter("all"); setQuery(""); }}>Show all apps</Button>} />
                ) : (
                  <GameGrid
                    games={curatedFiltered}
                    downloadedPackageIds={downloadedPackageIds}
                    downloadingAppId={downloadInProgressId}
                    onSelect={openDetails}
                    onDownload={(game) => { void handleDownloadPackage(game); }}
                  />
                )}
              </section>
              <p className="mt-5 flex items-start gap-2 border-t border-white/[0.06] pt-3 text-[9.5px] leading-relaxed text-ink-ghost">
                <ShieldCheck size={12} className="mt-0.5 flex-none text-accent/70" aria-hidden />
                Chocolatey search exposes the live public package index. A `.nupkg` download is only an archive. Only a directly embedded PE32+ x64 EXE may be explicitly launched inside the Wasm guest; package scripts, MSI installers, external URLs, and universal Windows-app compatibility are not supported.
              </p>
            </div>
          )}

          {section === "chocolatey" && (
            <div className="mx-auto max-w-[1450px] p-4 sm:p-5">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Boxes size={17} className="text-accent" aria-hidden />
                    <h2 className="text-[16px] font-semibold text-ink">Chocolatey Community Repository</h2>
                  </div>
                  <p className="mt-1 max-w-2xl text-[10.5px] leading-relaxed text-ink-faint">
                    Search the live community feed, not just Porthole’s curated list. Results are package metadata; Get saves a .nupkg archive. Inspect saved archives to find direct x64 EXEs that can be explicitly run inside the guest.
                  </p>
                </div>
                <Badge tone="neutral">{searchTotal === null ? "Live search" : `${searchTotal.toLocaleString()} matches`}</Badge>
              </div>
              {searchError && (
                <div role="alert" className="mb-4 flex items-start gap-2 rounded-[10px] border border-warning/20 bg-warning/[0.06] p-3 text-[10px] text-ink-muted">
                  <ShieldCheck size={13} className="mt-0.5 flex-none text-warning" aria-hidden />
                  <span>{searchError}</span>
                </div>
              )}
              {searchedTerm && !searchError && (
                <p className="mb-3 text-[10px] text-ink-faint">
                  {searchBusy ? "Searching…" : `${chocolateyPackages.length} results for “${searchedTerm}”${searchTotal !== null ? ` of ${searchTotal.toLocaleString()}` : ""}`}
                </p>
              )}
              {searchBusy && chocolateyPackages.length === 0 ? (
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">
                  {[0, 1, 2, 3, 4, 5].map((index) => <Skeleton key={index} className="h-[128px] rounded-[12px]" />)}
                </div>
              ) : remoteGames.length > 0 ? (
                <>
                  <GameGrid
                    games={remoteGames}
                    downloadedPackageIds={downloadedPackageIds}
                    downloadingAppId={downloadInProgressId}
                    onSelect={openDetails}
                    onDownload={(game) => { void handleDownloadPackage(game); }}
                  />
                  {searchNextUrl && (
                    <div className="mt-4 flex justify-center">
                      <Button size="sm" variant="secondary" loading={searchBusy} onClick={() => { void handleChocolateySearch(searchedTerm, searchNextUrl, true); }}>Load more packages</Button>
                    </div>
                  )}
                </>
              ) : (
                <EmptyState
                  icon={searchBusy ? Search : Package}
                  title={searchedTerm ? "No packages shown yet" : "Search the Chocolatey catalog"}
                  body={searchedTerm ? "If the repository allows browser access, results will appear here. Search errors are shown above." : "Enter an app name in the search box above and press Search to query the live Chocolatey feed."}
                  className="mt-8"
                />
              )}
              <p className="mt-5 border-t border-white/[0.06] pt-3 text-[9.5px] leading-relaxed text-ink-ghost">
                Search uses Chocolatey’s public OData feed and follows its result pages. Some packages may be unavailable, oversized, blocked by browser CORS, or depend on external installers that Porthole does not execute.
              </p>
            </div>
          )}

          {section === "downloads" && (
            <div className="mx-auto max-w-[1100px] p-4 sm:p-5">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2"><Archive size={17} className="text-accent" aria-hidden /><h2 className="text-[16px] font-semibold text-ink">Downloaded packages</h2></div>
                  <p className="mt-1 text-[10.5px] text-ink-faint">Saved under PortholePackages/ in {storageLabel || "selected storage"}. These archives are not installed.</p>
                </div>
                <Button size="sm" variant="secondary" icon={RefreshCw} loading={storedPackagesLoading} onClick={() => { void refreshStoredPackages(); }}>Refresh</Button>
              </div>
              {storedPackages.length === 0 ? (
                <EmptyState icon={Download} title={storedPackagesLoading ? "Checking storage…" : "No package archives yet"} body="Use Get on a Chocolatey package to download its .nupkg into your selected Porthole storage." action={<Button size="sm" variant="primary" icon={Boxes} onClick={() => setSection("chocolatey")}>Browse Chocolatey</Button>} />
              ) : (
                <div className="overflow-hidden rounded-[12px] border border-white/[0.07] bg-white/[0.02]">
                  {storedPackages.map((archive, index) => (
                    <div key={`${archive.name}-${archive.lastModified}`} className={cn("flex flex-wrap items-center gap-3 px-3 py-3 sm:px-4", index > 0 && "border-t border-white/[0.06]")}>
                      <span className="grid h-9 w-9 flex-none place-items-center rounded-[9px] border border-white/[0.08] bg-black/20 text-accent"><Package size={16} aria-hidden /></span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11px] font-medium text-ink" title={archive.name}>{packageLabel(archive)}</p>
                        <p className="mt-0.5 truncate font-mono text-[9px] text-ink-ghost" title={`${storageLabel}/${archive.path}`}>{storageLabel}/{archive.path}</p>
                      </div>
                      <span className="text-[9.5px] text-ink-faint">{formatBytes(archive.sizeBytes)}</span>
                      <span className="hidden text-[9px] text-ink-ghost sm:inline">{new Date(archive.lastModified).toLocaleDateString()}</span>
                      {gameFromStoredArchive(archive) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={Play}
                          onClick={() => {
                            const archivedGame = gameFromStoredArchive(archive);
                            if (archivedGame) setDetailsGame(archivedGame);
                          }}
                        >
                          Inspect / run
                        </Button>
                      )}
                      <Badge tone="neutral">Archive</Badge>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-4 flex items-start gap-2 rounded-[9px] border border-warning/15 bg-warning/[0.04] p-3 text-[9.5px] leading-relaxed text-ink-faint">
                <ShieldCheck size={12} className="mt-0.5 flex-none text-warning" aria-hidden />
                Porthole never runs Chocolatey PowerShell/batch scripts, MSI packages, or package-provided URLs. After inspection and explicit confirmation, only a directly embedded x64 EXE can run inside the Wasm guest—not on the host. A launched installer may still fail or make no usable app.
              </p>
            </div>
          )}
        </main>
      )}

      <LogConsole entries={logs} open={logsOpen} onToggle={toggleLogs} onClear={handleClearLogs} title="Runtime console" height={168} />
    </div>
  );
}
