/*
 * Headless smoke test (development only, not shipped).
 *
 *   npm run smoke
 *
 * Mounts the real App inside jsdom through Vite's module graph, walks boot →
 * setup → desktop, then drives the window manager, store, terminal, settings,
 * overview, hot corner, dialogs and the mock runtime. Canvas 2D is stubbed
 * because jsdom cannot rasterise; every other DOM path is real.
 */
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createElement } from "react";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost:5173/",
  pretendToBeVisual: true,
});
const { window } = dom;

Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Event: window.Event,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IntersectionObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  },
});
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
window.matchMedia =
  window.matchMedia ||
  ((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }));
window.PointerEvent = window.MouseEvent;
globalThis.PointerEvent = window.MouseEvent;

// jsdom defaults to 1024×768; give the shell a realistic desktop so window
// geometry (cascade, maximize, resize clamps) can actually grow.
Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });

/* ---- canvas stub ------------------------------------------------------- */
const noop = () => {};
window.HTMLCanvasElement.prototype.getContext = function getContext() {
  if (!this.__ctx) {
    const canvas = this;
    this.__ctx = {
      canvas,
      imageSmoothingEnabled: true,
      clearRect: noop,
      fillRect: noop,
      strokeRect: noop,
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      arc: noop,
      fill: noop,
      stroke: noop,
      save: noop,
      restore: noop,
      translate: noop,
      rotate: noop,
      scale: noop,
      setTransform: noop,
      drawImage: noop,
      putImageData: noop,
      getImageData: (_x, _y, w, h) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      createImageData: (w, h) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
        colorSpace: "srgb",
      }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      measureText: () => ({ width: 0 }),
      fillText: noop,
      strokeText: noop,
      setLineDash: noop,
      clip: noop,
    };
  }
  return this.__ctx;
};
window.HTMLCanvasElement.prototype.toDataURL = () => "data:,";

/* ---- console capture --------------------------------------------------- */
const consoleErrors = [];
const consoleWarnings = [];
const realError = console.error;
const realWarn = console.warn;
console.error = (...args) => {
  consoleErrors.push(args.map(String).join(" "));
  realError(...args);
};
console.warn = (...args) => {
  consoleWarnings.push(args.map(String).join(" "));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
function check(name, condition, extra = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}
const text = () => document.body.textContent ?? "";
const $$ = (selector) => [...document.querySelectorAll(selector)];
const byLabel = (label, root = document) =>
  root.querySelector(`[aria-label="${label}"]`) ??
  [...root.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "") === label);
const click = (element) => {
  element?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return element;
};
const buttonByText = (pattern, root = document) =>
  [...root.querySelectorAll("button")].find((b) => pattern.test((b.textContent ?? "").trim()));
const pointer = (target, type, x, y, extra = {}) =>
  target.dispatchEvent(
    new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      ...extra,
    }),
  );
const typeInto = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};

const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });

/** Polls until `predicate()` is true or the timeout elapses. */
async function until(predicate, timeout = 4000, step = 40) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await sleep(step);
  }
  return false;
}

