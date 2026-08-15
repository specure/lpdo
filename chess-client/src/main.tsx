import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";
import { serverUrl, serverToken, TOKEN_HEADER } from "./api";
import { installCrashHandlers } from "./lib/crashLog";

// In dev, the Vite dev-server proxies "/api/*" → http://localhost:7777 (see
// vite.config.ts). A bundled app has no such proxy, so route the relative
// "/api/*" calls straight to the chess-db server (which may be on another
// machine, #247). The server enables CORS so this cross-origin call from the
// webview is allowed. Both the address and the token are read PER CALL, so
// changing them in settings takes effect immediately.
//
// Dev keeps the proxy path, but still needs the token header when pointed at an
// authenticated server — hence the header injection runs in both modes.
{
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const isApi = typeof input === "string" && input.startsWith("/api/");
    if (isApi) {
      if (!import.meta.env.DEV) {
        input = serverUrl() + (input as string).slice("/api".length);
      }
      const token = serverToken();
      if (token) {
        const headers = new Headers(init?.headers ?? {});
        headers.set(TOKEN_HEADER, token);
        init = { ...init, headers };
      }
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
}

// Stray exceptions and rejected promises land in the crash log too — a render
// error is only one of the ways this app can fail out of sight (#—).
installCrashHandlers();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
