import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertOctagon, RefreshCw, Trash2 } from "lucide-react";

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last-resort shell crash screen. Two real actions: reload, or reset persisted
 * shell state and reload. Never a white screen, never a native dialog.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[porthole] shell crashed", error, info.componentStack);
  }

  private reload = (): void => {
    window.location.reload();
  };

  private resetShell = (): void => {
    try {
      localStorage.removeItem("porthole.ui.windows.v2");
      localStorage.removeItem("porthole.ui.preferences.v2");
    } catch {
      /* storage may be blocked; reload still happens */
    }
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid h-full w-full place-items-center bg-[#0b0b14] p-6">
        <div className="w-full max-w-[560px] rounded-[16px] border border-danger/25 bg-[#11111b]/90 p-7 shadow-dialog">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-[10px] border border-danger/30 bg-danger/10 text-danger">
              <AlertOctagon size={18} aria-hidden />
            </span>
            <div>
              <h1 className="text-[15px] font-semibold text-ink">The desktop hit a fault</h1>
              <p className="text-[11.5px] text-ink-muted">
                A React surface crashed. Your files and library entries are untouched.
              </p>
            </div>
          </div>

          <pre className="selectable mt-5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-white/[0.08] bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-danger/90">
            {error.stack ?? error.message}
          </pre>

          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={this.resetShell}
              className="inline-flex h-9 items-center gap-2 rounded-control border border-white/10 bg-white/[0.05] px-3.5 text-xs font-medium text-ink-muted transition hover:bg-white/[0.09] hover:text-ink"
            >
              <Trash2 size={14} aria-hidden />
              Reset shell state
            </button>
            <button
              type="button"
              onClick={this.reload}
              className="inline-flex h-9 items-center gap-2 rounded-control bg-accent px-3.5 text-xs font-semibold text-[#06131b] shadow-glow-sm transition hover:brightness-110"
            >
              <RefreshCw size={14} aria-hidden />
              Reload desktop
            </button>
          </div>
        </div>
      </div>
    );
  }
}
