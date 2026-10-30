"use strict";
/*
 * Porthole UI shell (minimal, functional). Implements the DesktopMode + GameStoreMode +
 * DialogService + StorageSelector shapes from ui/runtime/contracts.ts in plain JS.
 *
 * HONESTY NOTES (do not remove):
 * - The emulator window embeds the existing runtime page (../x64.html) in an iframe.
 *   That page owns storage mounting, wasm loading and the run loop today; the shell
 *   must not fork that logic. When the runtime is lifted into ui/runtime, replace the
 *   iframe with a direct canvas + EmulatorRuntime implementation.
 * - "Install" registers a library entry in shell state only. Real game bytes are never
 *   downloaded by this shell: CI pins them via scripts/fetch-*.mjs, and on a device the
 *   user mounts a folder inside the emulator window (File System Access).
 * - Input forwarding to the guest does not exist in the core yet (KI-04). The shell
 *   never claims gameplay.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const LS_KEY = "porthole.ui.v1";

  // ------------------------------------------------------------- catalog
  // Evidence strings mirror docs/FINAL-STATUS-REPORT.md. sha256 are the pinned CI hashes.
  const CATALOG = [
    {
      appId: "chocolate-doom", title: "Chocolate Doom 3.1.1 + Freedoom", kind: "game",
      exePath: "C:\\Game\\chocolate-doom.exe",
      sha256: "15e81c194df270fbd71450222e71846247926fabfb889e72e7d855903454d752",
      icon: "👾",
      evidence: "Gate 1 Tier B + Gate 2 PASS in CI: timedemo 2664 gametics == Wine 9.0; " +
        "1,782 distinct guest frames; title frame 64,000/64,000 px vs independent reference.",
      defaultInstalled: true,
    },
    {
      appId: "7zip", title: "7-Zip 21.07 (7za.exe)", kind: "utility",
      exePath: "C:\\Game\\7za.exe",
      sha256: "b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95",
      icon: "🗜️",
      evidence: "Gate 1 Tier A PASS in CI: real .7z create + extract round-trip, byte-identical.",
      defaultInstalled: true,
    },
    {
      appId: "emulator", title: "Emulator (runtime window)", kind: "system",
      exePath: "", icon: "🖥️",
      evidence: "The existing x64.html runtime: NVMe mount, Wasm core load, run/pause, telemetry.",
      defaultInstalled: true,
    },
    {
      appId: "gate4-probe", title: "Gate 4 device probe", kind: "utility",
      exePath: "", icon: "🔎",
      evidence: "Runs the Chromebook capability probe (storage policy, GPU tier, Wasm features).",
      defaultInstalled: false,
    },
  ];
  const CATEGORIES = [
    { id: "games", label: "Games" },
    { id: "utilities", label: "Utilities" },
    { id: "system", label: "System" },
  ];
  const categoryOf = (app) => (app.kind === "game" ? "games" : app.kind === "utility" ? "utilities" : "system");

  // ------------------------------------------------------------- state
  const state = {
    mode: "desktop",
    installed: new Set(),
    storage: "file-system-access",
    windows: new Map(), // id -> {id,title,el,bodyEl,appId,minimized}
    zTop: 10,
    winSeq: 0,
  };
  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        installed: [...state.installed], storage: state.storage, mode: state.mode,
      }));
    } catch { /* storage may be blocked; shell still works in-memory */ }
  }
  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { saved = null; }
    if (saved && Array.isArray(saved.installed)) state.installed = new Set(saved.installed);
    else CATALOG.forEach((a) => { if (a.defaultInstalled) state.installed.add(a.appId); });
    if (saved && typeof saved.storage === "string") state.storage = saved.storage;
  }

  // ------------------------------------------------------------- dialogs
  const Dialogs = {
    confirm({ title, body, confirmLabel = "Yes", cancelLabel = "No", danger = false }) {
      return new Promise((resolve) => {
        const backdrop = $("modal-backdrop");
        $("modal-title").textContent = title;
        $("modal-body").textContent = body;
        const ok = $("modal-confirm"), no = $("modal-cancel");
        ok.textContent = confirmLabel; no.textContent = cancelLabel;
        ok.className = danger ? "danger" : "primary";
        backdrop.hidden = false;
        const done = (v) => {
          backdrop.hidden = true;
          ok.onclick = no.onclick = backdrop.onclick = null;
          document.removeEventListener("keydown", onKey, true);
          resolve(v);
        };
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } };
        document.addEventListener("keydown", onKey, true);
        ok.onclick = () => done(true);
        no.onclick = () => done(false);
        backdrop.onclick = (e) => { if (e.target === backdrop) done(false); };
        ok.focus();
      });
    },
  };

  // ------------------------------------------------------------- storage
  const StorageSel = {
    async detect() {
      const out = [];
      out.push({
        backend: "file-system-access",
        available: typeof window.showDirectoryPicker === "function",
        detail: typeof window.showDirectoryPicker === "function"
          ? "showDirectoryPicker present (policy verdict comes from an actual mount in the emulator window)"
          : "showDirectoryPicker unavailable in this browser/context",
      });
      let opfs = { ok: false, detail: "navigator.storage.getDirectory unavailable" };
      try {
        if (typeof navigator.storage?.getDirectory === "function") {
          await navigator.storage.getDirectory();
          opfs = { ok: true, detail: "OPFS root obtained" };
        }
      } catch (e) { opfs = { ok: false, detail: `${e.name}: ${e.message}` }; }
      out.push({ backend: "opfs", available: opfs.ok, detail: opfs.detail });
      out.push({ backend: "memory", available: true, detail: "always available; volatile (nothing persists)" });
      return out;
    },
    selected() { return state.storage; },
    async select(b) { state.storage = b; persist(); updateTray(); },
  };

  // ------------------------------------------------------------- windows (DesktopMode)
  const surface = $("desktop-surface");
  function createWindow({ title, appId, src, node, w = 860, h = 560 }) {
    const id = `win-${++state.winSeq}`;
    const el = document.createElement("section");
    el.className = "win"; el.id = id;
    el.style.width = `${w}px`; el.style.height = `${h}px`;
    el.style.left = `${60 + (state.winSeq % 5) * 36}px`;
    el.style.top = `${40 + (state.winSeq % 5) * 28}px`;
    el.style.zIndex = ++state.zTop;
    el.innerHTML = `
      <div class="win-bar">
        <span class="win-title"></span>
        <button class="win-btn" data-act="min" title="Minimize">—</button>
        <button class="win-btn" data-act="close" title="Close">✕</button>
      </div>
      <div class="win-body"></div>`;
    el.querySelector(".win-title").textContent = title;
    const body = el.querySelector(".win-body");
    if (src) {
      const f = document.createElement("iframe");
      f.src = src; f.title = title; f.loading = "eager";
      body.appendChild(f);
    } else if (node) body.appendChild(node);
    surface.appendChild(el);
    const rec = { id, title, el, appId, minimized: false };
    state.windows.set(id, rec);
    el.querySelector('[data-act="min"]').onclick = () => minimizeWindow(id);
    el.querySelector('[data-act="close"]').onclick = () => closeWindowRequest(id);
    el.addEventListener("mousedown", () => focusWindow(id));
    makeDraggable(el, el.querySelector(".win-bar"));
    focusWindow(id);
    renderTaskbar();
    updateHint();
    return id;
  }
  function focusWindow(id) {
    const rec = state.windows.get(id); if (!rec) return;
    rec.el.style.zIndex = ++state.zTop;
    rec.minimized = false; rec.el.classList.remove("minimized");
    document.querySelectorAll(".win").forEach((w) => w.classList.toggle("focused", w.id === id));
    renderTaskbar();
  }
  function minimizeWindow(id) {
    const rec = state.windows.get(id); if (!rec) return;
    rec.minimized = true; rec.el.classList.add("minimized"); renderTaskbar();
  }
  async function closeWindowRequest(id) {
    const rec = state.windows.get(id); if (!rec) return;
    if (rec.appId === "emulator" || rec.appId === "chocolate-doom") {
      const yes = await Dialogs.confirm({
        title: "Close emulator window?",
        body: "The guest process inside will stop. Unsaved guest state is lost (persisted VFS files remain).",
        confirmLabel: "Yes, close", cancelLabel: "No", danger: true,
      });
      if (!yes) return;
    }
    closeWindow(id);
  }
  function closeWindow(id) {
    const rec = state.windows.get(id); if (!rec) return;
    rec.el.remove(); state.windows.delete(id);
    if (rec.appId === "emulator" || rec.appId === "chocolate-doom") setEmuTray("idle");
    renderTaskbar(); updateHint();
  }
  function makeDraggable(el, handle) {
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        el.style.left = `${Math.max(0, ev.clientX - dx)}px`;
        el.style.top = `${Math.max(0, ev.clientY - dy)}px`;
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }
  function updateHint() { $("desktop-hint").style.display = state.windows.size ? "none" : ""; }
  function renderTaskbar() {
    const bar = $("taskbar-apps"); bar.innerHTML = "";
    for (const rec of state.windows.values()) {
      const b = document.createElement("button");
      b.className = "tb-item task-btn" + (!rec.minimized ? " active" : "");
      b.textContent = rec.title;
      b.onclick = () => (rec.minimized ? focusWindow(rec.id) : minimizeWindow(rec.id));
      bar.appendChild(b);
    }
  }

  // task view
  function showTaskView() {
    const tv = $("taskview");
    const grid = $("taskview-grid"); grid.innerHTML = "";
    if (!state.windows.size) grid.innerHTML = `<p class="muted">No open windows.</p>`;
    for (const rec of state.windows.values()) {
      const c = document.createElement("div");
      c.className = "card";
      c.innerHTML = `<div class="thumb">🗔</div><h3></h3>
        <div class="row"><button data-act="focus">Focus</button><button data-act="close">Close</button></div>`;
      c.querySelector("h3").textContent = rec.title;
      c.querySelector('[data-act="focus"]').onclick = () => { hideTaskView(); focusWindow(rec.id); };
      c.querySelector('[data-act="close"]').onclick = async () => { await closeWindowRequest(rec.id); showTaskView(); };
      grid.appendChild(c);
    }
    const apps = $("taskview-apps"); apps.innerHTML = "";
    for (const app of CATALOG.filter((a) => state.installed.has(a.appId))) {
      apps.appendChild(appCard(app, { compact: true }));
    }
    tv.hidden = false;
  }
  function hideTaskView() { $("taskview").hidden = true; }

  // ------------------------------------------------------------- apps / store (GameStoreMode)
  function appCard(app, { compact = false } = {}) {
    const c = document.createElement("article");
    c.className = "card";
    const installed = state.installed.has(app.appId);
    c.innerHTML = `
      <div class="thumb">${app.icon}</div>
      <h3></h3>
      <div class="evidence"></div>
      <div class="row"></div>`;
    c.querySelector("h3").textContent = app.title;
    c.querySelector(".evidence").textContent =
      `${app.evidence}${app.sha256 ? ` · sha256 ${app.sha256.slice(0, 12)}…` : ""}`;
    const row = c.querySelector(".row");
    if (installed) {
      const launch = document.createElement("button");
      launch.className = "primary"; launch.textContent = "▶ Launch";
      launch.onclick = () => launchGame(app.appId);
      row.appendChild(launch);
      if (!compact) {
        const un = document.createElement("button");
        un.textContent = "Uninstall";
        un.onclick = () => uninstallGame(app.appId);
        row.appendChild(un);
      }
    } else if (!compact) {
      const ins = document.createElement("button");
      ins.textContent = "Install";
      ins.onclick = () => installGame(app.appId);
      row.appendChild(ins);
    } else {
      const s = document.createElement("span");
      s.className = "badge"; s.textContent = "not installed";
      row.appendChild(s);
    }
    const badge = document.createElement("span");
    badge.className = "badge" + (installed ? " ok" : "");
    badge.textContent = installed ? "installed" : "available";
    row.appendChild(badge);
    return c;
  }
  async function installGame(appId) {
    const app = CATALOG.find((a) => a.appId === appId); if (!app) return;
    const yes = await Dialogs.confirm({
      title: `Install ${app.title}?`,
      body: "This registers the entry in your library (shell state only — no bytes are " +
        "downloaded). The real, hash-pinned binaries are provided by mounting a folder " +
        "in the emulator window; in CI they are fetched by scripts/fetch-*.mjs.",
      confirmLabel: "Yes, install",
    });
    if (!yes) return;
    state.installed.add(appId); persist(); renderStore();
  }
  async function uninstallGame(appId) {
    const app = CATALOG.find((a) => a.appId === appId); if (!app) return;
    const yes = await Dialogs.confirm({
      title: `Uninstall ${app.title}?`,
      body: "Removes the library entry. Files in your mounted folder are not touched.",
      confirmLabel: "Yes, uninstall", danger: true,
    });
    if (!yes) return;
    state.installed.delete(appId); persist(); renderStore();
  }
  function launchGame(appId) {
    const app = CATALOG.find((a) => a.appId === appId); if (!app) return;
    setMode("desktop"); hideTaskView();
    if (app.appId === "gate4-probe") {
      createWindow({ title: "Gate 4 device probe", appId, src: "../gate4-probe.html", w: 780, h: 620 });
      return;
    }
    openEmulatorWindow(app);
  }
  function openEmulatorWindow(app) {
    const existing = [...state.windows.values()].find((w) => w.appId === "emulator" || w.appId === app?.appId);
    if (existing) { focusWindow(existing.id); return; }
    createWindow({
      title: app ? `Emulator — ${app.title}` : "Emulator",
      appId: app ? app.appId : "emulator",
      src: "../x64.html", w: 900, h: 600,
    });
    setEmuTray("window open");
  }
  let storeFilter = "all";
  function renderStore() {
    const cats = $("store-cats"); cats.innerHTML = "";
    const mk = (id, label) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (storeFilter === id) b.className = "primary";
      b.onclick = () => { storeFilter = id; renderStore(); };
      cats.appendChild(b);
    };
    mk("all", "All");
    CATEGORIES.forEach((c) => mk(c.id, c.label));
    const grid = $("store-grid"); grid.innerHTML = "";
    for (const app of CATALOG) {
      if (storeFilter !== "all" && categoryOf(app) !== storeFilter) continue;
      grid.appendChild(appCard(app));
    }
  }

  // ------------------------------------------------------------- settings / storage panel
  async function openSettings() {
    const node = document.createElement("div");
    node.innerHTML = $("storage-panel-template").innerHTML;
    const opts = node.querySelector("#storage-options");
    const detail = node.querySelector("#storage-detail");
    const caps = await StorageSel.detect();
    for (const cap of caps) {
      const row = document.createElement("div");
      row.className = "storage-opt";
      const isSel = StorageSel.selected() === cap.backend;
      row.innerHTML = `<button>${isSel ? "●" : "○"} ${cap.backend}</button>
        <span class="badge ${cap.available ? "ok" : "bad"}">${cap.available ? "available" : "blocked"}</span>`;
      row.querySelector("button").onclick = async () => {
        await StorageSel.select(cap.backend);
        detail.textContent = `${cap.backend}: ${cap.detail}`;
        openSettingsRefresh(node);
      };
      opts.appendChild(row);
      if (isSel) detail.textContent = `${cap.backend}: ${cap.detail}`;
    }
    const existing = [...state.windows.values()].find((w) => w.appId === "settings");
    if (existing) { existing.el.querySelector(".win-body").replaceChildren(node); focusWindow(existing.id); }
    else createWindow({ title: "Settings", appId: "settings", node, w: 560, h: 440 });
    updateTray();
  }
  function openSettingsRefresh(node) {
    const existing = [...state.windows.values()].find((w) => w.appId === "settings");
    if (existing) existing.el.querySelector(".win-body").replaceChildren(node);
  }

  // ------------------------------------------------------------- mode switching & tray
  function setMode(mode) {
    state.mode = mode; persist();
    $("desktop").hidden = mode !== "desktop";
    $("store").hidden = mode !== "store";
    if (mode === "store") renderStore();
  }
  function updateTray() { $("tray-storage").textContent = `storage: ${StorageSel.selected()}`; }
  function setEmuTray(s) { $("tray-state").textContent = `emu: ${s}`; }
  function tickClock() {
    $("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // ------------------------------------------------------------- wiring
  function init() {
    restore();
    document.querySelectorAll("[data-goto]").forEach((el) => {
      el.addEventListener("click", () => setMode(el.dataset.goto));
    });
    $("btn-taskview").onclick = showTaskView;
    $("btn-taskview-close").onclick = hideTaskView;
    $("hot-corner").addEventListener("click", showTaskView);
    $("hot-corner").addEventListener("mouseenter", () => { if (!$("taskview").hidden) return; showTaskView(); });
    $("btn-open-emu").onclick = () => openEmulatorWindow(null);
    $("btn-settings").onclick = openSettings;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("taskview").hidden) hideTaskView();
    });
    tickClock(); setInterval(tickClock, 15000);
    updateTray(); setMode("desktop"); updateHint(); renderTaskbar();
    // Contract surface for the next agent / debugging (harmless, read-only handle).
    window.PortholeUI = { state, Catalogs: CATALOG, Dialogs, StorageSel,
      DesktopMode: { createWindow: (o) => createWindow(o), focusWindow, minimizeWindow, closeWindow,
        showTaskView, hideTaskView, getCategories: () => CATEGORIES,
        getAppsInCategory: (c) => CATALOG.filter((a) => categoryOf(a) === c) },
      GameStoreMode: { listGames: () => CATALOG.map((a) => ({ ...a, category: categoryOf(a),
        status: state.installed.has(a.appId) ? "installed" : "not-installed" })),
        installGame: (src) => installGame(src), launchGame, uninstallGame } };
  }
  try { init(); } catch (e) {
    // Shell must fail soft: log to the hint card instead of a blank page.
    const h = $("desktop-hint");
    if (h) h.innerHTML = `<h2>Shell error</h2><p class="mono">${String(e && e.message || e)}</p>`;
    console.error(e);
  }
})();
