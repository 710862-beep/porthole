import { useEffect, useState } from "react";

export interface ClockValue {
  time: string;
  date: string;
  iso: string;
}

function format(date: Date, clock24h: boolean, showSeconds: boolean): ClockValue {
  const hour = date.getHours();
  const minute = date.getMinutes().toString().padStart(2, "0");
  const second = date.getSeconds().toString().padStart(2, "0");
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const hourText = (clock24h ? hour : hour12).toString().padStart(2, "0");
  const suffix = clock24h ? "" : hour >= 12 ? " PM" : " AM";
  return {
    time: `${hourText}:${minute}${showSeconds ? `:${second}` : ""}${suffix}`,
    date: date.toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    }),
    iso: date.toISOString(),
  };
}

/**
 * Taskbar clock.
 *
 * Instead of polling every second forever, the timeout is scheduled to the next
 * second (when seconds are visible) or the next minute boundary — one render per
 * visible change, no wasted work on an idle desktop.
 */
export function useClock(clock24h: boolean, showSeconds: boolean): ClockValue {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    let timer = 0;

    const schedule = (): void => {
      const current = new Date();
      const delay = showSeconds
        ? 1000 - current.getMilliseconds()
        : 60_000 - current.getSeconds() * 1000 - current.getMilliseconds();
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, Math.max(200, delay));
    };

    // Snap immediately when the format changes, then align to the boundary.
    setNow(new Date());
    schedule();

    return () => {
      window.clearTimeout(timer);
    };
  }, [showSeconds]);

  return format(now, clock24h, showSeconds);
}
