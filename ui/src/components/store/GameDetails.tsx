import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
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
import type { EmbeddedGuestExecutable } from "@runtime/chocolateyInstaller";
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
  installerArchiveName: string | null;
  installerInspected: boolean;
  installerExecutables: EmbeddedGuestExecutable[];
  unsupportedExecutables: string[];
  installerInspectionError: string | null;
  skippedInstallerScripts: number;
  inspectingArchive: boolean;
  installerRunDisabledReason: string | null;
  installerRunBusy: boolean;
  installerArguments: string;
  canAddToLibrary: boolean;
  onBack: () => void;
  onAdd: () => void;
  onDownloadPackage: () => void;
  onCancelDownload: () => void;
  onInspectSavedArchive: () => void;
  onInstallerArgumentsChange: (value: string) => void;
  onRunEmbeddedInstaller: (executable: EmbeddedGuestExecutable, argumentsLine: string) => void;
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
  installerArchiveName,
  installerInspected,
  installerExecutables,
  unsupportedExecutables,
  installerInspectionError,
  skippedInstallerScripts,
  inspectingArchive,
  installerRunDisabledReason,
  installerRunBusy,
  installerArguments,
  canAddToLibrary,
  onBack,
  onAdd,
  onDownloadPackage,
  onCancelDownload,
  onInspectSavedArchive,
  onInstallerArgumentsChange,
  onRunEmbeddedInstaller,
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
    <section className="flex h-full min-h-0 w-full flex-col bg-[#171720]" aria-label={`${game.title} details`}>
      <div
        className="relative min-h-[220px] flex-none overflow-hidden border-b border-white/[0.07]"
        style={{ backgroundImage: cover.gradient }}
      >
        <div
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
            maskImage: "radial-gradient(ellipse 90% 80% at 30% 20%, black, transparent 80%)",
          }}
          aria-hidden
        />
        <Icon
          size={260}
          strokeWidth={0.55}
          className="absolute -bottom-16 right-[9%] opacity-[0.12]"
          style={{ color: cover.tint }}
          aria-hidden
        />
        <button
          type="button"
          onClick={onBack}
          className="absolute left-5 top-5 inline-flex h-8 items-center gap-2 rounded-full border border-white/[0.1] bg-black/25 px-3 text-[10px] font-medium text-ink-muted backdrop-blur transition hover:bg-black/45 hover:text-ink"
        >
          <ArrowLeft size={13} aria-hidden /> Back to store
        </button>
        <div className="absolute inset-x-6 bottom-5 max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <AppIcon icon={cover.icon} tint={cover.tint} size={36} iconSize={19} />
            <Badge tone={game.kind === "game" ? "accent" : game.kind === "system" ? "violet" : "neutral"}>
              {game.chocolateyPackageId ? "Chocolatey package" : game.kind}
            </Badge>
            {inLibrary ? (
              <Badge tone="success" dot>in Porthole library</Badge>
            ) : game.chocolateyPackageId ? (
              <Badge tone="neutral" dot>not installed</Badge>
            ) : (
              <Badge tone="neutral" dot>not in library</Badge>
            )}
          </div>
          <h2 className="mt-3 text-[24px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[30px]">
            {game.chocolatey?.title || game.title}
          </h2>
          <p className="mt-1 text-[11px] text-ink-faint">
            {game.chocolateyPackageId
              ? `Chocolatey Community Repository · ${game.chocolatey?.version ? `version ${game.chocolatey.version}` : "latest package"}`
              : `${game.genre} · Porthole catalog`}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8">
        <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]">
          <div className="min-w-0">
            <p className="text-[12px] leading-relaxed text-ink-muted">{game.chocolatey?.summary || game.summary}</p>

        <div className="mt-4 rounded-[9px] border border-white/[0.07] bg-black/20 px-3 py-1">
          <MetaRow label="Version">{game.chocolatey?.version || game.version}</MetaRow>
          <MetaRow label="Category">{game.genre}</MetaRow>
          {game.chocolateyPackageId && (
            <MetaRow label="Chocolatey ID">
              {game.chocolatey?.packageId ?? `${game.chocolateyPackageId} · metadata pending`}
            </MetaRow>
          )}
          {game.exePath && (
            <MetaRow label="Guest profile path">
              <span className="font-mono text-[10px]">{game.exePath}</span>
            </MetaRow>
          )}
          {game.requiredFiles?.length ? (
            <MetaRow label="Required files">
              {game.requiredFiles.map((file) => file.split("\\").at(-1) ?? file).join(", ")}
            </MetaRow>
          ) : null}
          <MetaRow label="Source">{game.chocolateyPackageId ? "Chocolatey Community Repository" : "Porthole catalog"}</MetaRow>
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
              One click downloads the Chocolatey .nupkg archive into PortholePackages/ in {storageLabel || "selected storage"}, separate from guest files. Downloading is not installing. The guest runner below can inspect direct x64 EXEs and launch one only after confirmation; PowerShell/command scripts, MSI packages, and external URLs are not executed.
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

        {game.chocolateyPackageId && (
          <section className="mt-3 rounded-[9px] border border-warning/20 bg-warning/[0.045] p-3" aria-label="Run embedded installer in guest">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-warning">
                  <Play size={11} aria-hidden />
                  Guest installer runner
                </p>
                <p className="mt-1.5 text-[10px] leading-relaxed text-ink-muted">
                  {installerArchiveName
                    ? `Inspect ${installerArchiveName} for directly embedded x64 Windows executables. Only the selected EXE and same-folder non-script files are copied to guest storage.`
                    : "Download and save a .nupkg archive before inspecting its embedded executable files."}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={ShieldCheck}
                loading={inspectingArchive}
                disabled={!installerArchiveName || inspectingArchive}
                onClick={onInspectSavedArchive}
                title="Read the saved ZIP archive only; do not execute package scripts or URLs."
              >
                {installerInspected ? "Inspect again" : "Inspect package"}
              </Button>
            </div>

            <label className="mt-3 block text-[9.5px] font-medium text-ink-faint" htmlFor="installer-arguments">
              Optional installer arguments (package-specific)
            </label>
            <input
              id="installer-arguments"
              value={installerArguments}
              onChange={(event) => onInstallerArgumentsChange(event.target.value)}
              placeholder="e.g. silent switches; leave blank to run as-is"
              className="mt-1 h-8 w-full rounded-[6px] border border-white/[0.08] bg-black/25 px-2 text-[10px] text-ink placeholder:text-ink-ghost focus:border-accent/40 focus:outline-none"
            />

            {inspectingArchive && <p className="mt-2 text-[9px] text-ink-faint">Checking bounded ZIP entries and locating PE32+ x64 executables…</p>}
            {installerInspectionError && <p role="alert" className="mt-2 text-[9.5px] text-warning">{installerInspectionError}</p>}
            {installerInspected && !installerInspectionError && installerExecutables.length === 0 && (
              <p className="mt-2 rounded-[6px] border border-white/[0.06] bg-black/20 p-2 text-[9.5px] leading-relaxed text-ink-faint">
                No directly embedded PE32+ x64 executable was found. {unsupportedExecutables.length > 0 ? `${unsupportedExecutables.length} other .exe file(s) are not x64 PE32+ and cannot be loaded.` : "This is likely a Chocolatey script wrapper, an MSI package, or a package that downloads its installer externally."} Porthole does not run those scripts, MSI packages, or external URLs.
              </p>
            )}
            {skippedInstallerScripts > 0 && (
              <p className="mt-2 text-[9px] text-ink-ghost">{skippedInstallerScripts} PowerShell/command script file(s) were excluded and will not be executed.</p>
            )}
            {installerExecutables.map((executable) => (
              <div key={executable.archivePath} className="mt-2 flex flex-wrap items-center gap-2 rounded-[7px] border border-white/[0.07] bg-black/20 p-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[10px] font-medium text-ink" title={executable.archivePath}>{executable.name}</p>
                  <p className="truncate font-mono text-[8.5px] text-ink-ghost" title={executable.archivePath}>{executable.archivePath} · {formatBytes(executable.sizeBytes)} · {executable.payload.length} guest file(s)</p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  icon={Play}
                  loading={installerRunBusy}
                  disabled={Boolean(installerRunDisabledReason) || installerRunBusy || inspectingArchive}
                  title={installerRunDisabledReason ?? "After confirmation, run only this embedded x64 EXE inside Porthole's Wasm guest."}
                  onClick={() => onRunEmbeddedInstaller(executable, installerArguments)}
                >
                  Run in Emulator
                </Button>
              </div>
            ))}
            {installerRunDisabledReason && installerInspected && installerExecutables.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[9px] text-ink-ghost">{installerRunDisabledReason}</p>
                <Button size="xs" variant="secondary" icon={Play} onClick={onLaunch}>Open Emulator</Button>
              </div>
            )}
            <p className="mt-2 text-[9px] leading-relaxed text-ink-ghost">
              Runs only inside the Porthole Wasm guest—not on the host. Input delivery is pending (KI-04); many interactive installers cannot complete. Porthole persists guest file writes within its bounded C: virtual filesystem when the process exits. A launched installer is not proof of a successful or complete installation.
            </p>
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

          <aside className="h-fit rounded-[12px] border border-white/[0.08] bg-gradient-to-b from-white/[0.045] to-black/20 p-4 lg:sticky lg:top-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Package status</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-[9px] border border-white/[0.08] bg-black/20 text-accent">
                <HardDrive size={16} aria-hidden />
              </span>
              <div>
                <p className="text-[11px] font-medium text-ink">{currentPackagePath || downloadedPackagePaths.length > 0 ? "Archive saved" : "Not installed"}</p>
                <p className="mt-0.5 text-[9.5px] text-ink-faint">{game.chocolateyPackageId ? "Chocolatey package" : "Porthole catalog entry"}</p>
              </div>
            </div>
            <div className="mt-3 rounded-[8px] border border-white/[0.06] bg-black/20 p-3">
              <p className="text-[10px] font-semibold text-ink-muted">What the button does</p>
              <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
                {game.chocolateyPackageId
                  ? "Download saves the .nupkg archive. A separate, explicitly confirmed action may run a directly embedded PE32+ x64 EXE inside the Wasm guest; it never runs on the host. Package scripts, MSI installers, and vendor URLs are not followed."
                  : "This catalog entry is a profile or bookmark. It does not fetch an executable unless a package source is listed above."}
              </p>
            </div>
            <div className="mt-3 flex gap-2 rounded-[8px] border border-warning/15 bg-warning/[0.045] p-3">
              <ShieldCheck size={12} className="mt-0.5 flex-none text-warning" aria-hidden />
              <p className="text-[9.5px] leading-relaxed text-ink-faint">
                Downloading is not installing. The guest runner supports only direct x64 EXEs; installer success depends on guest API support, required services, and input forwarding.
              </p>
            </div>
          </aside>
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
                  : currentPackagePath ? "Download latest again" : "Download package"}
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
          ) : canAddToLibrary ? (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={BookmarkPlus}
                onClick={onAdd}
                className="flex-1"
              >
                Save listing
              </Button>
              <Button variant="ghost" size="sm" icon={ScrollText} onClick={onToggleLogs}>
                Console
              </Button>
            </div>
          ) : game.chocolateyPackageId ? (
            <p className="rounded-[7px] border border-white/[0.06] bg-black/15 p-2.5 text-[10px] leading-relaxed text-ink-faint">
              This is a live Chocolatey search result. It can be downloaded as an archive; it is not installed or verified to run in Porthole.
            </p>
          ) : null}
          {!inLibrary && canAddToLibrary && (
            <span className="flex items-center gap-1.5 text-[9px] text-ink-ghost">
              <BookmarkCheck size={10} aria-hidden />
              Saving a listing is separate from downloading a package.
            </span>
          )}
        </div>
      </footer>
    </section>
  );
}
