import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X, type LucideIcon } from "lucide-react";
import styles from "@/styles/glass.module.css";
import { cn } from "@/lib/cn";
import { EASE_KDE } from "@/lib/motion";

export type ModalTone = "default" | "accent" | "danger" | "warning" | "success";

const TONE_TILE: Record<ModalTone, string> = {
  default: "border-white/10 bg-white/[0.055] text-ink-muted",
  accent: "border-accent/25 bg-accent/10 text-accent",
  danger: "border-danger/30 bg-danger/10 text-danger",
  warning: "border-warning/30 bg-warning/10 text-warning",
  success: "border-success/30 bg-success/10 text-success",
};

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  icon?: LucideIcon;
  tone?: ModalTone;
  width?: number;
  dismissible?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  hideHeader?: boolean;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Custom modal with a real focus trap, Escape/backdrop dismissal and
 * glass material. Portalled to <body> so window clipping never cuts a dialog.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  icon: Icon,
  tone = "default",
  width = 520,
  dismissible = true,
  children,
  footer,
  className,
  hideHeader = false,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement;
    const panel = panelRef.current;
    const focusables = (): HTMLElement[] =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];

    const first = focusables()[0] ?? panel;
    first?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) {
        event.preventDefault();
        return;
      }
      const firstItem = list[0];
      const lastItem = list[list.length - 1];
      if (!firstItem || !lastItem) return;
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [dismissible, onClose, open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-6">
          <motion.div
            className={cn(styles.backdrop, "absolute inset-0")}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE_KDE }}
            onClick={dismissible ? onClose : undefined}
            aria-hidden
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            style={{ width, maxWidth: "calc(100vw - 32px)" }}
            initial={{ opacity: 0, scale: 0.965, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.975, y: 8 }}
            transition={{ duration: 0.22, ease: EASE_KDE }}
            className={cn(
              styles.dialog,
              "z-10 flex max-h-[min(86vh,820px)] flex-col overflow-hidden outline-none",
              className,
            )}
          >
            {!hideHeader && (
              <header className="flex items-start gap-3.5 px-6 pb-4 pt-6">
                {Icon && (
                  <span
                    className={cn(
                      "grid h-10 w-10 flex-none place-items-center rounded-[10px] border",
                      TONE_TILE[tone],
                    )}
                  >
                    <Icon size={18} aria-hidden />
                  </span>
                )}
                <div className="min-w-0 flex-1 pt-0.5">
                  <h2 id={titleId} className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
                    {title}
                  </h2>
                  {description && (
                    <p
                      id={descriptionId}
                      className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted"
                    >
                      {description}
                    </p>
                  )}
                </div>
                {dismissible && (
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close dialog"
                    className="grid h-8 w-8 flex-none place-items-center rounded-control text-ink-faint transition hover:bg-white/[0.07] hover:text-ink"
                  >
                    <X size={15} aria-hidden />
                  </button>
                )}
              </header>
            )}

            {children && (
              <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 [scrollbar-gutter:stable]">
                {children}
              </div>
            )}

            {footer && (
              <footer className="flex items-center justify-end gap-2.5 border-t border-white/[0.07] bg-black/20 px-6 py-4">
                {footer}
              </footer>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
