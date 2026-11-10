import { Download, HardDrive, Package, Sparkles } from "lucide-react";
import type { StoreGame } from "@runtime/types";
import { AppIcon } from "@/components/ui/AppIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { coverStyle } from "./cover";

interface GameGridProps {
  games: StoreGame[];
  downloadedPackageIds: ReadonlySet<string>;
  downloadingAppId: string | null;
  onSelect: (game: StoreGame) => void;
  onDownload: (game: StoreGame) => void;
}

/** App-center cards with an honest one-click package-download action. */
export function GameGrid({
  games,
  downloadedPackageIds,
  downloadingAppId,
  onSelect,
  onDownload,
}: GameGridProps) {
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">
      {games.map((game) => {
        const cover = coverStyle(game.appId);
        const inLibrary = game.status === "in-library";
        const downloaded = downloadedPackageIds.has(game.appId);
        const isDownloading = downloadingAppId === game.appId;
        const hasPackage = Boolean(game.chocolateyPackageId);

        return (
          <article
            key={game.appId}
            className="group flex min-w-0 flex-col rounded-[12px] border border-white/[0.075] bg-white/[0.025] p-3 transition duration-200 hover:-translate-y-0.5 hover:border-white/[0.14] hover:bg-white/[0.045] hover:shadow-[0_18px_44px_-30px_rgba(0,0,0,0.9)]"
          >
            <button
              type="button"
              onClick={() => onSelect(game)}
              className="flex min-w-0 flex-1 gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              aria-label={`View ${game.title} details`}
            >
              <span
                className="grid h-12 w-12 flex-none place-items-center rounded-[11px] border border-white/[0.1] bg-black/20"
                style={{ backgroundImage: cover.gradient }}
              >
                <AppIcon icon={cover.icon} tint={cover.tint} size={36} iconSize={19} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[12px] font-semibold text-ink">{game.chocolatey?.title || game.title}</span>
                  {inLibrary && <Sparkles size={11} className="flex-none text-accent" aria-label="In Porthole library" />}
                </span>
                <span className="mt-1 block line-clamp-2 min-h-[30px] text-[10px] leading-[1.5] text-ink-faint">
                  {game.chocolatey?.summary || game.summary || game.genre}
                </span>
              </span>
            </button>

            <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <Badge tone={hasPackage ? "accent" : "neutral"}>
                  {hasPackage ? "Chocolatey" : game.kind}
                </Badge>
                <span className="truncate text-[9px] text-ink-ghost" title={game.chocolatey?.version || game.version}>
                  {game.chocolatey?.version || game.version}
                </span>
                {downloaded && <HardDrive size={11} className="flex-none text-success" aria-label="Package saved in Porthole storage" />}
              </div>
              {hasPackage ? (
                <Button
                  size="xs"
                  variant={downloaded ? "secondary" : "primary"}
                  icon={downloaded ? HardDrive : Download}
                  loading={isDownloading}
                  disabled={Boolean(downloadingAppId && !isDownloading)}
                  onClick={() => onDownload(game)}
                  title={`Download ${game.chocolateyPackageId} package archive to Porthole storage; it will not run the package installer.`}
                >
                  {isDownloading ? "Saving…" : downloaded ? "Get latest" : "Get"}
                </Button>
              ) : (
                <Button size="xs" variant="ghost" icon={Package} onClick={() => onSelect(game)}>
                  Details
                </Button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