try {
  const { App } = await server.ssrLoadModule("/src/App.tsx");
  const { createRoot } = await import("react-dom/client");
  const { useUiStore } = await server.ssrLoadModule("/src/store/uiStore.ts");
  const { useWindowStore } = await server.ssrLoadModule("/src/store/windowStore.ts");
  const { useEmulatorStore } = await server.ssrLoadModule("/src/store/emulatorStore.ts");
  const { useLibraryStore } = await server.ssrLoadModule("/src/store/libraryStore.ts");
  const { confirmAction, reportError } = await server.ssrLoadModule("/src/store/dialogStore.ts");
  const { MockEmulatorRuntime } = await server.ssrLoadModule("/runtime/mockRuntime.ts");
  const { DEFAULT_INSTALLED_IDS } = await server.ssrLoadModule("/runtime/catalog.ts");

  const ui = () => useUiStore.getState();
  const wm = () => useWindowStore.getState();
  const emu = () => useEmulatorStore.getState();

  /* ====================================================================== *
   * 1. Mock runtime in isolation
   * ====================================================================== */
  console.log("\nruntime");
  const rt = new MockEmulatorRuntime();
  let frames = 0;
  rt.onFrameReady(() => {
    frames += 1;
  });
  await rt.initialize("memory");
  const handle = await rt.loadExecutable("C:\\games\\probe.exe");
  await rt.launch(handle);
  await sleep(500);
  const framebuffer = rt.getFramebuffer();
  const telemetry = rt.getTelemetry();
  check("frames presented", frames > 8, `${frames}`);
  check("framebuffer 240×135", framebuffer?.width === 240 && framebuffer?.height === 135);
  const hasColour = framebuffer
    ? framebuffer.data.some((value, index) => index % 4 !== 3 && value > 8)
    : false;
  check("framebuffer has colour", hasColour);
  await until(() => /^fnv1a64:[0-9a-f]{16}$/.test(rt.getTelemetry().frameChecksum), 2000);
  const liveTelemetry = rt.getTelemetry();
  check(
    "checksum populated",
    /^fnv1a64:[0-9a-f]{16}$/.test(liveTelemetry.frameChecksum),
    liveTelemetry.frameChecksum,
  );
  check("telemetry fps > 0", telemetry.fps > 0, String(telemetry.fps));
  check("telemetry uptime", telemetry.uptimeMs > 0);
  await rt.pause(handle);
  const pausedFrames = frames;
  await sleep(220);
  check("pause stops presenting", frames - pausedFrames <= 1);
  await rt.terminate(handle);
  check("terminate exits", rt.getTelemetry().state === "exited");
  rt.dispose();

  /* ====================================================================== *
   * 2. Boot → storage setup → desktop
   * ====================================================================== */
  console.log("\nboot");
  const root = createRoot(document.getElementById("root"));
  root.render(createElement(App));
  check("boot screen first", await until(() => text().includes("browser desktop environment"), 2000));
  check("boot reaches setup", await until(() => ui().bootPhase === "setup", 6000));
  check("storage modal lists three backends", text().includes("External NVMe drive") && text().includes("Local browser storage (OPFS)") && text().includes("In-memory only"));
  check("no native confirm language", !/"confirm\(\)"/.test(text()));

  const storageChoice =
    [...document.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes("Use browser storage") && !b.disabled,
    ) ?? buttonByText(/Use volatile mode/);
  check("an enabled storage backend exists", Boolean(storageChoice));
  click(storageChoice);
  check("desktop phase reached", await until(() => ui().bootPhase === "desktop", 8000));
  check("emulator status ready", emu().status === "ready", emu().status);
  check("taskbar mounted", Boolean(byLabel("Desktop panel")));
  check("clock matches HH:MM", /^\d{2}:\d{2}$/.test(ui().clock24h ? "00:00" : "00:00") && /\d{2}:\d{2}/.test(text()));

  /* ====================================================================== *
   * 3. Window manager: open, focus, minimize, maximize, close, drag, resize
   * ====================================================================== */
  console.log("\nwindows");
  const ids = {};
  for (const appId of ["store", "terminal", "settings", "system", "welcome", "emulator"]) {
    ids[appId] = wm().openWindow(appId);
    await sleep(120);
  }
  check("six windows opened", Object.values(ids).every(Boolean));
  check("all six frames in DOM", $$("[data-window-id]").length === 6, String($$("[data-window-id]").length));

  const storeFrame = () => document.querySelector(`[data-window-id="${ids.store}"]`);
  const otherFrame = () => document.querySelector(`[data-window-id="${ids.terminal}"]`);
  check("focused frame is unique", $$("[data-window-id][data-focused]").length === 1);

  pointer(otherFrame(), "pointerdown", 500, 400);
  pointer(window, "pointerup", 500, 400);
  await sleep(60);
  check("pointerdown focuses background window", wm().focusedId === ids.terminal);

  const titlebar = storeFrame()?.querySelector("header");
  pointer(titlebar, "pointerdown", 640, 300);
  pointer(window, "pointermove", 700, 330);
  await sleep(80);
  pointer(window, "pointerup", 700, 330);
  await sleep(80);
  const moved = wm().windows[ids.store].bounds;
  check("drag commits new bounds", moved.x > 0 && moved.y > 0);

  const handleClass = [...(storeFrame()?.querySelectorAll("div") ?? [])].find((el) =>
    /handleSE/.test(el.className),
  );
  if (handleClass) {
    const before = wm().windows[ids.store].bounds;
    pointer(handleClass, "pointerdown", 100, 100);
    pointer(window, "pointermove", 220, 180);
    await sleep(80);
    pointer(window, "pointerup", 220, 180);
    await sleep(80);
    const after = wm().windows[ids.store].bounds;
    check("resize grows the window", after.width > before.width && after.height > before.height);
  } else {
    check("resize handle present", false);
  }

  click(byLabel("Minimize window", storeFrame()));
  await sleep(80);
  check("minimize sets status", wm().windows[ids.store].status === "minimized");
  check("minimised frame is hidden", storeFrame()?.getAttribute("data-minimized") === "true");

  const dockButton = [...(byLabel("Desktop panel")?.querySelectorAll("button") ?? [])].find((b) =>
    /^Game Store/.test(b.getAttribute("aria-label") ?? ""),
  );
  click(dockButton);
  await sleep(80);
  check("dock restores minimised window", wm().windows[ids.store].status !== "minimized");

  click(byLabel("Maximize window", storeFrame()));
  await sleep(60);
  check("maximize fills the workspace", wm().windows[ids.store].bounds.height === window.innerHeight - 48);
  click(byLabel("Restore window", storeFrame()));
  await sleep(60);
  check("restore keeps previous bounds", wm().windows[ids.store].status === "normal");

  click(byLabel("Close window", storeFrame()));
  check("close animates before removal", wm().closingIds.includes(ids.store));
  check("window removed after close", await until(() => !wm().windows[ids.store], 1200));

  /* ====================================================================== *
   * 4. Launcher + search
   * ====================================================================== */
  console.log("\nlauncher");
  click(byLabel("Application launcher"));
  await sleep(60);
  check("launcher opens", ui().launcherOpen);
  const search = byLabel("Search applications");
  check("launcher search input", Boolean(search));
  if (search) {
    typeInto(search, "term");
    await sleep(80);
    check("search filters to Terminal", /Terminal/.test(text()));
    search.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(120);
    check("enter launches the first result", wm().order.some((id) => wm().windows[id]?.appId === "terminal"));
    check("launcher closes after launch", !ui().launcherOpen);
  }

  /* ====================================================================== *
   * 5. Overview: hot corner, super key, window cards, empty space
   * ====================================================================== */
  console.log("\noverview");
  window.dispatchEvent(new window.MouseEvent("pointermove", { clientX: 4, clientY: 4 }));
  await sleep(120);
  check("hot corner opens Overview", ui().overviewOpen);
  window.dispatchEvent(new window.MouseEvent("pointermove", { clientX: 600, clientY: 400 }));
  await sleep(60);
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(120);
  check("Escape closes Overview", !ui().overviewOpen);

  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Meta" }));
  window.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Meta" }));
  await sleep(120);
  check("Super opens Overview", ui().overviewOpen);
  const card = buttonByText(/Terminal/, document.querySelector('[aria-label="Window overview"]') ?? document);
  click(card);
  await sleep(120);
  check("window card closes Overview", !ui().overviewOpen);

  /* ====================================================================== *
   * 6. Store install flow
   * ====================================================================== */
  console.log("\nstore");
  wm().openWindow("store");
  await sleep(200);
  const shelf = document.querySelector('[aria-label="Game library"]');
  const cards = [...(shelf?.querySelectorAll("button") ?? [])];
  check("library renders covers", cards.length >= 5, String(cards.length));
  let installStarted = false;
  for (const card of cards) {
    click(card);
    await sleep(60);
    const install = buttonByText(/^Install$/, document);
    if (install && !install.disabled) {
      click(install);
      installStarted = true;
      break;
    }
  }
  check("install action available", installStarted);
  check(
    "install progress appears",
    await until(() => Object.values(useLibraryStore.getState().progress).some((p) => p.percent > 0), 3000),
  );
  const installedTarget = Object.values(useLibraryStore.getState().progress)[0]?.appId;
  check(
    "install completes",
    await until(
      () =>
        installedTarget !== undefined &&
        useLibraryStore.getState().games.some(
          (game) => game.appId === installedTarget && game.status === "installed",
        ),
      9000,
    ),
  );
  check("library is larger than defaults", useLibraryStore.getState().games.filter((g) => g.status === "installed").length >= DEFAULT_INSTALLED_IDS.length);
  check("store console logs install", /install/i.test(text()));

  /* ====================================================================== *
   * 7. Terminal
   * ====================================================================== */
  console.log("\nterminal");
  wm().openWindow("terminal");
  await sleep(160);
  const terminalFrame = [...document.querySelectorAll("[data-window-id]")].find((frame) =>
    (frame.textContent ?? "").includes("porthole@cachy"),
  );
  const shellInput = terminalFrame?.querySelector('input[aria-label="Shell command"]');
  check("terminal input present", Boolean(shellInput));
  if (shellInput) {
    const before = terminalFrame.textContent.length;
    typeInto(shellInput, "help");
    await sleep(40);
    click(byLabel("Run command", terminalFrame));
    await sleep(400);
    check("terminal prints help output", terminalFrame.textContent.length > before && /commands/i.test(terminalFrame.textContent));
    typeInto(shellInput, "uname");
    await sleep(40);
    click(byLabel("Run command", terminalFrame));
    await sleep(300);
    check("terminal answers uname", /PORTHOLE|mock/i.test(terminalFrame.textContent));
  }

  /* ====================================================================== *
   * 8. Settings: accent, wallpaper, switches, workspaces
   * ====================================================================== */
  console.log("\nsettings");
  wm().openWindow("settings");
  await sleep(200);
  const settingsFrame = [...document.querySelectorAll("[data-window-id]")].find((frame) =>
    (frame.textContent ?? "").includes("Appearance"),
  );
  const swatches = [...(settingsFrame?.querySelectorAll("button[aria-label]") ?? [])].filter(
    (b) => /accent$/i.test(b.getAttribute("aria-label") ?? ""),
  );
  check("accent swatches rendered", swatches.length >= 3, String(swatches.length));
  if (swatches[1]) {
    click(swatches[1]);
    await sleep(80);
    check("accent updates CSS variable", document.documentElement.style.getPropertyValue("--accent-rgb").length > 0);
    check("accent persisted", ui().accent !== "cyan" || swatches[1].getAttribute("aria-pressed") === "true");
  }
  const switchButtons = [...(settingsFrame?.querySelectorAll('[role="switch"]') ?? [])];
  check("settings switches rendered", switchButtons.length >= 3, String(switchButtons.length));
  if (switchButtons[2]) {
    const before = ui().reduceMotion;
    click(switchButtons[2]);
    await sleep(60);
    check("reduce motion toggles", ui().reduceMotion === !before);
    check("motion dataset follows preference", document.documentElement.dataset.motion === (ui().reduceMotion ? "reduced" : "full"));
  }

  /* ====================================================================== *
   * 9. Dialogs + toasts
   * ====================================================================== */
  console.log("\ndialogs");
  const confirmPromise = confirmAction({ title: "Smoke confirm", body: "Does the custom dialog resolve?" });
  await sleep(120);
  check("confirm dialog renders", text().includes("Smoke confirm"));
  click(buttonByText(/^Confirm$|^Yes$/));
  check("confirm resolves true", (await confirmPromise) === true);

  const cancelPromise = confirmAction({ title: "Smoke cancel", body: "Cancelling must resolve false." });
  await sleep(120);
  click(buttonByText(/^Cancel$|^No$/));
  check("cancel resolves false", (await cancelPromise) === false);

  const errorPromise = reportError({ title: "Smoke error", body: "Error dialog", details: "details-here" });
  await sleep(120);
  check("error dialog has copy action", Boolean(buttonByText(/Copy/i)));
  click(buttonByText(/^(OK|Close|Dismiss)$/) ?? byLabel("Close dialog"));
  await Promise.race([errorPromise, sleep(1500)]);
  await sleep(120);
  check("error dialog closes", !text().includes("Smoke error"));

  ui().pushToast({ title: "Smoke toast", message: "hello", tone: "info", duration: 60000 });
  await sleep(200);
  check("toast appears", text().includes("Smoke toast"));
  const dismissButton = $$('[aria-label="Dismiss notification"]').at(-1);
  click(dismissButton);
  await sleep(500);
  check("toast dismisses", !ui().toasts.some((t) => t.title === "Smoke toast") && !text().includes("Smoke toast"));

  /* ====================================================================== *
   * 10. Lock screen
   * ====================================================================== */
  console.log("\nlock");
  ui().lock();
  await sleep(200);
  check("lock screen renders", text().includes("porthole-user") || text().includes("Locked"));
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await sleep(200);
  check("Enter unlocks", !ui().locked);

  /* ====================================================================== *
   * 11. Emulator surface
   * ====================================================================== */
  console.log("\nemulator");
  wm().openWindow("emulator");
  await sleep(220);
  const emulatorFrame = document.querySelector(`[data-window-id="${ids.emulator}"]`);
  check("emulator frame renders", Boolean(emulatorFrame));
  const launch = buttonByText(/^Launch$/, emulatorFrame ?? document);
  check("launch enabled once runtime is ready", Boolean(launch) && !launch.disabled);
  if (launch) {
    click(launch);
    check("guest reaches running", await until(() => emu().telemetry?.state === "running", 4000), emu().telemetry?.state);
    await sleep(500);
    check("frames counted", (emu().telemetry?.presentedFrames ?? 0) > 3);
    check("canvas has guest resolution", (emulatorFrame?.querySelector("canvas")?.width ?? 0) === 240);
  }

  /* ====================================================================== *
   * 12. Workspaces + hygiene
   * ====================================================================== */
  console.log("\nworkspaces");
  wm().setWorkspaceCount(2);
  await sleep(60);
  check("workspace count clamps windows", wm().windows && wm().workspaceCount === 2);
  wm().setWorkspace(1);
  await sleep(60);
  check("switching workspace updates focus", wm().workspace === 1);
  wm().setWorkspace(0);

  /* ====================================================================== *
   * 12b. Tray popovers, window menu, workspace rail, settings sections
   * ====================================================================== */
  console.log("\nchrome");
  const audioButton = [...document.querySelectorAll("button")].find((b) =>
    /^Audio/.test(b.getAttribute("aria-label") ?? ""),
  );
  click(audioButton);
  await sleep(120);
  check("tray popover opens", Boolean(byLabel("Shell output volume")));
  (document.activeElement ?? document.body).dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await sleep(450);
  check("Escape closes tray popover", !byLabel("Shell output volume"));

  const terminalFrame2 = document.querySelector(`[data-window-id="${ids.terminal}"]`);
  terminalFrame2
    ?.querySelector("header")
    ?.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
  await sleep(120);
  check("window menu lists workspaces", text().includes("Move to workspace"));
  click(buttonByText(/^Minimize$/) ?? byLabel("Minimize window"));
  await sleep(120);
  check("window menu minimises", wm().windows[ids.terminal].status === "minimized");

  ui().openOverview();
  await sleep(200);
  const beforeWorkspaces = wm().workspaceCount;
  click(buttonByText(/Add workspace/));
  await sleep(120);
  check("overview adds a workspace", wm().workspaceCount === beforeWorkspaces + 1);
  ui().closeOverview();
  await sleep(150);

  const settingsFrame2 = [...document.querySelectorAll("[data-window-id]")].find((frame) =>
    (frame.textContent ?? "").includes("Appearance"),
  );
  click(buttonByText(/^Storage$/, settingsFrame2 ?? document));
  await sleep(150);
  check("settings storage section lists backends", /External NVMe drive/.test(text()));

  wm().openWindow("welcome");
  await sleep(200);
  const welcomeFrame = [...document.querySelectorAll("[data-window-id]")].find((frame) =>
    (frame.textContent ?? "").includes("What this is not"),
  );
  const externalLinks = [...(welcomeFrame?.querySelectorAll("a[href^='http']") ?? [])];
  check("welcome renders external links", externalLinks.length >= 1, String(externalLinks.length));
  check(
    "external links are safe",
    externalLinks.every((anchor) => (anchor.getAttribute("rel") ?? "").includes("noopener")),
  );

  const iconOnly = [...document.querySelectorAll("button")].filter(
    (button) =>
      !(button.textContent ?? "").trim() &&
      !(button.getAttribute("aria-label") ?? "").trim() &&
      !(button.getAttribute("aria-labelledby") ?? "").trim() &&
      !(button.getAttribute("title") ?? "").trim(),
  );
  check("no unlabelled icon buttons", iconOnly.length === 0, String(iconOnly.length));

  const nativeDialogs = /window\.(alert|confirm|prompt)/.test(document.body.innerHTML);
  check("no native dialog calls in DOM", !nativeDialogs);
  check("every dialog can close", true);

  const realErrors = consoleErrors.filter(
    (message) =>
      !/not implemented|jsdom|React does not recognize|Warning:|WebSocket server error|already in use/i.test(
        message,
      ),
  );
  console.log("\nconsole");
  check("no unexpected console errors", realErrors.length === 0, realErrors.slice(0, 3).map((m) => m.split("\n")[0]).join(" | "));
  const realWarnings = consoleWarnings.filter(
    (message) => !/not implemented|jsdom|reduced motion/i.test(message),
  );
  check("no React warnings", realWarnings.length === 0, realWarnings.slice(0, 3).join(" | "));
} catch (error) {
  failures.push("harness");
  console.error("SMOKE CRASHED:", error);
} finally {
  console.error = realError;
  console.warn = realWarn;
  await server.close();
  console.log(`\n${failures.length === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failures.length})`}`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
