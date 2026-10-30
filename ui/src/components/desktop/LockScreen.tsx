import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Lock, LogIn } from "lucide-react";
import { useClock } from "@/hooks/useClock";
import { useUiStore } from "@/store/uiStore";
import { PortholeMark } from "@/components/ui/PortholeMark";
import { Kbd } from "@/components/ui/Kbd";
import { EASE_KDE } from "@/lib/motion";

const AURORA_URL = `${import.meta.env.BASE_URL}wallpapers/cachy-aurora.png`;

/** Session lock. Any key / click on the button unlocks — local demo, no auth claimed. */
export function LockScreen() {
  const unlock = useUiStore((state) => state.unlock);
  const clock = useClock(true, true);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    buttonRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Enter" || event.key === " " || event.key === "Escape") {
        event.preventDefault();
        unlock();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [unlock]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: EASE_KDE }}
      className="fixed inset-0 z-[95] flex flex-col items-center justify-center overflow-hidden bg-[#07070d]"
      role="dialog"
      aria-modal="true"
      aria-label="Locked session"
    >
      <div
        className="absolute inset-0 scale-105 bg-cover bg-center"
        style={{ backgroundImage: `url("${AURORA_URL}")`, filter: "blur(26px) brightness(0.4)" }}
        aria-hidden
      />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_50%_40%,rgba(10,10,18,0.35),rgba(7,7,13,0.9))]" aria-hidden />

      <div className="relative z-10 flex flex-col items-center">
        <p className="font-mono text-[64px] font-extralight leading-none tracking-[-0.02em] tabular-nums text-[#eef2ff] drop-shadow-[0_12px_50px_rgba(0,0,0,0.6)]">
          {clock.time}
        </p>
        <p className="mt-2 text-[12px] text-ink-muted">
          {new Date(clock.iso).toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </p>

        <button
          ref={buttonRef}
          type="button"
          onClick={unlock}
          className="group mt-10 flex flex-col items-center gap-3 rounded-[16px] px-8 py-5 outline-none transition hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <span className="relative grid h-16 w-16 place-items-center rounded-full border border-white/[0.12] bg-white/[0.05] shadow-[0_10px_40px_rgba(0,0,0,0.55)] backdrop-blur-xl transition group-hover:border-accent/40">
            <PortholeMark size={34} />
            <span className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full border border-white/15 bg-[#11111b] text-ink-muted">
              <Lock size={11} aria-hidden />
            </span>
          </span>
          <span className="text-[12.5px] font-medium text-ink">porthole-user</span>
          <span className="flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.05] px-3 py-1 text-[10.5px] text-ink-muted transition group-hover:border-accent/35 group-hover:text-accent">
            <LogIn size={11} aria-hidden />
            Unlock session
          </span>
        </button>

        <p className="mt-8 flex items-center gap-2 text-[10px] text-ink-ghost">
          Press <Kbd>Enter</Kbd> or click to unlock · this demo has no authentication
        </p>
      </div>
    </motion.div>
  );
}
