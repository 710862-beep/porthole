import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BriefcaseBusiness,
  Code2,
  Cpu,
  FileQuestion,
  Film,
  Gamepad2,
  Globe2,
  MessagesSquare,
  Palette,
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
  type ChocolateyPackageDownloadProgress,
} from "@runtime/chocolateyMetadata";
import { useRuntime } from "@/hooks/useRuntime";
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
  { id: "all", label: "All", icon: Store },
  ...(
    ["games", "utilities", "system", "development", "browsers", "media", "creativity", "productivity", "communications"] as const
  ).map((id) => ({ id, ...CATEGORY_LABELS[id] })),
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      game.chocolatey?.version ?? "latest",
    ).toLowerCase();
    return archives.find((archive) => archive.name.toLowerCase() === expectedName)?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * App Store window: Chocolatey metadata and package downloads into
 * the selected Porthole storage backend. Archives are not extracted and package scripts/installers
 * are never run by the Store; the browser-local library remains separate.
 */
export function GameStoreApp() {
  const { store: gameStore, storage } = useRuntime();
  const { openApp } = useWindowManager();
  const games = useLibraryStore((state) => state.games);
  const runtimeLogs = useEmulatorStore((state) => state.logs);
  const logsOpen = useEmulatorStore((state) => state.logsOpen);
  const mountedStorageLabel = useEmulatorStore((state) => state.storage?.label ?? "");
  const storageBackend = useEmulatorStore((state) => state.storage?.backend ?? storage.selected());
  const storageLabel = mountedStorageLabel || storage.describeSelected().label;

  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("7zip");
  const [localLogs, setLocalLogs] = useState<RuntimeLogEntry[]>([]);
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [metadataResult, setMetadataResult] = useState<ChocolateyRefreshResult | null>(null);
  const [storedPackages, setStoredPackages] = useState<StoredPackageArchive[]>([]);
  const [storedPackagesLoading, setStoredPackagesLoading] = useState(false);
  const [packageDownloadStatus, setPackageDownloadStatus] = useState<PackageDownloadStatus | null>(null);

  const logSequence = useRef(-1);
  const seeded = useRef(false);
  const metadataStarted = useRef(false);
  const packageDownloadController = useRef<AbortController | null>(null);

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
  }, []);

  const refreshMetadata = useCallback(async (): Promise<void> => {
    if (metadataBusy) return;
    setMetadataBusy(true);
    appendLog("info", "Refreshing Chocolatey package metadata; package bytes are fetched only after an explicit download action");
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
  }, [appendLog, gameStore, games.length, metadataBusy]);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    appendLog("info", "App Store ready · package archives can be saved into selected Porthole storage");
    appendLog("info", "Only explicit .nupkg downloads fetch package bytes; package scripts and installers are not run");
  }, [appendLog]);

  useEffect(() => {
    if (metadataStarted.current) return;
    metadataStarted.current = true;
    void refreshMetadata();
  }, [refreshMetadata]);

  useEffect(() => {
    if (games.length > 0 && !games.some((game) => game.appId === selectedId)) {
      setSelectedId(games[0]?.appId ?? "");
    }
  }, [games, selectedId]);

  const filtered = useMemo(() => {
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

  const selected = useMemo<StoreGame | null>(() => {
    if (games.length === 0) return null;
    return games.find((game) => game.appId === selectedId) ?? games[0] ?? null;
  }, [games, selectedId]);

  const logs = useMemo<RuntimeLogEntry[]>(
    () => [...runtimeLogs, ...localLogs].sort((a, b) => a.ts - b.ts),
    [localLogs, runtimeLogs],
  );

  const inLibraryCount = games.filter((game) => game.status === "in-library").length;
  const selectedDownloadedPackagePaths = selected
    ? packageArchivesFor(selected, storedPackages).map((archive) => `${storageLabel}/${archive.path}`)
    : [];
  const selectedCurrentPackagePath = selected ? currentPackagePath(selected, storedPackages) : null;
  const downloadedPackageIds = useMemo(
    () => new Set(games.filter((game) => packageArchivesFor(game, storedPackages).length > 0).map((game) => game.appId)),
    [games, storedPackages],
  );
  const packageDownloadDisabledReason = !selected?.chocolateyPackageId
    ? null
    : storedPackagesLoading
      ? "Checking stored package archives…"
      : packageDownloadStatus && packageDownloadStatus.appId !== selected.appId
        ? `Another download is in progress: ${packageDownloadStatus.title}.`
        : null;
  const packageDownloadEnabled = Boolean(
    selected?.chocolateyPackageId &&
    !storedPackagesLoading &&
    (!packageDownloadStatus || packageDownloadStatus.appId === selected.appId),
  );

  const handleAddToLibrary = useCallback(
    async (game: StoreGame): Promise<void> => {
      try {
        await gameStore.addToLibrary(game.appId);
        appendLog("info", `added ${game.appId} to this browser's library`);
        toast({
          title: "Added to library",
          message: `${game.title} is saved to this browser profile. Download its Chocolatey package separately if available.`,
          tone: "success",
        });
      } catch (error) {
        const message = errorMessage(error);
        appendLog("error", `library update failed: ${message}`);
        await reportError({
          title: "Could not update library",
          body: `The catalog record for ${game.title} could not be saved.`,
          details: message,
        });
      }
    },
    [appendLog, gameStore],
  );

  const handleRemoveFromLibrary = useCallback(
    async (game: StoreGame): Promise<void> => {
      const confirmed = await confirmAction({
        title: `Remove ${game.title} from the library?`,
        body: "This only removes the browser-local catalog bookmark. It does not uninstall or delete guest files.",
        confirmLabel: "Remove entry",
        cancelLabel: "Keep",
        danger: true,
      });
      if (!confirmed) return;
      await gameStore.removeFromLibrary(game.appId);
      appendLog("info", `removed ${game.appId} from the browser library`);
      toast({
        title: "Library entry removed",
        tone: "info",
        message: "No guest files or Chocolatey packages were changed.",
      });
    },
    [appendLog, gameStore],
  );

  const handleDownloadPackage = useCallback(
    async (game: StoreGame): Promise<void> => {
      const packageId = game.chocolateyPackageId;
      const version = game.chocolatey?.version ?? null;
      if (!packageId) {
        toast({
          title: "No Chocolatey package",
          message: "This catalog entry does not have a Chocolatey package ID.",
          tone: "warning",
        });
        return;
      }
      const displayVersion = version ?? "latest";
      if (packageDownloadController.current) return;

      const controller = new AbortController();
      packageDownloadController.current = controller;
      setPackageDownloadStatus({
        appId: game.appId,
        title: game.title,
        phase: "downloading",
        receivedBytes: 0,
        totalBytes: null,
      });
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
        setPackageDownloadStatus({
          appId: game.appId,
          title: game.title,
          phase: "saving",
          receivedBytes: file.size,
          totalBytes: file.size,
        });
        appendLog("info", `${file.name} downloaded (${formatBytes(file.size)}); saving to Porthole package storage`);
        const archive = await storage.storePackageArchive(file);
        const refreshedArchives = await refreshStoredPackages();
        if (!refreshedArchives) {
          setStoredPackages((previous) => [archive, ...previous.filter((item) => item.name !== archive.name)]);
        }
        const storageKind = storage.selected();
        appendLog("info", `saved ${file.name} to ${archive.path} · source ${url}`);
        toast({
          title: "Package saved to Porthole storage",
          message: `${file.name} (${formatBytes(file.size)}) → ${storageLabel ? `${storageLabel}/` : ""}${archive.path}${storageKind === "memory" ? " (temporary; lost when the tab closes)" : ""}`,
          tone: "success",
          duration: 6500,
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
            body: "The Chocolatey archive was not saved to Porthole storage. Check the network/CORS response and selected storage backend, then retry.",
            details: message,
          });
        }
      } finally {
        if (packageDownloadController.current === controller) {
          packageDownloadController.current = null;
          setPackageDownloadStatus(null);
        }
      }
    },
    [appendLog, refreshStoredPackages, storage, storageLabel],
  );

  const handleCancelPackageDownload = useCallback((): void => {
    packageDownloadController.current?.abort();
  }, []);

  const handleOpenEmulator = useCallback(
    (game: StoreGame): void => {
      const profileId = game.appId === "freedoom"
        ? "chocolate-doom"
        : /\.exe$/i.test(game.exePath)
          ? game.appId
          : null;
      if (profileId) useEmulatorStore.getState().setSelectedProfileId(profileId);
      appendLog("info", `open ${profileId ?? "default"} guest profile; import local files before launch`);
      openApp("emulator");
    },
    [appendLog, openApp],
  );

  const handleClearLogs = useCallback((): void => {
    useEmulatorStore.getState().clearLogs();
    setLocalLogs([]);
    appendLog("info", "console cleared (store view)");
  }, [appendLog]);

  const toggleLogs = useCallback((): void => {
    useEmulatorStore.getState().toggleLogs();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#14141f]">
      <header className="flex flex-none items-center gap-3 border-b border-white/[0.07] px-4 py-3">
        <AppIcon icon={Store} tint="#00e5ff" size={30} iconSize={15} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink">App Store</h1>
            <Badge tone="accent" dot>
              {inLibraryCount}/{games.length || "—"} in library
            </Badge>
            <Badge
              tone={metadataResult?.error ? "warning" : metadataResult ? "success" : "neutral"}
              title={metadataResult?.error ?? "Chocolatey package metadata status"}
            >
              {metadataBusy
                ? "fetching metadata…"
                : metadataResult?.error && metadataResult.updated === 0
                  ? "metadata unavailable"
                  : metadataResult
                    ? `${metadataResult.updated} ${metadataResult.fromCache ? "cached" : "live"} records`
                    : "Chocolatey metadata"}
            </Badge>
          </div>
          <p className="truncate text-[10px] text-ink-faint">
            {games.length} categorized apps · download Chocolatey package archives into Porthole storage.
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={RefreshCw}
            loading={metadataBusy}
            aria-label="Refresh Chocolatey metadata"
            title={metadataResult?.error ?? "Refresh package IDs, versions and descriptions; downloads happen only when you choose a package"}
            onClick={() => { void refreshMetadata(); }}
          >
            Metadata
          </Button>
          <div className="relative">
            <Search
              size={12}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
              aria-hidden
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search apps…"
              aria-label="Search apps"
              className="h-8 w-[188px] rounded-control border border-white/[0.08] bg-black/30 pl-8 pr-7 text-[11.5px] text-ink placeholder:text-ink-ghost focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/20"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear library search"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-[4px] text-ink-faint hover:bg-white/[0.07] hover:text-ink"
              >
                <X size={10} aria-hidden />
              </button>
            )}
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon={Cpu}
            onClick={() => openApp("emulator")}
            title="Open the emulator window"
          >
            Emulator
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={ScrollText}
            aria-pressed={logsOpen}
            onClick={toggleLogs}
            title="Toggle the runtime console"
            className={logsOpen ? "bg-white/[0.06] text-ink" : undefined}
          >
            Console
          </Button>
        </div>
      </header>

      <div className="flex flex-none items-center gap-1.5 overflow-x-auto border-b border-white/[0.05] px-3 py-1.5">
        {FILTERS.map((item) => {
          const Icon = item.icon;
          const active = filter === item.id;
          const count =
            item.id === "all"
              ? games.length
              : games.filter((game) => game.category === item.id).length;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(item.id)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[10.5px] font-medium transition-colors",
                active
                  ? "bg-white/[0.08] text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
                  : "text-ink-muted hover:bg-white/[0.04] hover:text-ink",
              )}
            >
              <Icon size={11} aria-hidden className={active ? "text-accent" : "text-ink-faint"} />
              {item.label}
              <span className="font-mono text-[9px] text-ink-ghost">{count}</span>
            </button>
          );
        })}
        <span className="ml-auto flex items-center gap-1.5 pr-1 text-[9.5px] text-ink-ghost">
          <ShieldCheck size={10} aria-hidden className="text-accent/70" />
          Explicit .nupkg downloads · no install scripts run
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <section
          className="min-w-0 flex-1 overflow-y-auto p-4"
          aria-label="Store catalog"
        >
          {games.length === 0 ? (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(178px, 1fr))" }}>
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="aspect-[4/5] w-full rounded-[11px]" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={FileQuestion}
              title="Nothing in this shelf"
              body={`No apps match ${query ? `“${query}”` : "this filter"}.`}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setFilter("all");
                    setQuery("");
                  }}
                >
                  Show all entries
                </Button>
              }
              className="mt-6"
            />
          ) : (
            <GameGrid
              games={filtered}
              selectedId={selected?.appId ?? null}
              downloadedPackageIds={downloadedPackageIds}
              onSelect={setSelectedId}
            />
          )}

          <p className="mt-4 flex items-center gap-1.5 text-[9.5px] leading-relaxed text-ink-ghost">
            <ShieldCheck size={10} aria-hidden />
            Chocolatey metadata is refreshed from its public feed. Explicit downloads save the versioned .nupkg
            archive to selected Porthole storage; package scripts and installers are not executed.
          </p>
        </section>

        {selected ? (
          <GameDetails
            game={selected}
            logsOpen={logsOpen}
            storageLabel={storageLabel}
            currentPackagePath={selectedCurrentPackagePath}
            downloadedPackagePaths={selectedDownloadedPackagePaths}
            packageDownloadEnabled={packageDownloadEnabled}
            packageDownloadDisabledReason={packageDownloadDisabledReason}
            packageDownloadStatus={packageDownloadStatus}
            onAdd={() => { void handleAddToLibrary(selected); }}
            onDownloadPackage={() => { void handleDownloadPackage(selected); }}
            onCancelDownload={handleCancelPackageDownload}
            onLaunch={() => handleOpenEmulator(selected)}
            onRemove={() => { void handleRemoveFromLibrary(selected); }}
            onToggleLogs={toggleLogs}
          />
        ) : (
          <aside className="flex h-full w-[352px] flex-none flex-col gap-3 border-l border-white/[0.07] bg-black/15 p-4">
            <Skeleton className="h-[104px] w-full rounded-[10px]" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="mt-4 h-[120px] w-full rounded-[10px]" />
          </aside>
        )}
      </div>

      <LogConsole
        entries={logs}
        open={logsOpen}
        onToggle={toggleLogs}
        onClear={handleClearLogs}
        title="Runtime console"
        height={168}
      />
    </div>
  );
}
