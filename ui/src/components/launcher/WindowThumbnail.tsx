import type { AppId } from "@/store/apps";
import { PortholeMark } from "@/components/ui/PortholeMark";

interface WindowThumbnailProps {
  appId: AppId;
  tint: string;
}

/**
 * Purpose-built miniature per app for Overview cards. These are illustrations of
 * the window's chrome/section — not screenshots, so they never fake guest output.
 */
export function WindowThumbnail({ appId, tint }: WindowThumbnailProps) {
  if (appId === "emulator") {
    return (
      <div className="absolute inset-0">
        <div
          className="absolute inset-[9%] overflow-hidden rounded-[5px] border border-white/[0.12]"
          style={{
            background:
              "radial-gradient(ellipse 60% 70% at 30% 20%, rgba(0,229,255,0.3), transparent 60%), radial-gradient(ellipse 60% 70% at 75% 70%, rgba(179,136,255,0.35), transparent 62%), #0b0b14",
            boxShadow: "inset 0 0 24px rgba(0,0,0,0.6)",
          }}
        >
          <div
            className="absolute inset-0 opacity-50"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg, rgba(0,0,0,0.3) 0 1px, transparent 1px 3px)",
            }}
          />
          <div
            className="absolute bottom-[12%] left-1/2 h-6 w-2/3 -translate-x-1/2 rounded-full blur-xl"
            style={{ background: tint, opacity: 0.5 }}
          />
          <span className="absolute bottom-1 left-1.5 font-mono text-[7px] uppercase tracking-[0.22em] text-white/45">
            scanout 240×135
          </span>
        </div>
      </div>
    );
  }

  if (appId === "store") {
    return (
      <div className="absolute inset-0 p-[10%]">
        <div className="grid h-full grid-cols-3 gap-1.5">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div
              key={index}
              className="rounded-[4px] border border-white/[0.07]"
              style={{
                background: `linear-gradient(150deg, ${tint}${index % 3 === 0 ? "3d" : "14"}, ${tint}05)`,
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (appId === "terminal") {
    const widths = ["46%", "72%", "28%", "84%", "36%", "58%", "22%"];
    return (
      <div className="absolute inset-0 p-[9%]">
        <div className="flex h-full flex-col justify-center gap-1.5 rounded-[4px] border border-white/[0.06] bg-black/30 p-2.5">
          {widths.map((width, index) => (
            <span
              key={index}
              className="block h-[3px] rounded-full"
              style={{
                width,
                backgroundColor: index === 0 ? tint : "rgba(166,173,200,0.28)",
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (appId === "system") {
    return (
      <div className="absolute inset-0 p-[9%]">
        <div className="grid h-full grid-cols-2 gap-1.5">
          {[0, 1, 2, 3].map((index) => (
            <div
              key={index}
              className="flex flex-col justify-between rounded-[4px] border border-white/[0.06] bg-black/25 p-1.5"
            >
              <span className="h-[3px] w-1/2 rounded-full bg-white/20" />
              <div className="flex items-end gap-0.5">
                {[0.35, 0.6, 0.45, 0.8, 0.5].map((height, bar) => (
                  <span
                    key={bar}
                    className="w-1 rounded-sm"
                    style={{
                      height: 12 * height,
                      backgroundColor: bar === 3 ? tint : "rgba(137,180,250,0.4)",
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (appId === "settings") {
    return (
      <div className="absolute inset-0 p-[10%]">
        <div className="flex h-full flex-col justify-center gap-2 rounded-[4px] border border-white/[0.06] bg-black/25 p-2.5">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center justify-between">
              <span className="h-[3px] w-[42%] rounded-full bg-white/20" />
              <span
                className="relative block h-2.5 w-[18%] rounded-full"
                style={{
                  backgroundColor:
                    index === 0 ? tint : "rgba(255,255,255,0.12)",
                }}
              >
                <span
                  className="absolute top-1/2 block h-2 w-2 -translate-y-1/2 rounded-full bg-white/85"
                  style={{ right: index === 0 ? 1 : "auto", left: index === 0 ? "auto" : 1 }}
                />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 grid place-items-center">
      <div className="opacity-70">
        <PortholeMark size={40} muted />
      </div>
    </div>
  );
}
