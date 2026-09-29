import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { resolve } from "node:path";

// HTTPS with a self-signed certificate: the phone's camera is only allowed on
// a secure page. Two pages: the sender (desktop) and the receiver (phone).
export default defineConfig({
  plugins: [basicSsl()],
  define: { global: "globalThis" },
  server: { host: true, port: 5443 },
  build: {
    rollupOptions: {
      input: { send: resolve(import.meta.dirname, "index.html"), receive: resolve(import.meta.dirname, "receive.html") },
    },
  },
});
