import { BookmarkCheck, BookmarkPlus } from "lucide-react";
import type { StoreGame } from "@runtime/types";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { coverStyle } from "./cover";

interface GameGridProps {
  games: StoreGame[];
  selectedId: string | null;
  onSelect: (appId: string) => void;
}

/** Catalog card grid; membership badges never imply that a binary is installed. */
export function GameGrid({ games, selectedId, onSelect }: GameGridProps) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(178px, 1fr))" }}>
      {games.map((game) => {
        const cover = coverStyle(game.appId);
        const Icon = cover.icon;
        const inLibrary = game.status === "in-library";
        const selected = selectedId === game.appId;

        return (
          <button
            key={game.appId}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(game.appId)}
            className={cn(
              "group relative flex flex-col overflow-hidden rounded-[8px] border text-left transition duration-200 ease-kde",
              selected
                ? "border-accent/45 bg-white/[0.05] shadow-[0_0_0_1px_rgb(var(--accent-rgb)/0.16),0_18px_44px_-20px_rgba(0,0,0,0.85)]"
                : "border-white/[0.07] bg-white/[0.02] hover:-translate-y-0.5 hover:border-white/[0.15] hover:bg-white/[0.04]",
            )}
          >
            <div className="relative aspect-[4/5] w-full overflow-hidden" style={{ backgroundImage: cover.gradient }}>
              <div className="absolute inset-0 opacity-40" style={{
                backgroundImage: "linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)",
                backgroundSize: "18px 18px",
                maskImage: "radial-gradient(ellipse 80% 70% at 50% 30%, black, transparent 78%)",
              }} aria-hidden />
              <span className="absolute left-2.5 top-2.5">
                <Badge tone={game.kind === "game" ? "accent" : game.kind === "system" ? "violet" : "neutral"}>
                  {game.kind}
                </Badge>
              </span>
              {inLibrary && (
                <span className="absolute right-2.5 top-2.5 grid h-5 w-5 place-items-center rounded-full border border-success/30 bg-black/45 text-success backdrop-blur" title="In the local library">
                  <BookmarkCheck size={12} aria-hidden />
                </span>
              )}
              <div className="absolute inset-0 grid place-items-center">
                <span className="grid h-14 w-14 place-items-center rounded-[12px] border border-white/[0.12] bg-black/25 backdrop-blur-sm" style={{ color: cover.tint, boxShadow: `0 0 28px ${cover.tint}33` }}>
                  <Icon size={26} strokeWidth={1.7} aria-hidden />
                </span>
              </div>
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent p-2.5 pt-8">
                <p className="truncate text-[11.5px] font-semibold tracking-[-0.01em] text-ink">{game.title}</p>
                <p className="mt-0.5 truncate text-[9.5px] text-ink-faint">{game.chocolatey?.version || game.version}</p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 px-2.5 py-2">
              <span className="flex items-center gap-1.5 text-[9.5px] text-ink-faint">
                {inLibrary ? <BookmarkCheck size={10} className="text-success" aria-hidden /> : <BookmarkPlus size={10} aria-hidden />}
                {inLibrary ? "in library" : "not in library"}
              </span>
              <span className="font-mono text-[9px] text-ink-ghost">
                {game.chocolateyPackageId ? "feed metadata" : game.exePath ? "local files" : "runtime record"}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
