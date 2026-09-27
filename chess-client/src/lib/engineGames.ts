// Whether engine games count (#296): TCEC and the like, games rated above
// any human, BOT-titled players. One setting on this computer for every page
// that lists games or players — Analysis (Reference, Games), the Games page
// (its explorer and list) and the Players page (its list of players too) —
// kept in step between them while they are open. Off by default: engine
// games drown out the human ones.

import { useEffect, useState } from "react";

// The Analysis page's key from before the switch was shared, so its setting
// carries over.
const KEY = "analysisShowEngines";
const EVENT = "lpdo:show-engine-games";

function read(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function useShowEngineGames(): [boolean, (v: boolean | ((prev: boolean) => boolean)) => void] {
  const [show, setShowState] = useState(read);
  useEffect(() => {
    const sync = () => setShowState(read());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const setShow = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === "function" ? v(read()) : v;
    try { localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* per-computer convenience only */ }
    setShowState(next);
    window.dispatchEvent(new Event(EVENT));
  };
  return [show, setShow];
}

/** The query parameter that leaves engine games out, when they are hidden. */
export function engineParam(show: boolean): string {
  return show ? "" : "&exclude_engines=true";
}
