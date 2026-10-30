import { create } from "zustand";
import type { ConfirmOptions } from "@runtime/types";

/*
 * Custom dialog service. Replaces window.confirm/alert everywhere (product rule).
 * Requests are queued in Zustand; promises resolve when <DialogHost/> closes them.
 * Esc / backdrop / close button resolve `false` for confirms and `true` for alerts.
 */

export type DialogVariant = "confirm" | "alert" | "error";

export interface DialogRequest {
  id: string;
  variant: DialogVariant;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  details?: string;
}

interface DialogStore {
  active: DialogRequest | null;
  queue: DialogRequest[];
  enqueue: (request: DialogRequest) => void;
  settle: (id: string, confirmed: boolean) => void;
  dismissAll: () => void;
}

const resolvers = new Map<string, (confirmed: boolean) => void>();
let sequence = 1;

function nextRequest(
  variant: DialogVariant,
  options: ConfirmOptions & { details?: string },
): DialogRequest {
  return {
    id: `dialog-${sequence++}`,
    variant,
    title: options.title,
    body: options.body,
    confirmLabel: options.confirmLabel ?? (variant === "confirm" ? "Yes" : "OK"),
    cancelLabel: options.cancelLabel ?? "No",
    danger: options.danger ?? variant === "error",
    details: options.details,
  };
}

export const useDialogStore = create<DialogStore>()((set) => ({
  active: null,
  queue: [],

  enqueue: (request) =>
    set((state) =>
      state.active ? { queue: [...state.queue, request] } : { active: request },
    ),

  settle: (id, confirmed) => {
    const resolver = resolvers.get(id);
    resolvers.delete(id);
    resolver?.(confirmed);
    set((state) => {
      if (state.active?.id !== id) {
        return { queue: state.queue.filter((request) => request.id !== id) };
      }
      const [next, ...rest] = state.queue;
      return { active: next ?? null, queue: rest };
    });
  },

  dismissAll: () => {
    set((state) => {
      for (const request of [state.active, ...state.queue]) {
        if (request) {
          resolvers.get(request.id)?.(request.variant !== "confirm");
          resolvers.delete(request.id);
        }
      }
      return { active: null, queue: [] };
    });
  },
}));

function request(
  variant: DialogVariant,
  options: ConfirmOptions & { details?: string },
): Promise<boolean> {
  const dialog = nextRequest(variant, options);
  return new Promise<boolean>((resolve) => {
    resolvers.set(dialog.id, resolve);
    useDialogStore.getState().enqueue(dialog);
  });
}

/** Yes/No dialog → resolves true for Yes, false for No/Esc/backdrop. */
export function confirmAction(
  options: ConfirmOptions & { details?: string },
): Promise<boolean> {
  return request("confirm", options);
}

/** Single-button information dialog. */
export function notifyAction(options: {
  title: string;
  body: string;
  details?: string;
  confirmLabel?: string;
}): Promise<boolean> {
  return request("alert", options);
}

/** Error dialog with a copyable log block. */
export function reportError(options: {
  title: string;
  body: string;
  details?: string;
}): Promise<boolean> {
  return request("error", options);
}
