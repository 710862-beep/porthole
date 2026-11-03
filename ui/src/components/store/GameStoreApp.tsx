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
} from "@runtime/types";
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
import { GameDetails } from "./GameDetails";
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

/**
 * App Store window: curated catalog, Chocolatey metadata detail and runtime console.
 * Library membership is a browser-local bookmark, never an installation.
 */
export function GameStoreApp() {
  const { store: gameStore } = useRuntime();
  const { openApp } = useWindowManager();
  const games = useLibraryStore((state) => state.games);
  const runtimeLogs = useEmulatorStore((state) => state.logs);
  const logsOpen = useEmulatorStore((state) => state.logsOpen);

  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("chocolate-doom");
  const [localLogs, setLocalLogs] = useState<RuntimeLogEntry[]>([]);
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [metadataResult, setMetadataResult] = useState<ChocolateyRefreshResult | null>(null);

  const logSequence = useRef(-1);
  const seeded = useRef(false);
  const metadataStarted = useRef(false);

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

  const refreshMetadata = useCallback(async (): Promise<void> => {
    if (metadataBusy) return;
    setMetadataBusy(true);
    appendLog("info", "Refreshing package metadata from Chocolatey's public OData feed (metadata only)");
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
    appendLog("info", "App Store ready · catalog bookmarks are local to this browser profile");
    appendLog("info", "Chocolatey queries are metadata-only; no package bytes are fetched or executed");
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

  const handleAddToLibrary = useCallback(
    async (game: StoreGame): Promise<void> => {
      try {
        await gameStore.addToLibrary(game.appId);
        appendLog("info", `added ${game.appId} to this browser's library · no package bytes fetched`);
        toast({
          title: "Added to library",
          message: `${game.title} is a catalog bookmark. It is not a downloaded or installed binary.`,
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

  const handleOpenEmulator = useCallback(
    (game: StoreGame): void => {
      appendLog("info", `open guest runtime for ${game.appId}; local files are required`);
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
            {games.length} categorized apps · Chocolatey metadata only, no package downloads.
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={RefreshCw}
            loading={metadataBusy}
            aria-label="Refresh Chocolatey metadata"
            title={metadataResult?.error ?? "Fetch package IDs, versions and descriptions only; no .nupkg or installer downloads"}
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
              placeholder="Search library…"
              aria-label="Search library"
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
          Chocolatey OData fields only · no .nupkg / .exe
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <section
          className="min-w-0 flex-1 overflow-y-auto p-4"
          aria-label="Game library"
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
              body={`No library entries match ${query ? `“${query}”` : "this filter"}.`}
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
              onSelect={setSelectedId}
            />
          )}

          <p className="mt-4 flex items-center gap-1.5 text-[9.5px] leading-relaxed text-ink-ghost">
            <ShieldCheck size={10} aria-hidden />
            Metadata is sourced from Chocolatey's public feed; library membership never
            downloads or executes packages.
          </p>
        </section>

        {selected ? (
          <GameDetails
            game={selected}
            logsOpen={logsOpen}
            onAdd={() => { void handleAddToLibrary(selected); }}
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
