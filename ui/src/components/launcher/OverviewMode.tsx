import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { motion } from "framer-motion";
import { AppWindow, CornerDownLeft, Plus, Search, X } from "lucide-react";
import { APP_LIST, APPS, type AppId } from "@/store/apps";
import { useUiStore } from "@/store/uiStore";
import {
  useWindowStore,
  viewportSize,
  type WindowInstance,
} from "@/store/windowStore";
import { useWindowManager } from "@/hooks/useWindowManager";
import { AppIcon } from "@/components/ui/AppIcon";
import { Badge } from "@/components/ui/Badge";
import { Kbd } from "@/components/ui/Kbd";
import { WindowThumbnail } from "./WindowThumbnail";
import styles from "@/styles/overview.module.css";
import { cn } from "@/lib/cn";
import { EASE_KDE } from "@/lib/motion";

type ResultItem =
  | { kind: "window"; key: string; instance: WindowInstance }
  | { kind: "app"; key: string; appId: AppId };

function appMatches(appId: AppId, needle: string): boolean {
  const app = APPS[appId];
  return [app.title, app.description, app.category, ...app.keywords]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/**
 * KDE-style Overview: scaled desktop behind, window cards, workspace rail and a
 * universal search. Clicking empty space exits; clicking a card focuses it.
 */
export function OverviewMode() {
  const closeOverview = useUiStore((state) => state.closeOverview);
  const workspace = useWindowStore((state) => state.workspace);
  const workspaceCount = useWindowStore((state) => state.workspaceCount);
  const windows = useWindowStore((state) => state.windows);
  const order = useWindowStore((state) => state.order);
  const focusedId = useWindowStore((state) => state.focusedId);
  const setWorkspace = useWindowStore((state) => state.setWorkspace);
  const setWorkspaceCount = useWindowStore((state) => state.setWorkspaceCount);
  const { openApp, closeWindow } = useWindowManager();

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      searchRef.current?.focus({ preventScroll: true });
    }, 140);
    return () => window.clearTimeout(timer);
  }, []);

  const instances = useMemo<WindowInstance[]>(
    () => order.map((id) => windows[id]).filter((instance): instance is WindowInstance => Boolean(instance)),
    [order, windows],
  );

  const workspaceWindows = useMemo(
    () => instances.filter((instance) => instance.workspace === workspace),
    [instances, workspace],
  );

  const results = useMemo<ResultItem[]>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const windowResults: ResultItem[] = instances
      .filter(
        (instance) =>
          instance.title.toLowerCase().includes(needle) ||
          APPS[instance.appId].title.toLowerCase().includes(needle),
      )
      .map((instance) => ({ kind: "window", key: `w:${instance.id}`, instance }));
    const appResults: ResultItem[] = APP_LIST.filter((app) => appMatches(app.id, needle)).map(
      (app) => ({ kind: "app", key: `a:${app.id}`, appId: app.id }),
    );
    return [...windowResults, ...appResults].slice(0, 8);
  }, [instances, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const focusInstance = (instance: WindowInstance): void => {
    const store = useWindowStore.getState();
    store.restoreWindow(instance.id);
    store.focusWindow(instance.id);
    closeOverview();
  };

  const activate = (item: ResultItem): void => {
    if (item.kind === "window") focusInstance(item.instance);
    else openApp(item.appId);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      const item = results[selected] ?? results[0];
      if (item) {
        event.preventDefault();
        activate(item);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (query) setQuery("");
      else closeOverview();
    }
  };

  const viewport = viewportSize();
  const thumbPercent = (value: number, total: number): string =>
    `${Math.min(100, Math.max(4, (value / Math.max(total, 1)) * 100))}%`;

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Overview"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: EASE_KDE }}
      className={cn(styles.backdrop, "fixed inset-0 z-40 overflow-hidden")}
    >
      <button
        type="button"
        aria-label="Close Overview"
        onClick={closeOverview}
        className="absolute inset-0 h-full w-full cursor-default"
      />

      <div className="pointer-events-none absolute inset-0">
        {/* Search */}
        <div className={cn(styles.searchWrap, "pointer-events-auto")}>
          <div className={styles.search}>
            <Search size={15} className="text-ink-faint" aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search windows and applications…"
              aria-label="Search windows and applications"
              className={styles.searchInput}
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                className="grid h-6 w-6 place-items-center rounded-[5px] text-ink-faint hover:bg-white/[0.08] hover:text-ink"
              >
                <X size={12} aria-hidden />
              </button>
            ) : (
              <Kbd>Esc</Kbd>
            )}
          </div>

          {query && (
            <div className={styles.results} role="listbox" aria-label="Search results">
              {results.length === 0 ? (
                <p className="px-3 py-3 text-[11.5px] text-ink-faint">
                  No windows or applications match “{query}”.
                </p>
              ) : (
                results.map((item, index) => {
                  const appId = item.kind === "window" ? item.instance.appId : item.appId;
                  const app = APPS[appId];
                  const title = item.kind === "window" ? item.instance.title : app.title;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      role="option"
                      aria-selected={index === selected}
                      data-selected={index === selected}
                      onPointerEnter={() => setSelected(index)}
                      onClick={() => activate(item)}
                      className={styles.resultRow}
                    >
                      <AppIcon icon={app.icon} tint={app.tint} size={24} iconSize={13} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px] text-ink">{title}</span>
                        <span className="block truncate text-[9.5px] text-ink-faint">
                          {item.kind === "window"
                            ? `window · workspace ${item.instance.workspace + 1}`
                            : `application · ${app.category}`}
                        </span>
                      </span>
                      {item.kind === "window" ? (
                        <AppWindow size={12} className="text-ink-ghost" aria-hidden />
                      ) : (
                        <CornerDownLeft size={12} className="text-ink-ghost" aria-hidden />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Workspace rail */}
        <aside className={cn(styles.workspaceRail, "pointer-events-auto")}>
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              Workspaces
            </span>
            <span className="font-mono text-[9.5px] text-ink-ghost">
              {workspace + 1}/{workspaceCount}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            {Array.from({ length: workspaceCount }, (_, index) => {
              const items = instances.filter((instance) => instance.workspace === index);
              const visible = items.filter((instance) => instance.status !== "minimized");
              return (
                <button
                  key={index}
                  type="button"
                  data-active={index === workspace || undefined}
                  aria-current={index === workspace}
                  onClick={() => setWorkspace(index)}
                  className={styles.workspace}
                >
                  <div className="flex items-center justify-between pb-1.5">
                    <span className="text-[10px] font-medium text-ink-muted">
                      Desktop {index + 1}
                    </span>
                    <span className="font-mono text-[9px] text-ink-ghost">
                      {items.length} win
                    </span>
                  </div>
                  <div className={styles.miniMap}>
                    {visible.map((instance) => (
                      <span
                        key={instance.id}
                        className={styles.miniWindow}
                        style={{
                          left: thumbPercent(instance.bounds.x, viewport.width),
                          top: thumbPercent(instance.bounds.y, viewport.height),
                          width: thumbPercent(instance.bounds.width, viewport.width),
                          height: thumbPercent(instance.bounds.height, viewport.height),
                          borderColor:
                            instance.id === focusedId
                              ? "rgba(234,246,255,0.8)"
                              : undefined,
                        }}
                      />
                    ))}
                  </div>
                </button>
              );
            })}

            {workspaceCount < 8 && (
              <button
                type="button"
                onClick={() => setWorkspaceCount(workspaceCount + 1)}
                className="mt-0.5 flex h-7 items-center justify-center gap-1.5 rounded-[7px] border border-dashed border-white/[0.1] text-[10px] text-ink-faint transition hover:border-accent/30 hover:text-accent"
              >
                <Plus size={11} aria-hidden />
                Add workspace
              </button>
            )}
          </div>
        </aside>

        {/* Window cards */}
        <section
          aria-label={`Windows on workspace ${workspace + 1}`}
          className="pointer-events-auto absolute bottom-[64px] left-[216px] right-8 top-[104px] overflow-y-auto pr-1"
        >
          {workspaceWindows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-6">
              <div className="text-center">
                <p className="text-[13px] font-medium text-ink">
                  No windows on workspace {workspace + 1}
                </p>
                <p className="mt-1 text-[11px] text-ink-faint">
                  Launch an application, or pick a workspace on the left.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {APP_LIST.slice(0, 6).map((app) => (
                  <button
                    key={app.id}
                    type="button"
                    onClick={() => openApp(app.id)}
                    className="flex w-[132px] flex-col items-center gap-2 rounded-[10px] border border-white/[0.07] bg-white/[0.025] px-2 py-3 transition hover:border-accent/30 hover:bg-white/[0.06]"
                  >
                    <AppIcon icon={app.icon} tint={app.tint} size={28} iconSize={14} />
                    <span className="w-full truncate text-center text-[10px] text-ink-muted">
                      {app.title}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <motion.div
              layout
              className="grid gap-3.5"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))" }}
            >
              {workspaceWindows.map((instance, index) => {
                const app = APPS[instance.appId];
                return (
                  <motion.div
                    key={instance.id}
                    layout
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    transition={{ duration: 0.22, ease: EASE_KDE, delay: index * 0.025 }}
                    className="group relative"
                  >
                    <button
                      type="button"
                      onClick={() => focusInstance(instance)}
                      aria-label={`Focus ${instance.title}`}
                      className={styles.card}
                    >
                      <div
                        className={cn(styles.thumb, "relative aspect-[16/9] w-full")}
                        style={{
                          backgroundImage: `radial-gradient(ellipse 70% 60% at 30% 8%, ${app.tint}1f, transparent 62%)`,
                        }}
                      >
                        <WindowThumbnail appId={instance.appId} tint={app.tint} />
                      </div>
                      <div className="flex items-center gap-2 border-t border-white/[0.06] p-2.5">
                        <AppIcon icon={app.icon} tint={app.tint} size={22} iconSize={12} />
                        <div className="min-w-0 flex-1 text-left">
                          <p className="truncate text-[11.5px] font-medium text-ink">
                            {instance.title}
                          </p>
                          <p className="truncate text-[9.5px] text-ink-faint">
                            {app.title} · desktop {instance.workspace + 1}
                          </p>
                        </div>
                        {instance.status === "minimized" && (
                          <Badge tone="warning">minimized</Badge>
                        )}
                        {instance.status === "maximized" && (
                          <Badge tone="accent">max</Badge>
                        )}
                      </div>
                    </button>

                    <button
                      type="button"
                      aria-label={`Close ${instance.title}`}
                      title="Close window"
                      onClick={(event) => {
                        event.stopPropagation();
                        void closeWindow(instance.id);
                      }}
                      className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-[7px] border border-white/10 bg-black/55 text-ink-muted opacity-0 backdrop-blur transition hover:border-danger/40 hover:bg-danger/20 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X size={13} aria-hidden />
                    </button>
                  </motion.div>
                );
              })}
            </motion.div>
          )}
        </section>

        <div className={styles.hint}>
          <span className="flex items-center gap-1.5">
            <Kbd>Esc</Kbd> Exit
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Enter</Kbd> Open selected
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Super</Kbd> Toggle Overview
          </span>
          <span className="text-ink-ghost">·</span>
          <span className="text-ink-ghost">
            {workspaceWindows.length} window{workspaceWindows.length === 1 ? "" : "s"} on this
            desktop
          </span>
        </div>
      </div>
    </motion.div>
  );
}
