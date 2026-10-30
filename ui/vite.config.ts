import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

/**
 * Porthole desktop build.
 *
 * `base: "./"` keeps the production bundle portable: the shell can be served from
 * `/ui/`, from a sub-path, or opened through the repo's static server. Dev is served
 * on 0.0.0.0 so the Arena preview proxy can reach it (allowedHosts covers the proxy
 * hostname; the app itself is a pure client-side SPA).
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@runtime": fileURLToPath(new URL("./runtime", import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    hmr: { clientPort: 443 },
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
