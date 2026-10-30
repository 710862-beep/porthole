import type { WindowInstance } from "@/store/windowStore";
import { GameStoreApp } from "@/components/store/GameStoreApp";
import { EmulatorApp } from "@/components/apps/EmulatorApp";
import { SettingsApp } from "@/components/apps/SettingsApp";
import { SystemMonitorApp } from "@/components/apps/SystemMonitorApp";
import { TerminalApp } from "@/components/apps/TerminalApp";
import { WelcomeApp } from "@/components/apps/WelcomeApp";
import { WindowChromeContext } from "./WindowChromeContext";

interface WindowContentProps {
  instance: WindowInstance;
  visible: boolean;
}

/** App router for window contents. Everything below is presentation only. */
export function WindowContent({ instance, visible }: WindowContentProps) {
  return (
    <WindowChromeContext.Provider
      value={{
        id: instance.id,
        appId: instance.appId,
        payload: instance.payload,
        visible,
      }}
    >
      {instance.appId === "store" && <GameStoreApp />}
      {instance.appId === "emulator" && <EmulatorApp />}
      {instance.appId === "terminal" && <TerminalApp />}
      {instance.appId === "system" && <SystemMonitorApp />}
      {instance.appId === "settings" && <SettingsApp />}
      {instance.appId === "welcome" && <WelcomeApp />}
    </WindowChromeContext.Provider>
  );
}
