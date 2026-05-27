import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const shim = (name: string) =>
  path.resolve(__dirname, `src/shims/tauri/${name}.ts`);

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "WAILS_"],
  resolve: {
    alias: {
      "@tauri-apps/api/core": shim("api-core"),
      "@tauri-apps/api/event": shim("api-event"),
      "@tauri-apps/api/path": shim("api-path"),
      "@tauri-apps/api/app": shim("api-app"),
      "@tauri-apps/plugin-fs": shim("plugin-fs"),
      "@tauri-apps/plugin-dialog": shim("plugin-dialog"),
      "@tauri-apps/plugin-opener": shim("plugin-opener"),
      "@tauri-apps/plugin-process": shim("plugin-process"),
      "@tauri-apps/plugin-updater": shim("plugin-updater"),
    },
  },
  build: {
    target: ["es2021", "chrome100", "edge100"],
    sourcemap: false,
  },
});
