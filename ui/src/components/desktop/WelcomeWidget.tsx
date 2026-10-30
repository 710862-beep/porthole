import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, LayoutGrid, Store, Terminal } from "lucide-react";
import { useClock } from "@/hooks/useClock";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useUiStore } from "@/store/uiStore";
import { useWindowStore } from "@/store/windowStore";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { PortholeMark } from "@/components/ui/PortholeMark";
import { EASE_KDE } from "@/lib/motion";

/**
 * Desktop greeting, shown while no window is open. It doubles as the shell's
 * self-documentation: real actions, real shortcut hints, no fake status.
 */
export function WelcomeWidget() {
  const openWindows = useWindowStore((state) => state.order.length);
  const clock = useClock(true, false);
  const { openApp } = useWindowManager();
  const openOverview = useUiStore((state) => state.openOverview);

  return (
    <AnimatePresence>
      {openWindows === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.32, ease: EASE_KDE }}
          className="pointer-events-none absolute inset-x-0 top-[15%] z-10 flex justify-center px-6"
        >
          <div className="pointer-events-auto flex w-full max-w-[540px] flex-col items-center text-center">
            <div className="flex items-center gap-2.5">
              <PortholeMark size={26} />
              <span className="text-[11px] font-semibold uppercase tracking-[0.32em] text-ink-muted">
                Porthole
              </span>
            </div>

            <div className="mt-5 text-[64px] font-extralight leading-none tracking-[-0.045em] text-[#e9edff] drop-shadow-[0_10px_40px_rgba(0,0,0,0.55)]">
              {clock.time}
            </div>
            <p className="mt-2 text-[12.5px] text-ink-muted">{clock.date}</p>

            <h1 className="mt-8 text-[20px] font-semibold tracking-[-0.02em] text-ink">
              A Linux desktop for a browser runtime
            </h1>
            <p className="mt-2 max-w-[46ch] text-[12.5px] leading-relaxed text-ink-muted">
              CachyOS-flavoured shell over the Porthole x86-64 core. The runtime is the
              labelled mock today; every evidence string comes from this repository&apos;s CI.
            </p>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
              <Button variant="primary" size="md" icon={Store} onClick={() => openApp("store")}>
                Open Game Store
                <ArrowRight size={13} aria-hidden />
              </Button>
              <Button variant="secondary" size="md" icon={Terminal} onClick={() => openApp("terminal")}>
                Terminal
              </Button>
              <Button variant="ghost" size="md" icon={LayoutGrid} onClick={openOverview}>
                Overview
              </Button>
            </div>

            <div className="mt-9 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[10.5px] text-ink-faint">
              <span className="flex items-center gap-1.5">
                <Kbd>Super</Kbd> Overview
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>Super</Kbd>
                <Kbd>E</Kbd> Launcher
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>Super</Kbd>
                <Kbd>L</Kbd> Lock
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>Esc</Kbd> Close overlay
              </span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
