import { memo } from "react";
import { useWindowStore } from "@/store/windowStore";
import { useUiStore } from "@/store/uiStore";
import { WindowFrame } from "./WindowFrame";

/**
 * Renders every window (all workspaces) so app state survives workspace switches.
 * Only the active workspace is visible; the Overview compresses this layer.
 */
export const WindowLayer = memo(function WindowLayer() {
  const windows = useWindowStore((state) => state.windows);
  const order = useWindowStore((state) => state.order);
  const focusedId = useWindowStore((state) => state.focusedId);
  const workspace = useWindowStore((state) => state.workspace);
  const closingIds = useWindowStore((state) => state.closingIds);
  const overviewOpen = useUiStore((state) => state.overviewOpen);

  return (
    <div className="absolute inset-0 z-20" role="group" aria-label="Open windows">
      {order.map((id) => {
        const instance = windows[id];
        if (!instance) return null;
        return (
          <WindowFrame
            key={id}
            instance={instance}
            focused={focusedId === id && !overviewOpen}
            onWorkspace={instance.workspace === workspace}
            overviewOpen={overviewOpen}
            closing={closingIds.includes(id)}
          />
        );
      })}
    </div>
  );
});
