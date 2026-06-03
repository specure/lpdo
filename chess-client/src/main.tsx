import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// In dev, the Vite dev-server proxies "/api/*" → http://localhost:7777 (see
// vite.config.ts). A bundled app has no such proxy, so route the relative
// "/api/*" calls straight to the chess-db sidecar's local HTTP server. The
// sidecar enables CORS so this cross-origin call from the webview is allowed.
if (!import.meta.env.DEV) {
  const SIDECAR = "http://127.0.0.1:7777";
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("/api/")) {
      input = SIDECAR + input.slice("/api".length);
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
