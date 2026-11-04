#!/usr/bin/env node
/*
 * Copy a locally supplied or CI-downloaded wasm-bindgen web artifact into Vite's
 * public directory. This script never builds or downloads the core. Arena CI also
 * publishes its verified ABI-v3 output into ui/public/wasm so clean browser builds
 * can initialize the real runtime. If neither source exists, the shell reports the
 * runtime as unavailable rather than substituting a simulator.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../..");
const sourceDir = path.join(repositoryRoot, "vendor", "porthole-x64-wasm");
const targetDir = path.join(repositoryRoot, "ui", "public", "wasm");
const requiredFiles = ["porthole_x64_wasm.js", "porthole_x64_wasm_bg.wasm"];
const isUsableRuntime = (directory) =>
  requiredFiles.every((name) => {
    const filePath = path.join(directory, name);
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  });

if (!fs.existsSync(sourceDir)) {
  if (isUsableRuntime(targetDir)) {
    console.log("Using the CI-published ABI-v3 runtime in ui/public/wasm.");
  } else {
    console.log("Wasm artifact absent; production runtime will report unavailable.");
  }
  process.exit(0);
}

const files = fs.readdirSync(sourceDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /^porthole_x64_wasm(?:_bg)?\.(?:js|wasm|d\.ts)$/.test(entry.name));
const missing = requiredFiles.filter((name) => !files.some((entry) => entry.name === name));
if (missing.length > 0) {
  if (isUsableRuntime(targetDir)) {
    console.warn(`Incomplete vendor artifact (${missing.join(", ")}); keeping the existing CI-published runtime.`);
  } else {
    console.log(`No complete wasm-bindgen web runtime found; production runtime will report unavailable (missing ${missing.join(", ")}).`);
  }
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });
for (const entry of files) {
  fs.copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
}
console.log(`Copied ${files.length} wasm-bindgen metadata/runtime file(s) into ui/public/wasm.`);
