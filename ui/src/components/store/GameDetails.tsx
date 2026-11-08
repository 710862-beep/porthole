import { useState, type ReactNode } from "react";
import {
  BookmarkCheck,
  BookmarkPlus,
  Copy,
  Download,
  ExternalLink,
  HardDrive,
  Info,
  Play,
  ScrollText,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { StoreGame } from "@runtime/types";
import { AppIcon } from "@/components/ui/AppIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { copyText } from "@/lib/clipboard";
import { shortHash } from "@/lib/format";
import { toast } from "@/store/uiStore";
import { cn } from "@/lib/cn";
import { coverStyle } from "./cover";

export interface PackageDownloadStatus {
  appId: string;
  title: string;
  phase: "downloading" | "saving";
  receivedBytes: number;
  totalBytes: number | null;
}

interface GameDetailsProps {
  game: StoreGame;
  logsOpen: boolean;
  storageLabel: string;
  currentPackagePath: string | null;
  downloadedPackagePaths: string[];
  packageDownloadEnabled: boolean;
  packageDownloadDisabledReason: string | null;
  packageDownloadStatus: PackageDownloadStatus | null;
  onAdd: () => void;
  onDownloadPackage: () => void;
  onCancelDownload: () => void;
  onLaunch: () => void;
  onRemove: () => void;
  onToggleLogs: () => void;
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="flex-none text-[10.5px] text-ink-faint">{label}</span>
      <span className="min-w-0 truncate text-right text-[10.5px] text-ink-muted">{children}</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Right-hand detail pane: Chocolatey downloads, metadata, evidence and library actions. */
export function GameDetails({
  game,
  logsOpen,
  storageLabel,
  currentPackagePath,
  downloadedPackagePaths,
  packageDownloadEnabled,
  packageDownloadDisabledReason,
  packageDownloadStatus,
  onAdd,
  onDownloadPackage,
  onCancelDownload,
  onLaunch,
  onRemove,
  onToggleLogs,
}: GameDetailsProps) {
  const [copied, setCopied] = useState(false);
  const cover = coverStyle(game.appId);
  const Icon = cover.icon;
  const inLibrary = game.status === "in-library";

  const handleCopyHash = async (): Promise<void> => {
    if (!game.sha256) return;
    const ok = await copyText(game.sha256);
    setCopied(ok);
    if (ok) toast({ title: "SHA-256 copied", tone: "success", duration: 2200 });
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <aside className="flex h-full w-[352px] flex-none flex-col border-l border-white/[0.07] bg-black/15">
      <div
        className="relative h-[124px] flex-none overflow-hidden"
        style={{ backgroundImage: cover.gradient }}
      >
        <div
          className="absolute inset-0 opacity-35"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
            maskImage: "radial-gradient(ellipse 90% 80% at 30% 20%, black, transparent 80%)",
          }}
          aria-hidden
        />
        <Icon
          size={120}
          strokeWidth={0.7}
          className="absolute -bottom-6 right-2 opacity-[0.12]"
          style={{ color: cover.tint }}
          aria-hidden
        />
        <div className="absolute inset-x-4 bottom-3">
          <div className="flex items-center gap-2">
            <AppIcon icon={cover.icon} tint={cover.tint} size={26} iconSize={14} />
            <Badge tone={game.kind === "game" ? "accent" : game.kind === "system" ? "violet" : "neutral"}>
              {game.kind}
            </Badge>
            {inLibrary ? (
              <Badge tone="success" dot>
                in library
              </Badge>
            ) : (
              <Badge tone="neutral" dot>
                not in library
              </Badge>
            )}
          </div>
          <h2 className="mt-2 text-[17px] font-semibold leading-tight tracking-[-0.015em] text-ink">
            {game.title}
          </h2>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <p className="text-[11.5px] leading-relaxed text-ink-muted">{game.summary}</p>

        <div className="mt-4 rounded-[9px] border border-white/[0.07] bg-black/20 px-3 py-1">
          <MetaRow label="Version">{game.chocolatey?.version || game.version}</MetaRow>
          <MetaRow label="Genre">{game.genre}</MetaRow>
          {game.chocolateyPackageId && (
            <MetaRow label="Chocolatey ID">
              {game.chocolatey?.packageId ?? `${game.chocolateyPackageId} · metadata pending`}
            </MetaRow>
          )}
          <MetaRow label="Expected guest path">
            <span className="font-mono text-[10px]">{game.exePath || "shell surface"}</span>
          </MetaRow>
          {game.requiredFiles?.length ? (
            <MetaRow label="Required files">
              {game.requiredFiles.map((file) => file.split("\\").at(-1) ?? file).join(", ")}
            </MetaRow>
          ) : null}
          <MetaRow label="Location">Browser-local catalog</MetaRow>
          {game.sha256 && (
            <MetaRow label="SHA-256">
              <span className="inline-flex items-center gap-1.5 font-mono text-[10px]">
                {shortHash(game.sha256, 8, 6)}
                <button
                  type="button"
                  onClick={() => {
                    void handleCopyHash();
                  }}
                  aria-label="Copy SHA-256"
                  className={cn(
                    "grid h-5 w-5 place-items-center rounded-[4px] transition hover:bg-white/[0.08]",
                    copied ? "text-success" : "text-ink-faint hover:text-ink",
                  )}
                >
                  <Copy size={10} aria-hidden />
                </button>
              </span>
            </MetaRow>
          )}
        </div>

        {game.chocolatey && (
          <section className="mt-3 rounded-[9px] border border-violet/15 bg-violet/[0.045] p-3" aria-label="Chocolatey public package metadata">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-violet">Chocolatey metadata</p>
              <span className="text-[9px] text-ink-ghost">package ID · version · description</span>
            </div>
            {(game.chocolatey.summary || game.chocolatey.description) && (
              <p className="mt-2 line-clamp-4 text-[10px] leading-relaxed text-ink-muted">
                {game.chocolatey.summary || game.chocolatey.description}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[9px] text-ink-faint">
              <span className="rounded-[4px] bg-white/[0.06] px-1.5 py-0.5">v{game.chocolatey.version}</span>
              <span className="rounded-[4px] bg-white/[0.06] px-1.5 py-0.5">
                {game.chocolatey.downloadCount === null ? "downloads n/a" : `${game.chocolatey.downloadCount.toLocaleString()} downloads`}
              </span>
              {game.chocolatey.tags.slice(0, 6).map((tag) => (
                <span key={tag} className="rounded-[4px] bg-white/[0.04] px-1.5 py-0.5">{tag}</span>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-ink-ghost">
              <span>Refreshed {new Date(game.chocolatey.fetchedAt).toLocaleString()}</span>
              {game.chocolatey.projectUrl.startsWith("https://") && (
                <a href={game.chocolatey.projectUrl} target="_blank" rel="noreferrer noopener" className="inline-flex flex-none items-center gap-1 text-violet hover:text-ink">
                  Project <ExternalLink size={9} aria-hidden />
                </a>
              )}
            </div>
          </section>
        )}

        {game.chocolateyPackageId && (
          <section className="mt-3 rounded-[9px] border border-white/[0.07] bg-black/20 p-3" aria-label="Package download destination">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-muted">
              <HardDrive size={11} aria-hidden />
              Porthole storage
            </p>
            <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
              Chocolatey .nupkg archives are saved under PortholePackages/ in {storageLabel || "selected storage"}, outside the guest C:\\Game files. Package scripts and installers are not run.
            </p>
            {currentPackagePath && (
              <p className="mt-2 break-all font-mono text-[9px] text-success" title={currentPackagePath}>
                Latest version saved: {currentPackagePath}
              </p>
            )}
            {!currentPackagePath && downloadedPackagePaths.length > 0 && (
              <p className="mt-2 break-all font-mono text-[9px] text-ink-muted">
                Saved archive: {downloadedPackagePaths[0]}
              </p>
            )}
          </section>
        )}

        <div className="mt-3 rounded-[9px] border border-accent/15 bg-accent/[0.05] p-3">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">
            <ShieldCheck size={12} aria-hidden />
            Evidence
          </p>
          <p className="selectable mt-1.5 text-[10.5px] leading-relaxed text-ink-muted">
            {game.evidence ?? "No evidence string recorded for this entry."}
          </p>
        </div>

        <div className="mt-3 flex gap-2 rounded-[9px] border border-white/[0.06] bg-black/15 p-2.5">
          <Info size={12} className="mt-0.5 flex-none text-ink-faint" aria-hidden />
          <p className="text-[10px] leading-relaxed text-ink-ghost">{game.provenance}</p>
        </div>
      </div>

      <footer className="flex-none border-t border-white/[0.07] bg-black/20 p-3">
        <div className="flex flex-col gap-2">
          {game.chocolateyPackageId && (
            <div className="flex flex-col gap-1.5">
              <Button
                variant="primary"
                size="md"
                fullWidth
                icon={Download}
                loading={packageDownloadStatus?.appId === game.appId}
                disabled={!packageDownloadEnabled || Boolean(packageDownloadStatus && packageDownloadStatus.appId !== game.appId)}
                onClick={onDownloadPackage}
                title={packageDownloadDisabledReason ?? "Download the Chocolatey .nupkg into PortholePackages on the selected storage backend. Package scripts and installers are not run."}
              >
                {packageDownloadStatus?.appId === game.appId
                  ? packageDownloadStatus.phase === "saving" ? "Saving to Porthole storage…" : "Downloading package…"
                  : currentPackagePath ? "Download latest again" : "Download package to storage"}
              </Button>
              {packageDownloadStatus && (
                <div className="rounded-[7px] border border-white/[0.06] bg-black/20 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[9.5px] text-ink-faint">
                      {packageDownloadStatus.phase === "saving"
                        ? "Writing archive to Porthole storage"
                        : `Downloading ${packageDownloadStatus.title}`}
                    </span>
                    <div className="flex flex-none items-center gap-2">
                      <span className="font-mono text-[9px] text-ink-ghost">
                        {formatBytes(packageDownloadStatus.receivedBytes)}
                        {packageDownloadStatus.totalBytes !== null ? ` / ${formatBytes(packageDownloadStatus.totalBytes)}` : ""}
                      </span>
                      {packageDownloadStatus.phase === "downloading" && (
                        <Button variant="ghost" size="xs" icon={X} aria-label="Cancel package download" onClick={onCancelDownload} />
                      )}
                    </div>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.08]">
                    <div
                      className="h-full rounded-full bg-accent transition-[width]"
                      style={{
                        width: packageDownloadStatus.phase === "saving"
                          ? "100%"
                          : packageDownloadStatus.totalBytes
                            ? `${Math.min(100, (packageDownloadStatus.receivedBytes / packageDownloadStatus.totalBytes) * 100)}%`
                            : "35%",
                      }}
                    />
                  </div>
                </div>
              )}
              {packageDownloadDisabledReason && !packageDownloadStatus && (
                <p className="text-[9px] leading-relaxed text-ink-ghost">{packageDownloadDisabledReason}</p>
              )}
            </div>
          )}

          {inLibrary ? (
            <>
              <Button
                variant={game.chocolateyPackageId ? "secondary" : "primary"}
                size="md"
                fullWidth
                icon={Play}
                onClick={onLaunch}
                title="Select this Emulator profile. Missing executable/data files will be identified before launch."
              >
                {game.appId === "freedoom"
                  ? "Open game data profile"
                  : /\.exe$/i.test(game.exePath)
                    ? "Open Emulator profile"
                    : "Open Emulator"}
              </Button>
              <div className="flex gap-2">
                <Button variant="danger" size="sm" icon={Trash2} onClick={onRemove} className="flex-1">
                  Remove from library
                </Button>
                <Button variant="ghost" size="sm" icon={ScrollText} onClick={onToggleLogs} aria-pressed={logsOpen} className="flex-1">
                  Console
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant={game.chocolateyPackageId ? "secondary" : "primary"}
                size="sm"
                icon={BookmarkPlus}
                onClick={onAdd}
                className="flex-1"
              >
                Add to library
              </Button>
              <Button variant="ghost" size="sm" icon={ScrollText} onClick={onToggleLogs}>
                Console
              </Button>
            </div>
          )}
          {!inLibrary && (
            <span className="flex items-center gap-1.5 text-[9px] text-ink-ghost">
              <BookmarkCheck size={10} aria-hidden />
              Library membership is separate from package downloads.
            </span>
          )}
        </div>
      </footer>
    </aside>
  );
}
