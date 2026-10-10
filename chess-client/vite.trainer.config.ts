// The phone trainer (#327): its own build, a static web app in dist-trainer/
// — published to GitHub Pages (…/lpdo/trainer/) by .github/workflows/trainer.yml.
// Relative paths, so it works wherever it is served from. Shares src/trainer/
// and the theme (src/index.css) with the desktop app; the Tauri build
// (vite.config.ts) is not touched.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** The service worker's list of every file built, and a version from their
 *  contents — so a first visit stores all it needs to start offline, and a
 *  new build replaces the old cache. */
function precache(): Plugin {
  const out = "dist-trainer";
  return {
    name: "trainer-precache",
    apply: "build",
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(relative(out, p).split("\\").join("/"));
        }
      };
      walk(out);
      const list = ["./", ...files.filter((f) => f !== "sw.js").sort().map((f) => `./${f}`)];
      const version = createHash("sha256").update(files.filter((f) => f !== "sw.js").sort().map((f) => readFileSync(join(out, f))).join("")).digest("hex").slice(0, 12);
      const sw = join(out, "sw.js");
      const text = readFileSync(sw, "utf8")
        .replace('const VERSION = "dev";', `const VERSION = "${version}";`)
        .replace('const PRECACHE = ["./"];', `const PRECACHE = ${JSON.stringify(list)};`);
      if (!text.includes(version)) throw new Error("sw.js: the precache markers are missing");
      writeFileSync(sw, text);
    },
  };
}

export default defineConfig({
  root: "trainer",
  base: "./",
  plugins: [react(), tailwindcss(), precache()],
  build: { outDir: "../dist-trainer", emptyOutDir: true },
  server: { port: 1430, strictPort: true, host: true, fs: { allow: [".."] } },
});
