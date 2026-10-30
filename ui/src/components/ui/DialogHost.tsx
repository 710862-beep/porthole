import { useEffect, useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  Check,
  Copy,
  HelpCircle,
  Info,
} from "lucide-react";
import { useDialogStore } from "@/store/dialogStore";
import { copyText } from "@/lib/clipboard";
import { Button } from "./Button";
import { Modal, type ModalTone } from "./Modal";

/**
 * Renders whichever custom dialog is active. Mounted once at the root, above the
 * desktop, so every feature can await `confirmAction()/reportError()` promises.
 */
export function DialogHost() {
  const active = useDialogStore((state) => state.active);
  const settle = useDialogStore((state) => state.settle);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [active?.id]);

  if (!active) {
    return null;
  }

  const isConfirm = active.variant === "confirm";
  const tone: ModalTone = active.variant === "error" || active.danger ? "danger" : "accent";
  const Icon =
    active.variant === "error"
      ? AlertOctagon
      : active.variant === "confirm"
        ? HelpCircle
        : active.danger
          ? AlertTriangle
          : Info;

  const close = (): void => settle(active.id, false);
  const confirm = (): void => settle(active.id, true);

  const handleCopy = async (): Promise<void> => {
    if (!active.details) return;
    const ok = await copyText(active.details);
    setCopied(ok);
  };

  const footer = isConfirm ? (
    <>
      <Button variant="ghost" onClick={close}>
        {active.cancelLabel}
      </Button>
      <Button
        variant={active.danger ? "danger" : "primary"}
        onClick={confirm}
        autoFocus={false}
      >
        {active.confirmLabel}
      </Button>
    </>
  ) : (
    <Button variant={active.danger ? "danger" : "primary"} onClick={confirm}>
      {active.confirmLabel}
    </Button>
  );

  return (
    <Modal
      open
      onClose={close}
      title={active.title}
      description={active.body}
      icon={Icon}
      tone={tone}
      width={active.details ? 660 : 520}
      footer={footer}
    >
      {active.details && (
        <div className="overflow-hidden rounded-[10px] border border-white/[0.08] bg-black/40">
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              details
            </span>
            <Button
              size="xs"
              variant="ghost"
              icon={copied ? Check : Copy}
              onClick={() => {
                void handleCopy();
              }}
              className={copied ? "text-success" : undefined}
            >
              {copied ? "Copied" : "Copy to clipboard"}
            </Button>
          </div>
          <pre className="selectable max-h-44 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink-muted">
            {active.details}
          </pre>
        </div>
      )}
    </Modal>
  );
}
