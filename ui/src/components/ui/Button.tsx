import type { ButtonHTMLAttributes } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success" | "outline";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  trailingIcon?: LucideIcon;
  loading?: boolean;
  fullWidth?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-[#06131b] shadow-glow-sm hover:brightness-110 focus-visible:outline-accent",
  secondary:
    "border border-white/10 bg-white/[0.055] text-ink hover:border-white/20 hover:bg-white/[0.09]",
  ghost: "text-ink-muted hover:bg-white/[0.06] hover:text-ink",
  danger:
    "border border-danger/30 bg-danger/10 text-danger hover:border-danger/45 hover:bg-danger/20",
  success:
    "border border-success/30 bg-success/10 text-success hover:border-success/45 hover:bg-success/20",
  outline:
    "border border-accent/30 bg-accent/[0.06] text-accent hover:border-accent/50 hover:bg-accent/[0.12]",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: "h-7 gap-1.5 rounded-[6px] px-2.5 text-[11px]",
  sm: "h-8 gap-1.5 rounded-control px-3 text-xs",
  md: "h-9 gap-2 rounded-control px-3.5 text-[12.5px]",
  lg: "h-11 gap-2 rounded-[10px] px-5 text-sm",
  icon: "h-8 w-8 rounded-control p-0",
};

const ICON_SIZE: Record<ButtonSize, number> = {
  xs: 12,
  sm: 13,
  md: 14,
  lg: 16,
  icon: 15,
};

export function Button({
  variant = "secondary",
  size = "md",
  icon: Icon,
  trailingIcon: TrailingIcon,
  loading = false,
  fullWidth = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "relative inline-flex select-none items-center justify-center font-medium tracking-[-0.005em]",
        "transition-[background-color,border-color,color,box-shadow,filter,transform] duration-150 ease-kde",
        "active:scale-[0.975] disabled:pointer-events-none disabled:opacity-45",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        fullWidth && "w-full",
        className,
      )}
    >
      {loading ? (
        <Loader2 size={ICON_SIZE[size]} className="animate-spin" aria-hidden />
      ) : (
        Icon && <Icon size={ICON_SIZE[size]} aria-hidden />
      )}
      {children}
      {TrailingIcon && !loading && (
        <TrailingIcon size={ICON_SIZE[size]} className="opacity-70" aria-hidden />
      )}
    </button>
  );
}
