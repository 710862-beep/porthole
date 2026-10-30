import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cpu,
  Download,
  Package,
  Search,
  ShieldCheck,
  Store,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type { InstallPhase, RuntimeLogEntry, RuntimeLogLevel, StoreGame } from "@runtime/types";
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

type LibraryFilter = "all" | "games" | "utilities" | "system";

const FILTERS: Array<{ id: LibraryFilter; label: string; icon: LucideIcon }> = [
  { id: "all", label: "All", icon: Store },
  { id: "games", label: "Games", icon: Package },
  { id: "utilities", label: "Utilities", icon: Wrench },
  { id: "system", label: "System", icon: Cpu },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Game Store window: library grid, detail pane, and the shared runtime console.
 * Installs are library registrations only — the UI says so on every surface.
 */
export function GameStoreApp() {
  const { store: gameStore } = useRuntime();
  const { launchGame, openApp } = useWindowManager();
  const games = useLibraryStore((state) => state.games);
  const progress = useLibraryStore((state) => state.progress);
  const runtimeLogs = useEmulatorStore((state) => state.logs);
  const logsOpen = useEmulatorStore((state) => state.logsOpen);

  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("chocolate-doom");
  const [localLogs, setLocalLogs] = useState<RuntimeLogEntry[]>([]);

  const logSequence = useRef(-1);
  const lastPhase = useRef<Record<string, InstallPhase>>({});
  const seeded = useRef(false);

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

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    appendLog("info", "Game Store ready · library is local to this browser profile");
    appendLog("info", "install = library registration only; no bytes are fetched by the shell");
  }, [appendLog]);

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
        [game.title, game.summary, game.genre, game.version]
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

  const installedCount = games.filter((game) => game.status === "installed").length;

  const handleInstall = useCallback(
    async (game: StoreGame): Promise<void> => {
      appendLog("info", `install ${game.appId} → ${game.exePath || "library entry"}`);
      try {
        await gameStore.installGame(game.appId, (update) => {
          useLibraryStore.getState().setProgress(update);
          const previous = lastPhase.current[game.appId];
          if (previous !== update.phase) {
            lastPhase.current[game.appId] = update.phase;
            appendLog(
              update.phase === "complete" ? "info" : "debug",
              `${update.phase} · ${Math.round(update.percent)}% — ${update.detail}`,
            );
            if (update.phase === "complete") {
              toast({
                title: `${game.title} installed`,
                message: "Library entry registered. No bytes were downloaded.",
                tone: "success",
              });
            }
          }
        });
      } catch (error) {
        const message = errorMessage(error);
        appendLog("error", `install failed: ${message}`);
        await reportError({
          title: "Install failed",
          body: `The library entry for ${game.title} could not be registered.`,
          details: message,
        });
      } finally {
        delete lastPhase.current[game.appId];
        window.setTimeout(() => {
          useLibraryStore.getState().clearProgress(game.appId);
        }, 900);
      }
    },
    [appendLog, gameStore],
  );

  const handleUninstall = useCallback(
    async (game: StoreGame): Promise<void> => {
      const confirmed = await confirmAction({
        title: `Uninstall ${game.title}?`,
        body: "The library entry is removed from this browser profile. Game bytes are not managed by this shell.",
        confirmLabel: "Uninstall",
        cancelLabel: "Keep",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await gameStore.uninstallGame(game.appId);
        appendLog("warn", `uninstalled ${game.appId} — library entry removed`);
        toast({
          title: `${game.title} uninstalled`,
          tone: "info",
          message: "The entry can be added again at any time.",
        });
      } catch (error) {
        await reportError({
          title: "Uninstall failed",
          body: `Could not remove ${game.title}.`,
          details: errorMessage(error),
        });
      }
    },
    [appendLog, gameStore],
  );

  const handleLaunch = useCallback(
    (game: StoreGame): void => {
      appendLog("info", `launch ${game.appId} → ${game.exePath || "shell surface"}`);
      launchGame(game);
    },
    [appendLog, launchGame],
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
            <h1 className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink">Game Store</h1>
            <Badge tone="accent" dot>
              {installedCount}/{games.length || "—"} installed
            </Badge>
          </div>
          <p className="truncate text-[10px] text-ink-faint">
            Pinned workloads. Every card carries the CI evidence that backs it.
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
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
            icon={Terminal}
            aria-pressed={logsOpen}
            onClick={toggleLogs}
            title="Toggle the runtime console"
            className={logsOpen ? "bg-white/[0.06] text-ink" : undefined}
          >
            Console
          </Button>
        </div>
      </header>

      <div className="flex flex-none items-center gap-1.5 border-b border-white/[0.05] px-3 py-1.5">
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
          mock runtime · storefront entries are local
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
              icon={Download}
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
              progress={progress}
            />
          )}

          <p className="mt-4 flex items-center gap-1.5 text-[9.5px] leading-relaxed text-ink-ghost">
            <ShieldCheck size={10} aria-hidden />
            Evidence strings mirror docs/FINAL-STATUS-REPORT.md. Installing here never
            downloads game bytes.
          </p>
        </section>

        {selected ? (
          <GameDetails
            game={selected}
            progress={progress[selected.appId]}
            logsOpen={logsOpen}
            onInstall={() => {
              void handleInstall(selected);
            }}
            onLaunch={() => handleLaunch(selected)}
            onUninstall={() => {
              void handleUninstall(selected);
            }}
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
