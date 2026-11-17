/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Which robot-pinned Mayhem commits write the same MayhemProject.h as this build
 * (scripts/exporter-compat.mjs). The app regenerates a robot's header only for those.
 */
async function exporterTable() {
  if (process.env.VITEST) return null;
  try {
    const { exporterTable } = await import("../scripts/exporter-compat.mjs");
    return await exporterTable();
  } catch (e) {
    console.warn(`Mayhem: could not check exporter versions (${e instanceof Error ? e.message : e}); the app will not regenerate MayhemProject.h.`);
    return null;
  }
}

// Tauri expects a fixed port and no clearing of its output.
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  define: { __MAYHEM_EXPORTER__: JSON.stringify(await exporterTable()) },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: { environment: "jsdom", setupFiles: ["src/test/setup.ts"], exclude: ["e2e/**", "node_modules/**"] },
}));
