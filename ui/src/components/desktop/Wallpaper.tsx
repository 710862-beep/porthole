import type { WallpaperId } from "@/store/uiStore";
import { cn } from "@/lib/cn";
import styles from "@/styles/wallpaper.module.css";

interface WallpaperProps {
  variant: WallpaperId;
}

/**
 * CachyOS-review inspired wallpaper: layered magenta/violet planes, a faceted
 * teal mark, and oversized editorial lettering. Procedural alternatives remain
 * available in Settings; no screenshot or fake system output is baked in.
 */
export function Wallpaper({ variant }: WallpaperProps) {
  const isReview = variant === "cachy-aurora";

  return (
    <div className={styles.root} aria-hidden>
      <div
        className={cn(
          styles.image,
          isReview && styles.cachyReview,
          variant === "nebula" && styles.nebula,
          variant === "minimal" && styles.minimal,
        )}
      />
      {isReview ? (
        <div className={styles.reviewArt}>
          <svg className={styles.reviewLogo} viewBox="0 0 460 380" fill="none">
            <path d="M132 18H390L334 92H164L92 184L164 286H334L390 212H452L358 362H132L16 184L132 18Z" fill="#00A98D" />
            <path d="M132 18L224 92H164L92 184H16L132 18Z" fill="#00C7D5" />
            <path d="M164 92H334L224 184L92 184L164 92Z" fill="#03B49C" />
            <path d="M92 184L224 184L164 286L132 286L92 184Z" fill="#008F8B" />
            <path d="M224 184H452L390 212H334L224 184Z" fill="#09BED0" />
            <path d="M224 184L334 286H164L224 184Z" fill="#00AA98" />
            <path d="M334 92L390 18L224 184L334 92Z" fill="#06C3A4" />
            <path d="M334 286L390 212L358 362L224 286H334Z" fill="#007E83" />
          </svg>
          <div className={styles.reviewTitle}>
            <p className={styles.reviewName}>CACHY OS</p>
            <p className={styles.reviewLine}>INSTALACION</p>
            <p className={styles.reviewLine}>REVIEW</p>
          </div>
        </div>
      ) : (
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
