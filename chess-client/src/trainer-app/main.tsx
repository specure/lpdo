// The phone trainer's entry (#327): its own page and build (vite.trainer.config.ts),
// published as a static web app; it shares src/trainer/ with the desktop.

import React from "react";
import ReactDOM from "react-dom/client";
import TrainerApp from "./TrainerApp";
import "../index.css";

// The phone's own light or dark setting, followed as it changes.
const light = window.matchMedia("(prefers-color-scheme: light)");
const applyScheme = () => document.documentElement.classList.toggle("light", light.matches);
applyScheme();
light.addEventListener("change", applyScheme);

// Offline: the service worker keeps what the app needs once it has been
// opened online (only in the built app — not under the dev server).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("./sw.js").catch(() => {});
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TrainerApp />
  </React.StrictMode>,
);
