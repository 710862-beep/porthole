import {
  BookOpen,
  Cpu,
  ExternalLink,
  Gamepad2,
  LayoutGrid,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useUiStore } from "@/store/uiStore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { PortholeMark } from "@/components/ui/PortholeMark";

const STACK = ["React 19", "TypeScript", "Tailwind CSS", "CSS Modules", "Zustand", "Framer Motion"];

const REPO = "https://github.com/710862-beep/porthole";

/** About window: product framing plus the honest limits, no marketing claims. */
export function WelcomeApp() {
  const { openApp } = useWindowManager();
  const openOverview = useUiStore((state) => state.openOverview);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-[#12121c]">
      <div className="relative flex-none overflow-hidden border-b border-white/[0.07] px-5 py-5">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 55% 90% at 12% 0%, rgb(var(--accent-rgb) / 0.16), transparent 62%), radial-gradient(ellipse 55% 90% at 90% 20%, rgba(179,136,255,0.15), transparent 62%)",
          }}
          aria-hidden
        />
        <div className="relative flex items-start gap-3.5">
          <span className="grid h-12 w-12 flex-none place-items-center rounded-[13px] border border-white/[0.1] bg-white/[0.04] shadow-glow-sm">
            <PortholeMark size={30} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
                Welcome to Porthole
              </h1>
              <Badge tone="accent">desktop 0.5.0</Badge>
              <Badge tone="warning" dot>
                mock runtime
              </Badge>
            </div>
            <p className="mt-1 max-w-[62ch] text-[11.5px] leading-relaxed text-ink-muted">
              A CachyOS-flavoured desktop environment running entirely in your browser, built as
              the shell for the Porthole x86-64 runtime. This window is the honest tour.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {STACK.map((item) => (
                <span
                  key={item}
                  className="rounded-full border border-white/[0.08] bg-white/[0.035] px-2 py-0.5 font-mono text-[9px] text-ink-muted"
                >
                  {item}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 px-5 py-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-[11px] border border-white/[0.07] bg-white/[0.022] p-3.5">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              <Sparkles size={11} className="text-accent" aria-hidden />
              What you can do
            </p>
            <ul className="mt-2 flex flex-col gap-2 text-[10.5px] leading-relaxed text-ink-muted">
              <li className="flex gap-2">
                <Gamepad2 size={12} className="mt-0.5 flex-none text-violet" aria-hidden />
                Browse the library, install entries, open the labelled emulator and inspect
                telemetry.
              </li>
              <li className="flex gap-2">
                <LayoutGrid size={12} className="mt-0.5 flex-none text-accent" aria-hidden />
                Multi-task with four workspaces, the Overview and the top-left hot corner.
              </li>
              <li className="flex gap-2">
                <Terminal size={12} className="mt-0.5 flex-none text-mint" aria-hidden />
                Drive the shell from the terminal app — including installs and window commands.
              </li>
            </ul>
          </div>

          <div className="rounded-[11px] border border-white/[0.07] bg-white/[0.022] p-3.5">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              <ShieldCheck size={11} className="text-success" aria-hidden />
              What this is not
            </p>
            <ul className="mt-2 flex flex-col gap-1.5 text-[10.5px] leading-relaxed text-ink-muted">
              <li>Not a Windows kernel, BIOS or OS image.</li>
              <li>Not a compatibility claim: the store is mock-driven today.</li>
              <li>No game bytes are downloaded by this shell.</li>
              <li>
                Guest input forwarding is pending (KI-04) — keystrokes are counted, not delivered.
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-3 rounded-[11px] border border-white/[0.07] bg-white/[0.022] p-3.5">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            <Cpu size={11} className="text-violet" aria-hidden />
            Architecture in one breath
          </p>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-muted">
            The UI lives in <code className="font-mono text-ink">ui/</code> and talks only to{" "}
            <code className="font-mono text-ink">ui/runtime/contracts.ts</code>. The emulator core
            lives in <code className="font-mono text-ink">rust/porthole-x64-wasm</code> and is reached
            through the platform layer. The only pixels ever labelled &ldquo;the guest frame&rdquo;
            come from <code className="font-mono text-ink">guest_frame_rgba()</code> after a present.
          </p>
        </div>

        <div className="mt-3 rounded-[11px] border border-white/[0.07] bg-white/[0.022] p-3.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Try these
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10.5px] text-ink-muted">
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
              Right-click a titlebar → window menu
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" icon={Gamepad2} onClick={() => openApp("store")}>
              Open Game Store
            </Button>
            <Button size="sm" variant="secondary" icon={Terminal} onClick={() => openApp("terminal")}>
              Terminal
            </Button>
            <Button size="sm" variant="ghost" icon={LayoutGrid} onClick={openOverview}>
              Overview
            </Button>
            <Button size="sm" variant="ghost" icon={Cpu} onClick={() => openApp("system")}>
              System Monitor
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-white/10 bg-white/[0.05] px-3 text-[11px] text-ink-muted transition hover:bg-white/[0.09] hover:text-ink"
          >
            <ExternalLink size={12} aria-hidden />
            Repository
          </a>
          <a
            href={`${REPO}/blob/main/docs/FINAL-STATUS-REPORT.md`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-white/10 bg-white/[0.05] px-3 text-[11px] text-ink-muted transition hover:bg-white/[0.09] hover:text-ink"
          >
            <BookOpen size={12} aria-hidden />
            Evidence report
          </a>
          <a
            href={`${REPO}/blob/main/ui/README.md`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-white/10 bg-white/[0.05] px-3 text-[11px] text-ink-muted transition hover:bg-white/[0.09] hover:text-ink"
          >
            <BookOpen size={12} aria-hidden />
            UI handbook
          </a>
        </div>
      </div>

      <footer className="flex flex-none items-center justify-between gap-3 border-t border-white/[0.07] bg-black/20 px-5 py-2">
        <span className="font-mono text-[9px] text-ink-ghost">
          ui/components/apps · consumed through contracts only
        </span>
        <span className="font-mono text-[9px] text-ink-ghost">CachyOS-inspired · dark</span>
      </footer>
    </div>
  );
}
