import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Keep the legacy runtime bridge single-sourced: the runtime layer imports the
 * existing JIT host and NVMe VFS through virtual modules, and dev serves the
 * CI-produced Wasm artifact from vendor/ when one is present.
 */
function portholePlatformBridge(): Plugin {
  const virtualFiles = new Map<string, string>([
    ["@porthole/x64-jit-host", path.join(repositoryRoot, "js", "x64-jit-host.js")],
    ["@porthole/x64-nvme-vfs", path.join(repositoryRoot, "js", "x64-nvme-vfs.js")],
  ]);
  const virtualIds = new Map(
    [...virtualFiles.keys()].map((specifier) => [specifier, `\0porthole:${specifier}`]),
  );
  const wasmRoot = path.resolve(repositoryRoot, "vendor", "porthole-x64-wasm");

  return {
    name: "porthole-platform-bridge",
    enforce: "pre",
    resolveId(source) {
      return virtualIds.get(source) ?? null;
    },
    load(id) {
      for (const [specifier, virtualId] of virtualIds) {
        if (id !== virtualId) continue;
        const sourcePath = virtualFiles.get(specifier);
        return sourcePath ? fs.readFileSync(sourcePath, "utf8") : null;
      }
      return null;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://vite.local").pathname;
        if (!pathname.startsWith("/wasm/")) {
          next();
          return;
        }
        const relative = decodeURIComponent(pathname.slice("/wasm/".length));
        const filePath = path.resolve(wasmRoot, relative);
        if (!filePath.startsWith(`${wasmRoot}${path.sep}`) || !fs.existsSync(filePath)) {
          next();
          return;
        }
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader(
          "Content-Type",
          filePath.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8",
        );
        fs.createReadStream(filePath).pipe(response);
      });
    },
  };
}

/**
 * `base: "./"` keeps the production bundle portable: the shell can be served from
 * `/ui/`, from a sub-path, or opened through the repo's static server. Dev is served
 * on 0.0.0.0 so the Arena preview proxy can reach it (allowedHosts covers the proxy
 * hostname; the app itself is a pure client-side SPA).
 */
export default defineConfig({
  base: "./",
  plugins: [portholePlatformBridge(), react()],
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
