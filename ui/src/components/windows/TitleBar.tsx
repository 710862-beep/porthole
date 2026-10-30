import type { PointerEvent as ReactPointerEvent } from "react";
import { APPS } from "@/store/apps";
import { useWindowStore, type WindowInstance } from "@/store/windowStore";
import { Badge } from "@/components/ui/Badge";
import styles from "@/styles/window.module.css";
import glass from "@/styles/glass.module.css";
import { cn } from "@/lib/cn";
import { WindowControls } from "./WindowControls";

interface TitleBarProps {
  instance: WindowInstance;
  focused: boolean;
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onOpenMenu: (x: number, y: number) => void;
}

/** Dark chrome bar: app identity, draggable surface, window controls. */
export function TitleBar({ instance, focused, onDragStart, onOpenMenu }: TitleBarProps) {
  const app = APPS[instance.appId];
  const Icon = app.icon;
  const maximized = instance.status === "maximized";

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    onDragStart(event);
  };

  return (
    <header
      className={cn(styles.titlebar, glass.titlebar, "select-none")}
      onPointerDown={handlePointerDown}
      onDoubleClick={() => useWindowStore.getState().toggleMaximize(instance.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu(event.clientX, event.clientY);
      }}
      title="Drag to move · double-click to maximize · right-click for window menu"
    >
      <span
        className={styles.appBadge}
        style={{
          color: app.tint,
          backgroundColor: `${app.tint}14`,
          boxShadow: `inset 0 0 0 1px ${app.tint}26`,
        }}
      >
        <Icon size={12} strokeWidth={2} aria-hidden />
      </span>

      <div className={styles.title}>
        <span className={cn("truncate", !focused && "text-ink-muted")}>{instance.title}</span>
        {instance.payload?.kind === "game" && (
          <Badge tone="violet" className="hidden sm:inline-flex">
            game
          </Badge>
        )}
      </div>

      <WindowControls windowId={instance.id} maximized={maximized} />
    </header>
  );
}
