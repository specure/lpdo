import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

// Printing a game, or saving it as a PDF — the same pages, ending in the
// system print dialog or in a file: A4, two columns, the main line in bold
// and variations indented in brackets, the way a chess book sets it. The
// pages are shown as they will print, and redrawn as the options change, so
// what leaves the dialog has been seen. Diagrams come from the movetext
// itself — a comment holding `[#]`, which is what ChessBase writes when its
// author asks for one — so an imported annotator's diagrams are kept.

const PDF_EXPORT_DIR_KEY = "pdfExportDir";
/** The preview's resolution: a page is shown about 480px wide, and this
 *  keeps 9pt type readable when it is. Printing draws afresh at print
 *  resolution. */
const PREVIEW_DPI = 96;

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
  /** The orientation of the board this was opened from: the diagrams'
   *  point of view for games that carry none of their own. */
  flipped: boolean;
  /** What the dialog ends in: the system print dialog, or a file. The menu
   *  entry that opened it says which; the options are the same pages. */
  primary?: "print" | "save";
  onClose: () => void;
}) {
  const list = games ?? (detail ? [detail] : []);
  const many = list.length > 1;
  // Diagrams are drawn the way each game's board stands (a game from the
  // Analysis rail carries its own; otherwise the board this was opened
  // from), or, on request, from the side to move.
  const [sideToMove, setSideToMove] = useState(false);
  const [title, setTitle] = useState("");
  const [figurines, setFigurines] = useState(true);
  const markers = list.reduce((n, g) => n + (g.pgn?.match(/\[#\]/g) ?? []).length, 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const printable = list.filter((g) => g.pgn);

  // The preview: the document as the options stand, and its pages drawn.
  // Every change to an option starts a redraw a moment later; a redraw
  // that is overtaken by another throws its result away.
  const [built, setBuilt] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [drawing, setDrawing] = useState<string | null>("Drawing the pages…");
  const generation = useRef(0);

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
      { flipped, sideToMove, figurines, title, producer: "LPDO" },
    );
    const first = printable[0];
    const slug = title.trim().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");
    const name = many
      ? slug ? `${slug}.pdf` : `${(first.date ?? "").slice(0, 10) || "games"}-${printable.length}-games.pdf`
      : `${(first.date ?? "").slice(0, 10) || "game"}-${surname(first.white)}-${surname(first.black)}.pdf`;
    return { bytes, name };
  }

  useEffect(() => {
    if (printable.length === 0) { setDrawing(null); return; }
    const mine = ++generation.current;
    setDrawing("Drawing the pages…");
    const timer = window.setTimeout(async () => {
      try {
        const doc = await build();
        if (mine !== generation.current) return;
        setBuilt(doc);
        const { renderPdfPages } = await import("../../lib/printPages");
        const drawn: string[] = [];
        await renderPdfPages(doc.bytes, PREVIEW_DPI, (url, i, total) => {
          if (mine !== generation.current) return;
          drawn.push(url);
          setPages([...drawn]);
          setDrawing(i + 1 < total ? `Drawing page ${i + 2} of ${total}…` : null);
        });
        if (mine === generation.current) { setPages(drawn); setDrawing(null); setError(null); }
      } catch (e) {
        if (mine === generation.current) { setDrawing(null); setError(e instanceof Error ? e.message : String(e)); }
      }
    }, 250);
    return () => window.clearTimeout(timer);
    // The games themselves do not change while the dialog is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideToMove, title, figurines, printable.length]);

  /** Print: the pages are drawn into the window and the system's print
   *  dialog opens on them (lib/printPages.ts). */
  async function doPrint() {
    setError(null);
    setBusy("Preparing…");
    try {
      const { bytes } = built ?? await build();
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
      const { bytes, name } = built ?? await build();
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
  const ready = busy === null && drawing === null && printable.length > 0 && built !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40" onClick={onClose}>
      <div
        className="bg-surface-container-high rounded-xl shadow-2xl w-[66rem] max-w-[95vw] h-[88vh] flex overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* The pages, as they will print. Scrolls on its own; the options
            beside it stay put. */}
        <div className="flex-1 min-w-0 relative bg-surface-container overflow-y-auto">
          <div className="min-h-full flex flex-col items-center gap-4 p-6">
            {pages.map((src, i) => (
              <img
                key={i}
                src={src}
                alt={`Page ${i + 1}`}
                className="w-full max-w-[30rem] shadow-lg bg-white"
                style={{ aspectRatio: "210 / 297" }}
              />
            ))}
            {pages.length === 0 && (
              <div className="w-full max-w-[30rem] shadow-lg bg-white" style={{ aspectRatio: "210 / 297" }} />
            )}
          </div>
          {(drawing || printable.length === 0) && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-surface-container-highest text-label-md text-on-surface shadow">
              {printable.length === 0 ? "Nothing to print" : drawing}
            </div>
          )}
        </div>

        <div className="w-[22rem] shrink-0 flex flex-col p-6 space-y-4 border-l border-outline/40 overflow-y-auto">
          <div>
            <h2 className="text-title-lg text-on-surface">
              {primary === "save"
                ? (many ? `Export ${printable.length} games as PDF` : "Export as PDF")
                : (many ? `Print ${printable.length} games` : "Print this game")}
            </h2>
            {/* The pages themselves say the rest; only the count is worth a line. */}
            {pages.length > 0 && drawing === null && (
              <p className="text-body-sm text-on-surface-variant mt-1">{pages.length} page{pages.length === 1 ? "" : "s"}</p>
            )}
          </div>

          <div className="space-y-2">
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
                    title="Named in the page header"
                  />
                </label>
              </>
            )}
            <label className={row}>
              <input type="checkbox" checked={figurines} onChange={(e) => setFigurines(e.target.checked)} className="accent-primary" />
              Print pieces as figurines (♘f3) rather than letters (Nf3)
            </label>
            {/* Only when a game marks a diagram. */}
            {markers > 0 && (
              <label className={row}>
                <input type="checkbox" checked={sideToMove} onChange={(e) => setSideToMove(e.target.checked)} className="accent-primary" />
                Draw each diagram from the side to move
              </label>
            )}
          </div>

          {error && <p className="text-error text-body-sm">{error}</p>}

          <div className="flex-1" />
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="h-9 px-4 inline-flex items-center rounded-full text-primary text-label-lg hover:bg-primary/8 transition-colors duration-short3 ease-standard"
            >
              Cancel
            </button>
            <button
              onClick={() => void (primary === "save" ? doSave() : doPrint())}
              disabled={!ready}
              className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-50 transition-all duration-short3 ease-standard"
            >
              {busy ?? (primary === "save" ? "Save PDF…" : "Print…")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function surname(name: string): string {
  return (name.split(",")[0] || name).trim().replace(/\s+/g, "_") || "game";
}
