import { Archive, Cpu, Gamepad2, Package, Radar, type LucideIcon } from "lucide-react";

/**
 * Placeholder cover art, generated from the app id. No external images, no
 * copyrighted box art — library identity comes from tint + icon + metadata.
 */

const PALETTES: ReadonlyArray<readonly [string, string]> = [
  ["#00e5ff", "#b388ff"],
  ["#94e2d5", "#89b4fa"],
  ["#f9e2af", "#fab387"],
  ["#f5a9e0", "#b388ff"],
  ["#89b4fa", "#74c7ec"],
  ["#a6e3a1", "#00e5ff"],
];

const ICONS: Record<string, LucideIcon> = {
  "chocolate-doom": Gamepad2,
  freedoom: Package,
  "7zip": Archive,
  "porthole-engine": Cpu,
  "gate4-probe": Radar,
};

function hash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(value);
}

export interface CoverStyle {
  icon: LucideIcon;
  gradient: string;
  tint: string;
}

export function coverStyle(appId: string): CoverStyle {
  const palette = PALETTES[hash(appId) % PALETTES.length] ?? PALETTES[0]!;
  const [primary, secondary] = palette;
  return {
    icon: ICONS[appId] ?? Package,
    tint: primary,
    gradient: [
      `radial-gradient(ellipse 90% 70% at 18% 0%, ${primary}3d, transparent 62%)`,
      `radial-gradient(ellipse 90% 80% at 100% 100%, ${secondary}2b, transparent 58%)`,
      "linear-gradient(160deg, #151523 0%, #0f0f19 100%)",
    ].join(", "),
  };
}
