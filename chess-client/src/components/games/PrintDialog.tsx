import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

// Printing a game, or saving it as a PDF — the same pages, ending in the
// system print dialog or in a file: A4, two columns, the main line in bold
// and variations indented in brackets, the way a chess book sets it. Diagrams come from the
// movetext itself — a comment holding `[#]`, which is what ChessBase writes
// when its author asks for one — so an imported annotator's diagrams are kept.

const PDF_EXPORT_DIR_KEY = "pdfExportDir";

/** What the dialog needs of a game — GameDetail satisfies it. */
export interface ExportableGame {
  /** This game's own orientation, when it comes from the Analysis board:
   *  its diagrams are drawn the way the board stood, and the dialog does not
   *  ask. Absent, the dialog offers the choice. */
  flipped?: boolean;
  white: string;
  black: string;
  white_elo: number | null;
  black_elo: number | null;
  event: string | null;
  date: string | null;
  result: string | null;
  eco: string | null;
  pgn: string | null;
}

export default function PrintDialog({
  detail,
  games,
  flipped,
  primary = "print",
  onClose,
}: {
  /** The one game to print — or, with `games`, ignored. */
  detail?: ExportableGame;
  /** Several games, printed one after another in this order. */
  games?: ExportableGame[];
  /** The board's current orientation, offered as the diagrams' point of view. */
  flipped: boolean;
  /** What the dialog ends in: the system print dialog, or a file. The menu
   *  entry that opened it says which; the options are the same pages. */
  primary?: "print" | "save";
  onClose: () => void;
}) {
  const list = games ?? (detail ? [detail] : []);
  const many = list.length > 1;
  // Games from the Analysis rail carry their board's orientation; the
  // question is only asked for a game that carries none.
  const askOrientation = !games;
  const [fromBlack, setFromBlack] = useState(flipped);
  const [title, setTitle] = useState("");
  const [diagramAtEnd, setDiagramAtEnd] = useState(false);
  const [figurines, setFigurines] = useState(true);
  const [newPagePerGame, setNewPagePerGame] = useState(false);
  const [compact, setCompact] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const markers = list.reduce((n, g) => n + (g.pgn?.match(/\[#\]/g) ?? []).length, 0);
  const printable = list.filter((g) => g.pgn);

  async function build(): Promise<{ bytes: Uint8Array; name: string }> {
    // The PDF machinery (pdf-lib and the piece outlines) is a good half of
    // the app's JavaScript and is used only here, so it is fetched when
    // someone actually prints rather than at startup.
    const { buildGamesPdf } = await import("../../lib/pdfExport");
    const bytes = await buildGamesPdf(
      printable.map((g) => ({
        white: g.white, black: g.black,
        white_elo: g.white_elo, black_elo: g.black_elo,
        event: g.event, date: g.date,
        result: g.result, eco: g.eco, pgn: g.pgn ?? "", flipped: g.flipped,
      })),
      { flipped: fromBlack, diagramAtEnd, figurines, newPagePerGame, compact, title, producer: "LPDO" },
    );
    const first = printable[0];
    const slug = title.trim().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");
    const name = many
      ? slug ? `${slug}.pdf` : `${(first.date ?? "").slice(0, 10) || "games"}-${printable.length}-games.pdf`
      : `${(first.date ?? "").slice(0, 10) || "game"}-${surname(first.white)}-${surname(first.black)}.pdf`;
    return { bytes, name };
  }

  /** Print: the pages are drawn into the window and the system's print
   *  dialog opens on them (lib/printPages.ts). */
  async function doPrint() {
    setError(null);
    setBusy("Preparing…");
    try {
      const { bytes } = await build();
      const { printPdfPages } = await import("../../lib/printPages");
      await printPdfPages(bytes, (done, total) => setBusy(`Drawing page ${done} of ${total}…`));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  async function doSave() {
    setError(null);
    setBusy("Writing…");
    try {
      const { bytes, name } = await build();
      const lastDir = localStorage.getItem(PDF_EXPORT_DIR_KEY) ?? "";
      const path = await save({
        defaultPath: lastDir ? `${lastDir}/${name}` : name,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path) { setBusy(null); return; }        // cancelled

      await invoke("write_binary_file", { path, bytes: Array.from(bytes) });
      const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      if (cut > 0) localStorage.setItem(PDF_EXPORT_DIR_KEY, path.substring(0, cut));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  const row = "flex items-center gap-2 cursor-pointer text-body-sm text-on-surface";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40" onClick={onClose}>
      <div
        className="bg-surface-container-high rounded-xl shadow-2xl w-[30rem] max-w-[92vw] flex flex-col p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-title-lg text-on-surface">
            {primary === "save"
              ? (many ? `Export ${printable.length} games as PDF` : "Export as PDF")
              : (many ? `Print ${printable.length} games` : "Print this game")}
          </h2>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Two columns on A4, the main line in bold and variations in brackets.
            {many ? " The games follow one another in the order they are open." : ""}
            {primary === "save"
              ? ` The ${many ? "games themselves travel" : "game itself travels"} inside the file, so the PDF can be added back to the database like a PGN.`
              : " The pages go to your system's print dialog. (A file saved from there is a picture of the pages; Export as PDF makes one that reads back into the database.)"}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-body-sm text-on-surface-variant">
            {markers > 0
              ? `${markers} diagram${markers > 1 ? "s" : ""} marked in the game${many ? "s" : ""} will be drawn.`
              : `${many ? "These games mark" : "This game marks"} no diagrams. Add one while editing, with the Diagram button.`}
          </p>
          {many && (
            <>
              <label className="flex items-center gap-2 text-body-sm text-on-surface">
                <span className="shrink-0">Title</span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={`${printable.length} games`}
                  className="flex-1 min-w-0 h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface placeholder:text-on-surface-variant/70"
                  title="Printed above the first game and in the page header"
                />
              </label>
              <label className={row}>
                <input type="checkbox" checked={newPagePerGame} onChange={(e) => setNewPagePerGame(e.target.checked)} className="accent-primary" />
                Start each game on a new page
              </label>
              <label className={row}>
                <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} className="accent-primary" />
                Compact: no comments or diagrams, as a bulletin prints them
              </label>
            </>
          )}
          <label className={row}>
            <input type="checkbox" checked={figurines} onChange={(e) => setFigurines(e.target.checked)} className="accent-primary" />
            Print pieces as figurines (♘f3) rather than letters (Nf3)
          </label>
          <label className={row}>
            <input type="checkbox" checked={diagramAtEnd} onChange={(e) => setDiagramAtEnd(e.target.checked)} className="accent-primary" />
            Add a diagram of the final position
          </label>
          {askOrientation && (
            <label className={row}>
              <input type="checkbox" checked={fromBlack} onChange={(e) => setFromBlack(e.target.checked)} className="accent-primary" />
              Draw the diagrams from Black's side
            </label>
          )}
        </div>

        {error && <p className="text-error text-body-sm">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="h-9 px-4 inline-flex items-center rounded-full text-primary text-label-lg hover:bg-primary/8 transition-colors duration-short3 ease-standard"
          >
            Cancel
          </button>
          <button
            onClick={() => void (primary === "save" ? doSave() : doPrint())}
            disabled={busy !== null || printable.length === 0}
            className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-50 transition-all duration-short3 ease-standard"
          >
            {busy ?? (primary === "save" ? "Save PDF…" : "Print…")}
          </button>
        </div>
      </div>
    </div>
  );
}

function surname(name: string): string {
  return (name.split(",")[0] || name).trim().replace(/\s+/g, "_") || "game";
}
