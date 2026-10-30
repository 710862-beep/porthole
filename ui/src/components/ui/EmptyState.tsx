import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-[12px] border border-dashed border-white/[0.09] bg-white/[0.015] px-8 py-10 text-center",
        className,
      )}
    >
      <span className="grid h-11 w-11 place-items-center rounded-[12px] border border-white/[0.08] bg-white/[0.04] text-ink-faint">
        <Icon size={19} aria-hidden />
      </span>
      <h3 className="mt-3.5 text-[13px] font-medium text-ink">{title}</h3>
      <p className="mt-1.5 max-w-[38ch] text-[11.5px] leading-relaxed text-ink-faint">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
