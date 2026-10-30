import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  type LucideIcon,
} from "lucide-react";
import { useUiStore, type ToastTone } from "@/store/uiStore";
import { cn } from "@/lib/cn";
import { EASE_KDE } from "@/lib/motion";

const TONE: Record<
  ToastTone,
  { icon: LucideIcon; accent: string; bar: string }
> = {
  info: { icon: Info, accent: "text-info", bar: "bg-info" },
  success: { icon: CheckCircle2, accent: "text-success", bar: "bg-success" },
  warning: { icon: AlertTriangle, accent: "text-warning", bar: "bg-warning" },
  danger: { icon: AlertOctagon, accent: "text-danger", bar: "bg-danger" },
};

/** KDE-like notification stack, portalled above every surface. */
export function ToastHost() {
  const toasts = useUiStore((state) => state.toasts);
  const dismiss = useUiStore((state) => state.dismissToast);

  return createPortal(
    <div className="pointer-events-none fixed right-4 top-4 z-[90] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const tone = TONE[toast.tone];
          const Icon = tone.icon;
          return (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, x: 28, scale: 0.97 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 20, scale: 0.98 }}
              transition={{ duration: 0.24, ease: EASE_KDE }}
              className="pointer-events-auto relative overflow-hidden rounded-[12px] border border-white/[0.1] bg-[rgba(17,17,27,0.92)] p-3.5 pl-4 shadow-dialog backdrop-blur-2xl"
            >
              <span className={cn("absolute inset-y-0 left-0 w-[3px]", tone.bar)} aria-hidden />
              <div className="flex items-start gap-2.5">
                <Icon size={15} className={cn("mt-0.5 flex-none", tone.accent)} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium leading-snug text-ink">{toast.title}</p>
                  {toast.message && (
                    <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                      {toast.message}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  aria-label="Dismiss notification"
                  onClick={() => dismiss(toast.id)}
                  className="grid h-6 w-6 flex-none place-items-center rounded-[5px] text-ink-ghost transition hover:bg-white/[0.08] hover:text-ink"
                >
                  <X size={12} aria-hidden />
                </button>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
