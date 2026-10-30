#!/usr/bin/env bash
# GATE 2 Wine reference: run the SAME pinned chocolate-doom.exe (SHA-256 in
# artifacts/tier-b-pin.json) under real Wine on Linux and cross-check two deterministic facts
# against the emulator's measured Tier B run:
#   (1) EXECUTION: `wine chocolate-doom.exe -timedemo demo1` must print
#       "timed 2664 gametics ..." — the identical gametic count the emulator produced.
#   (2) RENDERING: a screenshot the GUEST ITSELF writes (M_ScreenShot -> DOOMxxxx.PCX, its
#       own 320x200 palette framebuffer) during the static Freedoom title screen under Wine
#       must be pixel-identical to the emulator's native-resolution title tap
#       (`run-chocolate-doom.mjs --title-probe`).
# Fail-closed: any mismatch prints the evidence and exits 1. Expects: wine64, Xvfb, xdotool,
# node, pinned assets in tests/assets/third-party/, wasm artifact in vendor/porthole-x64-wasm.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p artifacts
REPORT="artifacts/wine-reference-report.txt"
: > "$REPORT"
log() { echo "$*" | tee -a "$REPORT"; }

ASSETS="tests/assets/third-party"
WORK="wine-ref-work"
rm -rf "$WORK" .wineprefix
mkdir -p "$WORK"
cp "$ASSETS/chocolate-doom.exe" "$WORK/"
cp "$ASSETS"/*.dll "$WORK/" 2>/dev/null || true
cp "$ASSETS/freedoom2.wad" "$WORK/DOOM2.WAD"

# Windowed, no mouse grab, screenshot on 'x' (Chocolate key code 120), PCX (not PNG) shots.
cat > "$WORK/default.cfg" <<'CFG'
fullscreen                  0
grabmouse                   0
use_mouse                   0
window_width                800
window_height               600
startup_delay               0
png_screenshots             0
key_screenshot              120
CFG

export WINEPREFIX="$ROOT/.wineprefix"
export WINEARCH=win64
export WINEDEBUG=-all
export WINEDLLOVERRIDES="mscoree,mshtml="
export DISPLAY=:99

log "== wine version =="
wine64 --version 2>&1 | tee -a "$REPORT" || { log "wine64 unavailable"; exit 1; }

Xvfb :99 -screen 0 1280x1024x24 > /tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 2

log "== wineboot =="
timeout 300 wine64 wineboot -i > artifacts/wine-boot.log 2>&1 || true

EXPECTED_GAMETICS=2664
WINE_GAMETICS=0
log "== (1) timedemo under real Wine =="
(
  cd "$WORK"
  timeout 900 wine64 chocolate-doom.exe -config default.cfg -iwad DOOM2.WAD -timedemo demo1 -nosound \
    > ../artifacts/wine-timedemo.log 2>&1
  echo "wine exit=$?" >> ../artifacts/wine-timedemo.log
)
grep -aE "timed [0-9]+ gametics" artifacts/wine-timedemo.log | tee -a "$REPORT" || true
WINE_GAMETICS="$(grep -aoE "timed [0-9]+ gametics" artifacts/wine-timedemo.log | grep -oE "[0-9]+" | head -1)"
WINE_GAMETICS="${WINE_GAMETICS:-0}"
log "wine_gametics=$WINE_GAMETICS expected=$EXPECTED_GAMETICS"

log "== (2) title screen screenshot under real Wine =="
(
  cd "$WORK"
  wine64 chocolate-doom.exe -config default.cfg -iwad DOOM2.WAD -nosound \
    > ../artifacts/wine-title.log 2>&1 &
  echo $! > wine.pid
)
# Wait for the game window, then tap the screenshot key several times while the static
# TITLEPIC page is up (it lasts only a few seconds before the attract demo starts).
WID=""
for i in $(seq 1 40); do
  WID="$(xdotool search --name "Chocolate Doom" 2>/dev/null | head -1 || true)"
  [ -n "$WID" ] && break
  sleep 1
done
log "window_id=${WID:-none} after_wait"
sleep 1
for i in 1 2 3 4 5; do
  if [ -n "$WID" ]; then
    xdotool windowfocus --sync "$WID" key x 2>/dev/null || true
    xdotool key --window "$WID" x 2>/dev/null || true
  else
    xdotool key x 2>/dev/null || true
  fi
  sleep 1
done
sleep 2
wineserver -k 2>/dev/null || true
pkill -f chocolate-doom.exe 2>/dev/null || true
sleep 1

find "$WORK" "$HOME" -iname 'DOOM*.pcx' -newer scripts/run-wine-reference.sh 2>/dev/null | head -8 | tee -a "$REPORT" || true
PCX="$(find "$WORK" -iname 'DOOM*.pcx' | sort | head -1)"
if [ -z "$PCX" ]; then
  PCX="$(find "$HOME" -iname 'DOOM*.pcx' 2>/dev/null | sort | head -1)"
fi
log "guest_screenshot_pcx=${PCX:-none}"
if [ -n "${PCX:-}" ]; then
  cp "$PCX" artifacts/wine-title-guest.pcx
  (cd artifacts && sha256sum wine-title-guest.pcx) | tee -a "$REPORT"
fi

log "== (3) emulator title probe (same pinned exe + IWAD) =="
PORTHOLE_DOOM_TIMEOUT_S=600 node tests/third-party/run-chocolate-doom.mjs --title-probe \
  > artifacts/emu-title-probe.log 2>&1
EMU_TITLE_RC=$?
grep -a "TITLE_PROBE" artifacts/emu-title-probe.log | tee -a "$REPORT" || true
log "emu_title_probe_rc=$EMU_TITLE_RC"

log "== (4) pixel comparison: Wine guest screenshot vs emulator title tap =="
COMPARE_OUT=""
COMPARE_RC=1
if [ -n "${PCX:-}" ] && [ -f artifacts/chocolate-doom-title-native.ppm ]; then
  COMPARE_OUT="$(node scripts/compare-title-frame.mjs artifacts/wine-title-guest.pcx artifacts/chocolate-doom-title-native.ppm 2>&1)"
  COMPARE_RC=$?
  echo "$COMPARE_OUT" | tee -a "$REPORT"
else
  log "compare_inputs_missing pcx=${PCX:-none} ppm=$( [ -f artifacts/chocolate-doom-title-native.ppm ] && echo present || echo missing )"
fi

PASS=1
[ "$WINE_GAMETICS" = "$EXPECTED_GAMETICS" ] || PASS=0
[ "$EMU_TITLE_RC" = "0" ] || PASS=0
[ "$COMPARE_RC" = "0" ] || PASS=0
if [ "$PASS" = "1" ]; then
  log "GATE 2 WINE REFERENCE: PASS (gametics match + title frame pixel-identical)"
  kill "$XVFB_PID" 2>/dev/null || true
  exit 0
fi
log "GATE 2 WINE REFERENCE: FAIL (gametics=$WINE_GAMETICS emu_rc=$EMU_TITLE_RC compare_rc=$COMPARE_RC)"
log "-- wine-timedemo.log tail --"
tail -15 artifacts/wine-timedemo.log 2>/dev/null | tee -a "$REPORT" || true
log "-- wine-title.log tail --"
tail -15 artifacts/wine-title.log 2>/dev/null | tee -a "$REPORT" || true
kill "$XVFB_PID" 2>/dev/null || true
exit 1
