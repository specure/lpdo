import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { ensureMoveNumbers } from "./pgnEditor";
import { apiUrl } from "../api";

// Saving games as one PGN file. A PGN holds any number of games, one after
// another with a blank line between, so several open games go into a single
// file the same way one does.

const EXPORT_DIR_KEY = "pgnExportDir";

/** What the file dialog needs to name the file: enough of a game to build a
 *  sensible filename from. */
export interface PgnExportGame {
  id: number;
  white: string;
  black: string;
  date: string | null;
}

/** The PGN of each game, as the database holds it, in the order given —
 *  null where a game has none. */
export async function fetchPgns(ids: number[]): Promise<(string | null)[]> {
  return Promise.all(ids.map(async (id) => {
    const res = await fetch(apiUrl(`/games/${id}`));
    if (!res.ok) throw new Error(`game ${id}: ${res.status}`);
    const detail = (await res.json()) as { pgn: string | null };
    return detail.pgn || null;
  }));
}

/** Ask where to save, then write the games as one PGN. Returns false when the
 *  dialog was cancelled. Move numbers are re-emitted, since games are stored
 *  as bare moves that strict readers reject. */
export async function savePgnFile(games: PgnExportGame[], pgns: string[]): Promise<boolean> {
  const name = games.length === 1
    ? `${dateStamp(games[0].date)}-${surname(games[0].white)}-${surname(games[0].black)}.pgn`
    : `${dateStamp(games[0]?.date)}-${games.length}-games.pgn`;
  const lastDir = localStorage.getItem(EXPORT_DIR_KEY) ?? "";
  const path = await save({
    defaultPath: lastDir ? `${lastDir}/${name}` : name,
    filters: [{ name: "PGN", extensions: ["pgn"] }],
  });
  if (!path) return false;

  const content = pgns.map((p) => ensureMoveNumbers(p).trim()).join("\n\n") + "\n";
  await invoke("write_pgn_file", { path, content });

  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut > 0) localStorage.setItem(EXPORT_DIR_KEY, path.substring(0, cut));
  return true;
}

function dateStamp(date: string | null | undefined): string {
  const d = (date ?? "").slice(0, 10).replace(/\?/g, "");
  return d || "games";
}

export function surname(name: string): string {
  return (name.split(",")[0] || name).trim().replace(/\s+/g, "_") || "game";
}
