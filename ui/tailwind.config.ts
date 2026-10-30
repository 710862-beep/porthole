import type { Config } from "tailwindcss";

/**
 * Porthole design tokens — "CachyOS" dark surface system.
 *
 * The palette is Catppuccin-Mocha-shaped (the wallpaper, panels and text ramp of
 * modern KDE Plasma). Accents are resolved through CSS variables so Settings can
 * re-theme the whole shell at runtime without Tailwind's JIT needing new classes:
 *   --accent-rgb      live accent (cyan by default)
 *   --accent-2-rgb    companion accent used in gradients
 *
 * Panels are radius 0 (flush to the screen), windows 12px, controls 8px.
 */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}", "./runtime/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        crust: "#11111b",
        mantle: "#181825",
        base: "#1e1e2e",
        surface: {
          DEFAULT: "#313244",
          high: "#45475a",
          higher: "#585b70",
        },
        overlay: {
          DEFAULT: "#6c7086",
          light: "#7f849c",
        },
        ink: {
          DEFAULT: "#cdd6f4",
          muted: "#a6adc8",
          faint: "#7f849c",
          ghost: "#585b70",
        },
        cyan: "#00e5ff",
        violet: "#b388ff",
        pink: "#f5a9e0",
        mint: "#94e2d5",
        success: "#a6e3a1",
        warning: "#f9e2af",
        danger: "#f38ba8",
        info: "#89b4fa",
        accent: {
          DEFAULT: "rgb(var(--accent-rgb) / <alpha-value>)",
          soft: "rgb(var(--accent-rgb) / 0.14)",
          line: "rgb(var(--accent-rgb) / 0.28)",
        },
        "accent-2": "rgb(var(--accent-2-rgb) / <alpha-value>)",
      },
      fontFamily: {
        sans: [
          "Inter Variable",
          "Inter",
          "SF Pro Display",
          "Segoe UI Variable",
          "Segoe UI",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono Variable",
          "JetBrains Mono",
          "Cascadia Code",
          "SFMono-Regular",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "0.875rem" }],
        "3xs": ["0.5625rem", { lineHeight: "0.75rem" }],
      },
      borderRadius: {
        window: "12px",
        control: "8px",
        panel: "0px",
        card: "10px",
        menu: "14px",
        launcher: "18px",
      },
      boxShadow: {
        window:
          "0 10px 30px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.35)",
        "window-focus":
          "0 26px 70px -14px rgba(0, 0, 0, 0.78), 0 0 0 1px rgb(var(--accent-rgb) / 0.16), 0 0 42px -18px rgb(var(--accent-rgb) / 0.45)",
        panel:
          "0 -14px 40px -12px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
        launcher:
          "0 32px 90px -24px rgba(0, 0, 0, 0.9), 0 8px 24px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.07)",
        dialog:
          "0 30px 80px -24px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.06)",
        glow: "0 0 24px rgb(var(--accent-rgb) / 0.35)",
        "glow-sm": "0 0 12px rgb(var(--accent-rgb) / 0.45)",
        "glow-violet": "0 0 28px rgba(179, 136, 255, 0.35)",
        hairline: "inset 0 0 0 1px rgba(255, 255, 255, 0.06)",
        "inset-top": "inset 0 1px 0 rgba(255, 255, 255, 0.06)",
      },
      backgroundImage: {
        aurora:
          "radial-gradient(ellipse 60% 45% at 18% 8%, rgba(0, 229, 255, 0.13), transparent 70%), radial-gradient(ellipse 50% 40% at 82% 12%, rgba(179, 136, 255, 0.16), transparent 72%), radial-gradient(ellipse 70% 50% at 50% 110%, rgba(24, 24, 37, 0.9), transparent 70%)",
        "accent-gradient":
          "linear-gradient(135deg, rgb(var(--accent-rgb)) 0%, rgb(var(--accent-2-rgb)) 100%)",
        "glass-sheen":
          "linear-gradient(160deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.015) 38%, rgba(255, 255, 255, 0) 62%)",
        grid: "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)",
        scanlines:
          "repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.22) 0px, rgba(0, 0, 0, 0.22) 1px, transparent 1px, transparent 3px)",
      },
      backgroundSize: {
        grid: "44px 44px",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.965)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1", boxShadow: "0 0 8px rgb(var(--accent-rgb) / 0.8)" },
          "50%": { opacity: "0.55", boxShadow: "0 0 3px rgb(var(--accent-rgb) / 0.3)" },
        },
        "aurora-drift": {
          "0%, 100%": { transform: "translate3d(-3%, -2%, 0) scale(1.04) rotate(0deg)" },
          "50%": { transform: "translate3d(3%, 2%, 0) scale(1.1) rotate(1.5deg)" },
        },
        "float-slow": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-8px)" },
        },
        scan: {
          from: { transform: "translateY(-100%)" },
          to: { transform: "translateY(100%)" },
        },
        "caret-blink": {
          "0%, 45%": { opacity: "1" },
          "50%, 95%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "spin-slow": {
          to: { transform: "rotate(360deg)" },
        },
        "boot-sweep": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(300%)" },
        },
        "toast-in": {
          from: { opacity: "0", transform: "translateY(12px) scale(0.97)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "fade-up": "fade-up 260ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "scale-in": "scale-in 200ms cubic-bezier(0.22, 1, 0.36, 1) both",
        shimmer: "shimmer 2.2s linear infinite",
        "pulse-dot": "pulse-dot 2.6s ease-in-out infinite",
        "aurora-drift": "aurora-drift 32s ease-in-out infinite",
        "float-slow": "float-slow 9s ease-in-out infinite",
        scan: "scan 5.5s linear infinite",
        "caret-blink": "caret-blink 1.1s steps(1, end) infinite",
        "spin-slow": "spin-slow 1.4s linear infinite",
        "boot-sweep": "boot-sweep 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        "toast-in": "toast-in 240ms cubic-bezier(0.22, 1, 0.36, 1) both",
      },
      transitionTimingFunction: {
        kde: "cubic-bezier(0.22, 1, 0.36, 1)",
        snap: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      spacing: {
        13: "3.25rem",
        18: "4.5rem",
        22: "5.5rem",
        taskbar: "48px",
      },
      zIndex: {
        wallpaper: "0",
        windows: "20",
        overview: "40",
        taskbar: "50",
        launcher: "60",
        dialog: "80",
        toast: "90",
        lock: "95",
        boot: "100",
      },
      backdropBlur: {
        xs: "2px",
        panel: "18px",
        launcher: "28px",
      },
      screens: {
        desktop: "960px",
      },
    },
  },
  plugins: [],
} satisfies Config;
