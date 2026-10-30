import type { WallpaperId } from "@/store/uiStore";
import { cn } from "@/lib/cn";
import styles from "@/styles/wallpaper.module.css";

interface WallpaperProps {
  variant: WallpaperId;
}

const AURORA_URL = `${import.meta.env.BASE_URL}wallpapers/cachy-aurora.png`;

/**
 * Wallpaper stack. The generated aurora plate is preloaded in index.html; the two
 * procedural variants cost nothing and prove the shell works without assets.
 * Pure CSS motion (two blurred blobs) — no JS on the frame path.
 */
export function Wallpaper({ variant }: WallpaperProps) {
  const isAurora = variant === "cachy-aurora";

  return (
    <div className={styles.root} aria-hidden>
      <div
        className={cn(
          styles.image,
          variant === "nebula" && styles.nebula,
          variant === "minimal" && styles.minimal,
        )}
        style={isAurora ? { backgroundImage: `url("${AURORA_URL}")` } : undefined}
      />
      {!isAurora && (
        <>
          <div className={cn(styles.blob, styles.blobCyan)} />
          <div className={cn(styles.blob, styles.blobViolet)} />
        </>
      )}
      <div className={styles.grid} />
      <div className={styles.veil} />
      <div className={styles.grain} />
    </div>
  );
}
