import { useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  Info,
  Play,
  ScrollText,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { InstallProgress, StoreGame } from "@runtime/types";
import { AppIcon } from "@/components/ui/AppIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { copyText } from "@/lib/clipboard";
import { shortHash } from "@/lib/format";
import { toast } from "@/store/uiStore";
import { cn } from "@/lib/cn";
import { coverStyle } from "./cover";
import { InstallProgress as InstallProgressView } from "./InstallProgress";

interface GameDetailsProps {
  game: StoreGame;
  progress: InstallProgress | undefined;
  logsOpen: boolean;
  onInstall: () => void;
  onLaunch: () => void;
  onUninstall: () => void;
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

/** Right-hand detail pane: evidence-first metadata, install/launch/uninstall. */
export function GameDetails({
  game,
  progress,
  logsOpen,
  onInstall,
  onLaunch,
  onUninstall,
  onToggleLogs,
}: GameDetailsProps) {
  const [copied, setCopied] = useState(false);
  const cover = coverStyle(game.appId);
  const Icon = cover.icon;
  const installed = game.status === "installed";
  const installing = Boolean(
    progress && progress.phase !== "complete" && progress.phase !== "failed",
  );

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
            {installed ? (
              <Badge tone="success" dot>
                installed
              </Badge>
            ) : (
              <Badge tone="neutral" dot>
                not installed
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

        {progress && (
          <div className="mt-3.5">
            <InstallProgressView progress={progress} />
          </div>
        )}

        <div className="mt-4 rounded-[9px] border border-white/[0.07] bg-black/20 px-3 py-1">
          <MetaRow label="Version">{game.version}</MetaRow>
          <MetaRow label="Genre">{game.genre}</MetaRow>
          <MetaRow label="Entry point">
            <span className="font-mono text-[10px]">{game.exePath || "shell surface"}</span>
          </MetaRow>
          <MetaRow label="Location">Porthole library</MetaRow>
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
        {installed ? (
          <div className="flex flex-col gap-2">
            <Button variant="primary" size="md" fullWidth icon={Play} onClick={onLaunch}>
              Launch
            </Button>
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                icon={Trash2}
                onClick={onUninstall}
                className="flex-1"
              >
                Uninstall
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={ScrollText}
                onClick={onToggleLogs}
                aria-pressed={logsOpen}
                className="flex-1"
              >
                Console
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              size="md"
              fullWidth
              icon={installing ? undefined : Download}
              loading={installing}
              disabled={installing}
              onClick={onInstall}
            >
              {installing ? `Installing ${Math.round(progress?.percent ?? 0)}%` : "Install"}
            </Button>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[9.5px] text-ink-ghost">
                <CheckCircle2 size={10} aria-hidden />
                Registers a library entry · no download
              </span>
              <Button variant="ghost" size="xs" icon={ScrollText} onClick={onToggleLogs}>
                Console
              </Button>
            </div>
          </div>
        )}
      </footer>
    </aside>
  );
}
