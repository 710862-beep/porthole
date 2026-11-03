#!/usr/bin/env node
/*
 * Copy the CI-produced wasm-bindgen web artifact into Vite's public directory.
 * This script never builds or downloads the core. A missing artifact is expected
 * in a clean checkout; the desktop then reports the runtime as unavailable.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../..");
const sourceDir = path.join(repositoryRoot, "vendor", "porthole-x64-wasm");
const targetDir = path.join(repositoryRoot, "ui", "public", "wasm");

if (!fs.existsSync(sourceDir)) {
  console.log("Wasm artifact absent; production runtime will report unavailable.");
  process.exit(0);
}

const files = fs.readdirSync(sourceDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /^porthole_x64_wasm(?:_bg)?\.(?:js|wasm|d\.ts)$/.test(entry.name));
if (files.length === 0) {
  console.log("No wasm-bindgen web files found; production runtime will report unavailable.");
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });
for (const entry of files) {
  fs.copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
}
console.log(`Copied ${files.length} wasm-bindgen metadata/runtime file(s) into ui/public/wasm.`);
