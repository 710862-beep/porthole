import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { motion } from "framer-motion";
import {
  Gamepad2,
  Grid2x2,
  HardDrive,
  Info,
  LayoutGrid,
  Lock,
  Search,
  Settings2,
  Wrench,
  X,
  Cpu,
  type LucideIcon,
} from "lucide-react";
import { APP_LIST, APPS, PINNED_APPS, type AppDefinition } from "@/store/apps";
import { useUiStore } from "@/store/uiStore";
import { useEmulatorStore } from "@/store/emulatorStore";
import { useWindowManager } from "@/hooks/useWindowManager";
import { AppIcon } from "@/components/ui/AppIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PortholeMark } from "@/components/ui/PortholeMark";
import glass from "@/styles/glass.module.css";
import { cn } from "@/lib/cn";
import { EASE_KDE } from "@/lib/motion";

type CategoryId = "all" | AppDefinition["category"];

interface CategoryDef {
  id: CategoryId;
  label: string;
  icon: LucideIcon;
}

const CATEGORIES: CategoryDef[] = [
  { id: "all", label: "All applications", icon: Grid2x2 },
  { id: "games", label: "Games", icon: Gamepad2 },
  { id: "emulators", label: "Emulators", icon: Cpu },
  { id: "utilities", label: "Utilities", icon: Wrench },
  { id: "system", label: "System", icon: LayoutGrid },
  { id: "settings", label: "Settings", icon: Settings2 },
];

