import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { buildGamePdf } from "../../lib/pdfExport";
import symbolsFontUrl from "../../assets/fonts/NotoSansSymbols2-Regular.ttf?url";

// Printing a game: A4, two columns, the main line in bold and variations
// indented in brackets, the way a chess book sets it. Diagrams come from the
// movetext itself — a comment holding `[#]`, which is what ChessBase writes
// when its author asks for one — so an imported annotator's diagrams are kept.

const PDF_EXPORT_DIR_KEY = "pdfExportDir";

/** What the dialog needs of a game — GameDetail satisfies it. */
interface ExportableGame {
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

export default function ExportPdfDialog({
  detail,
  flipped,
  onClose,
}: {
  detail: ExportableGame;
  /** The board's current orientation, offered as the diagrams' point of view. */
  flipped: boolean;
  onClose: () => void;
}) {
  const [fromBlack, setFromBlack] = useState(flipped);
  const [diagramAtEnd, setDiagramAtEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const markers = (detail.pgn?.match(/\[#\]/g) ?? []).length;

  async function doExport() {
    setError(null);
    setBusy(true);
    try {
      const font = new Uint8Array(await (await fetch(symbolsFontUrl)).arrayBuffer());
      const bytes = await buildGamePdf(
        {
          white: detail.white, black: detail.black,
          white_elo: detail.white_elo, black_elo: detail.black_elo,
          event: detail.event, date: detail.date,
          result: detail.result, eco: detail.eco, pgn: detail.pgn ?? "",
        },
        { symbolsFont: font, flipped: fromBlack, diagramAtEnd, producer: "LPDO" },
      );

      const name = `${(detail.date ?? "").slice(0, 10) || "game"}-${surname(detail.white)}-${surname(detail.black)}.pdf`;
      const lastDir = localStorage.getItem(PDF_EXPORT_DIR_KEY) ?? "";
      const path = await save({
        defaultPath: lastDir ? `${lastDir}/${name}` : name,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path) { setBusy(false); return; }        // cancelled

      await invoke("write_binary_file", { path, bytes: Array.from(bytes) });
      const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      if (cut > 0) localStorage.setItem(PDF_EXPORT_DIR_KEY, path.substring(0, cut));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
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
          <h2 className="text-title-lg text-on-surface">Export as PDF</h2>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Two columns on A4, the main line in bold and variations in brackets. The game itself
            travels in the file, so this PDF can be added back to the database like a PGN.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-body-sm text-on-surface-variant">
            {markers > 0
              ? `${markers} diagram${markers > 1 ? "s" : ""} marked in the game will be drawn.`
              : "This game marks no diagrams. Add one in the move comments with [#]."}
          </p>
          <label className={row}>
            <input type="checkbox" checked={diagramAtEnd} onChange={(e) => setDiagramAtEnd(e.target.checked)} className="accent-primary" />
            Add a diagram of the final position
          </label>
          <label className={row}>
            <input type="checkbox" checked={fromBlack} onChange={(e) => setFromBlack(e.target.checked)} className="accent-primary" />
            Draw the diagrams from Black's side
          </label>
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
            onClick={() => void doExport()}
            disabled={busy || !detail.pgn}
            className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-50 transition-all duration-short3 ease-standard"
          >
            {busy ? "Writing…" : "Save PDF…"}
          </button>
        </div>
      </div>
    </div>
  );
}

function surname(name: string): string {
  return (name.split(",")[0] || name).trim().replace(/\s+/g, "_") || "game";
}
