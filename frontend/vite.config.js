import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The built site lands in ../web, next to the config.*.json files the demo and
// deploy tools write there, so `python3 -m http.server -d web` serves it as is.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: {
    outDir: "../web",
    emptyOutDir: false,
    rollupOptions: { input: { index: "index.html", app: "app.html" } },
  },
});
