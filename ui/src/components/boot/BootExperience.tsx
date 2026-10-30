import type { RuntimeMode, StorageProbe } from "@runtime/types";
import { BootScreen } from "./BootScreen";
import { SetupModal } from "./SetupModal";

interface BootExperienceProps {
  phase: "boot" | "setup" | "starting";
  stage: number;
  storageLabel: string;
  mode: RuntimeMode;
  probes: StorageProbe[] | null;
  busy: boolean;
  error: string | null;
  onNvme: () => void;
  onOpfs: () => void;
  onMemory: () => void;
}

const AURORA_URL = `${import.meta.env.BASE_URL}wallpapers/cachy-aurora.png`;

/**
 * Cold-start surface: aurora backdrop + either the boot/starting screen or the
 * first-run storage modal. Nothing here renders the desktop prematurely.
 */
export function BootExperience({
  phase,
  stage,
  storageLabel,
  mode,
  probes,
  busy,
  error,
  onNvme,
  onOpfs,
  onMemory,
}: BootExperienceProps) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-[#07070d]">
      <div
        className="absolute inset-0 scale-110 bg-cover bg-center"
        style={{ backgroundImage: `url("${AURORA_URL}")`, filter: "blur(18px) brightness(0.42)" }}
        aria-hidden
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 60% at 50% 30%, rgba(10,10,20,0.15), rgba(7,7,13,0.85) 78%)",
        }}
        aria-hidden
      />
      <div
        className="absolute inset-0 opacity-[0.25]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
        }}
        aria-hidden
      />
      <div className="absolute inset-0 opacity-[0.05] mix-blend-overlay" aria-hidden>
        <svg width="100%" height="100%">
          <filter id="boot-noise">
            <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch" />
          </filter>
          <rect width="100%" height="100%" filter="url(#boot-noise)" />
        </svg>
      </div>

      {phase === "setup" ? (
        <SetupModal
          probes={probes}
          busy={busy}
          error={error}
          mode={mode}
          onNvme={onNvme}
          onOpfs={onOpfs}
          onMemory={onMemory}
        />
      ) : (
        <BootScreen
          variant={phase === "starting" ? "starting" : "boot"}
          stage={stage}
          storageLabel={storageLabel}
          mode={mode}
        />
      )}
    </div>
  );
}
