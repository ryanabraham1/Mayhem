import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and no clearing of its output.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1500 },
});
