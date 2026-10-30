import { useId } from "react";
import { cn } from "@/lib/cn";

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

/** KDE-flavoured switch. Renders as a settings row when a label is provided. */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  className,
}: SwitchProps) {
  const id = useId();

  const control = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={label ? `${id}-label` : undefined}
      aria-describedby={description ? `${id}-desc` : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] flex-none items-center rounded-full border p-[2px]",
        "transition-colors duration-200 ease-kde disabled:cursor-not-allowed disabled:opacity-40",
        checked
          ? "border-transparent bg-[linear-gradient(120deg,rgb(var(--accent-rgb)),rgb(var(--accent-2-rgb)))] shadow-glow-sm"
          : "border-white/10 bg-white/[0.08]",
      )}
    >
      <span
        className={cn(
          "block h-4 w-4 rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.5)] transition-transform duration-200 ease-kde",
          checked ? "translate-x-[16px] bg-[#081018]" : "translate-x-0 bg-[#cdd6f4]",
        )}
      />
    </button>
  );

  if (!label) return <span className={className}>{control}</span>;

  return (
    <div className={cn("flex items-start justify-between gap-6", className)}>
      <div className="min-w-0">
        <label
          id={`${id}-label`}
          htmlFor={id}
          className="block cursor-pointer text-[12.5px] font-medium text-ink"
        >
          {label}
        </label>
        {description && (
          <p id={`${id}-desc`} className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
            {description}
          </p>
        )}
      </div>
      {control}
    </div>
  );
}