function matches(app: AppDefinition, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [app.title, app.description, app.category, ...app.keywords].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

/**
 * Kickoff-style launcher: categories, live search, pinned shortcuts, session
 * actions. Full keyboard support (↑ ↓ Enter Esc) and zero dead buttons.
 */
export function AppLauncher() {
  const closeLauncher = useUiStore((state) => state.closeLauncher);
  const lock = useUiStore((state) => state.lock);
  const openOverview = useUiStore((state) => state.openOverview);
  const { openApp } = useWindowManager();
  const storage = useEmulatorStore((state) => state.storage);
  const mode = useEmulatorStore((state) => state.mode);

  const [category, setCategory] = useState<CategoryId>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  const filtered = useMemo(() => {
    const list = APP_LIST.filter((app) =>
      query.trim() ? matches(app, query) : category === "all" || app.category === category,
    );
    return list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title));
  }, [category, query]);

  useEffect(() => {
    setSelected(0);
  }, [category, query]);

  const counts = useMemo(() => {
    const map = new Map<CategoryId, number>();
    map.set("all", APP_LIST.length);
    for (const app of APP_LIST) {
      map.set(app.category, (map.get(app.category) ?? 0) + 1);
    }
    return map;
  }, []);

  const launch = (app: AppDefinition): void => {
    openApp(app.id);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((index) => Math.min(filtered.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      const app = filtered[selected] ?? filtered[0];
      if (app) {
        event.preventDefault();
        launch(app);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeLauncher();
    }
  };

  return (
    <div className="fixed inset-0 z-[60]">
      <motion.div
        className="absolute inset-0 bg-[#07070d]/55 backdrop-blur-[6px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={closeLauncher}
        aria-hidden
      />

      <motion.section
        role="dialog"
        aria-modal="true"
        aria-label="Application launcher"
        initial={{ opacity: 0, y: 26, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 18, scale: 0.99 }}
        transition={{ duration: 0.26, ease: EASE_KDE }}
        className={cn(
          glass.launcher,
          "absolute bottom-[58px] left-3 flex h-[min(620px,calc(100vh-86px))] w-[min(780px,calc(100vw-24px))] flex-col overflow-hidden",
        )}
      >
        {/* Search header */}
        <header className="flex flex-none items-center gap-3 border-b border-white/[0.07] px-4 py-3.5">
          <span className="grid h-9 w-9 flex-none place-items-center rounded-[9px] border border-white/[0.08] bg-white/[0.04]">
            <PortholeMark size={20} />
          </span>
          <div className="relative flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
              aria-hidden
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search applications…"
              aria-label="Search applications"
              className="h-9 w-full rounded-control border border-white/[0.08] bg-black/30 pl-9 pr-9 text-[12.5px] text-ink placeholder:text-ink-ghost transition focus:border-accent/40 focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-accent/25"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-[5px] text-ink-faint hover:bg-white/[0.07] hover:text-ink"
              >
                <X size={12} aria-hidden />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={closeLauncher}
            aria-label="Close launcher"
            className="grid h-8 w-8 flex-none place-items-center rounded-control text-ink-faint transition hover:bg-white/[0.07] hover:text-ink"
          >
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Categories */}
          <nav
            aria-label="Application categories"
            className="no-scrollbar flex w-[186px] flex-none flex-col gap-0.5 overflow-y-auto border-r border-white/[0.06] p-2"
          >
            {CATEGORIES.map((item) => {
              const Icon = item.icon;
              const active = category === item.id && !query;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active}
                  onClick={() => {
                    setCategory(item.id);
                    setQuery("");
                  }}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[11.5px] transition-colors",
                    active
                      ? "bg-white/[0.08] text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
                      : "text-ink-muted hover:bg-white/[0.05] hover:text-ink",
                  )}
                >
                  <Icon
                    size={13}
                    className={active ? "text-accent" : "text-ink-faint"}
                    aria-hidden
                  />
                  <span className="flex-1 truncate">{item.label}</span>
                  <span className="font-mono text-[9.5px] text-ink-ghost">
                    {counts.get(item.id) ?? 0}
                  </span>
                </button>
              );
            })}

            <div className="mt-auto hidden flex-col gap-1.5 px-1.5 pb-1 pt-3 xl:flex">
              <Badge tone="warning" dot className="w-fit">
                mock runtime
              </Badge>
              <p className="text-[10px] leading-relaxed text-ink-ghost">
                Turn the Runtime into a Wasm adapter in <code>ui/runtime</code> — the
                desktop code does not change.
              </p>
            </div>
          </nav>

          {/* Application list */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="No applications match"
                  body={`Nothing in the launcher matches “${query}”. Try “store”, “terminal” or “settings”.`}
                  action={
                    <Button size="sm" variant="secondary" onClick={() => setQuery("")}>
                      Clear search
                    </Button>
                  }
                  className="m-2 border-white/[0.07]"
                />
              ) : (
                <ul role="list" className="flex flex-col gap-0.5">
                  {filtered.map((app, index) => (
                    <li key={app.id}>
                      <button
                        type="button"
                        onClick={() => launch(app)}
                        onPointerEnter={() => setSelected(index)}
                        aria-current={index === selected || undefined}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-[8px] px-2 py-1.5 text-left transition-colors",
                          index === selected
                            ? "bg-white/[0.07]"
                            : "hover:bg-white/[0.045]",
                        )}
                      >
                        <AppIcon icon={app.icon} tint={app.tint} size={32} iconSize={16} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-[12px] font-medium text-ink">
                              {app.title}
                            </span>
                            {app.pinned && (
                              <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-ghost">
                                pinned
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-[10.5px] text-ink-faint">
                            {app.description}
                          </span>
                        </span>
                        <span className="flex-none rounded-[5px] border border-white/[0.07] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-ghost">
                          {app.category}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Session footer */}
            <footer className="flex flex-none items-center gap-1.5 border-t border-white/[0.07] bg-black/20 px-2.5 py-2">
              <Button
                size="sm"
                variant="ghost"
                icon={Lock}
                onClick={() => {
                  closeLauncher();
                  lock();
                }}
              >
                Lock
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={LayoutGrid}
                onClick={() => {
                  closeLauncher();
                  openOverview();
                }}
              >
                Overview
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={Settings2}
                onClick={() => openApp("settings")}
              >
                Settings
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={Info}
                onClick={() => openApp("welcome")}
              >
                About
              </Button>
              <span className="ml-auto flex items-center gap-2 pr-1 text-[9.5px] text-ink-ghost">
                <span className="flex items-center gap-1">
                  <HardDrive size={10} aria-hidden />
                  {storage?.label ?? "OPFS"}
                </span>
                <span className="h-2.5 w-px bg-white/10" aria-hidden />
                <span className="font-mono uppercase tracking-[0.08em]">{mode}</span>
              </span>
            </footer>
          </div>

          {/* Pinned panel */}
          <aside className="hidden w-[196px] flex-none flex-col border-l border-white/[0.06] p-3 xl:flex">
            <h2 className="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              Pinned
            </h2>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {PINNED_APPS.map((appId) => {
                const app = APPS[appId];
                return (
                  <button
                    key={appId}
                    type="button"
                    onClick={() => launch(app)}
                    title={app.title}
                    className="group flex flex-col items-center gap-1.5 rounded-[9px] border border-white/[0.05] bg-white/[0.02] px-1.5 py-2.5 transition hover:border-accent/25 hover:bg-white/[0.055]"
                  >
                    <AppIcon icon={app.icon} tint={app.tint} size={30} iconSize={15} />
                    <span className="w-full truncate text-center text-[9.5px] text-ink-muted group-hover:text-ink">
                      {app.title}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 rounded-[10px] border border-white/[0.06] bg-black/20 p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Hot corner
              </p>
              <p className="mt-1.5 text-[10px] leading-relaxed text-ink-ghost">
                Move the pointer to the top-left pixel or tap{" "}
                <span className="font-mono text-ink-muted">Super</span> to open Overview.
              </p>
            </div>

            <div className="mt-auto rounded-[10px] border border-white/[0.06] bg-black/20 p-2.5">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                <PortholeMark size={12} />
                Porthole
              </p>
              <p className="mt-1.5 text-[10px] leading-relaxed text-ink-ghost">
                Desktop shell {`v0.5.0`} · runtime {mode}
              </p>
            </div>
          </aside>
        </div>
      </motion.section>
    </div>
  );
}
