import type { WallpaperId } from "@/store/uiStore";
import { cn } from "@/lib/cn";
import styles from "@/styles/wallpaper.module.css";

interface WallpaperProps {
  variant: WallpaperId;
}

/** Unlettered local Aurora backdrop with procedural wallpaper alternatives. */
export function Wallpaper({ variant }: WallpaperProps) {
  const isAurora = variant === "aurora";

  return (
    <div className={styles.root} aria-hidden>
      <div
        className={cn(
          styles.image,
          isAurora && styles.aurora,
          variant === "nebula" && styles.nebula,
          variant === "minimal" && styles.minimal,
        )}
      />
      {!isAurora && (
        <>
          <div className={cn(styles.blob, styles.blobCyan)} />
          <div className={cn(styles.blob, styles.blobViolet)} />
          <div className={styles.grid} />
          <div className={styles.veil} />
          <div className={styles.grain} />
        </>
      )}
    </div>
  );
}
