import { AnimatePresence, motion } from "framer-motion";
import { useUiStore } from "@/store/uiStore";
import { useHotCorner } from "@/hooks/useHotCorner";
import { AppLauncher } from "@/components/launcher/AppLauncher";
import { OverviewMode } from "@/components/launcher/OverviewMode";
import { WindowLayer } from "@/components/windows/WindowLayer";
import { EASE_KDE } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { HotCorner } from "./HotCorner";
import { LockScreen } from "./LockScreen";
import { RuntimeStatusWidget } from "./RuntimeStatusWidget";
import { Taskbar } from "./Taskbar";
import { Wallpaper } from "./Wallpaper";
import { WelcomeWidget } from "./WelcomeWidget";

/**
 * Desktop composition. Global shortcuts and the hot corner are armed here; every
 * overlay is rendered above the window layer with the documented z-order:
 * windows 20 → overview 40 → panel 50 → launcher 60 → dialogs 80 → toasts 90.
 */
export function Desktop() {
  const wallpaper = useUiStore((state) => state.wallpaper);
  const overviewOpen = useUiStore((state) => state.overviewOpen);
  const launcherOpen = useUiStore((state) => state.launcherOpen);
  const locked = useUiStore((state) => state.locked);

  useHotCorner();

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.45, ease: EASE_KDE }}
      className="relative h-full w-full overflow-hidden bg-mantle"
      aria-label="Porthole desktop"
    >
      <Wallpaper variant={wallpaper} />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[18px] bg-gradient-to-b from-black/40 to-transparent" />

      <div
        className={cn(
          "absolute inset-0 origin-center transition-[transform,opacity,filter] duration-300 ease-kde",
          overviewOpen && "pointer-events-none scale-[0.94] opacity-60 blur-[2px]",
        )}
      >
        <WelcomeWidget />
        <WindowLayer />
        <RuntimeStatusWidget />
      </div>

      <HotCorner />
      <Taskbar />

      <AnimatePresence>{launcherOpen && <AppLauncher />}</AnimatePresence>
      <AnimatePresence>{overviewOpen && <OverviewMode />}</AnimatePresence>
      <AnimatePresence>{locked && <LockScreen />}</AnimatePresence>
    </motion.main>
  );
}
