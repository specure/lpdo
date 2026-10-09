// The phone trainer (#327): its own build, a static web app in dist-trainer/
// — published to GitHub Pages (…/lpdo/trainer/) by .github/workflows/trainer.yml.
// Relative paths, so it works wherever it is served from. Shares src/trainer/
// and the theme (src/index.css) with the desktop app; the Tauri build
// (vite.config.ts) is not touched.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "trainer",
  base: "./",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist-trainer", emptyOutDir: true },
  server: { port: 1430, strictPort: true, host: true, fs: { allow: [".."] } },
});
