import { openUrl } from "@tauri-apps/plugin-opener";

// "Open on lichess.org ↗" beside a previewed game, when the game's PGN names a
// web address of its own (Lichess broadcasts write GameURL). The site is read
// from the address rather than assumed, so a game from anywhere else is
// labelled with its own host.

export default function OnlineGameLink({ url }: { url: string }) {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;   // not an address we can name — better no button than a broken one
  }

  return (
    <button
      onClick={() => { void openUrl(url); }}
      className="shrink-0 text-label-md text-primary hover:bg-primary/8 active:bg-primary/12 px-2.5 h-7 rounded-full transition-colors duration-short3 ease-standard"
      title={`Open this game in your browser: ${url}`}
    >
      {host} ↗
    </button>
  );
}
