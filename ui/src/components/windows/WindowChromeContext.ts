import { createContext, useContext } from "react";
import type { AppId } from "@/store/apps";
import type { WindowPayload } from "@/store/windowStore";

export interface WindowChrome {
  id: string;
  appId: AppId;
  payload: WindowPayload | null;
  /**
   * True only when the window is actually on screen (not minimised, on the active
   * workspace, Overview closed). Apps use it to detach hot loops like frame listeners.
   */
  visible: boolean;
}

export const WindowChromeContext = createContext<WindowChrome | null>(null);

export function useWindowChrome(): WindowChrome {
  const chrome = useContext(WindowChromeContext);
  if (!chrome) throw new Error("useWindowChrome must be used inside a window");
  return chrome;
}
