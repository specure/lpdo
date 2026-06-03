import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LocalGame } from "../../types";
import { splitPgnFile } from "../../lib/pgnSplitter";
import { Tag, buildBlock, defaultNewGameTags, rememberPgnSite } from "../../lib/pgnEditor";
import PgnHeaderForm from "./PgnHeaderForm";

interface Props {
  filePath: string;
  onClose: () => void;
  onAppended: (count: number) => void;
}

type Mode = "paste" | "scratch";

export default function AddGameModal({ filePath, onClose, onAppended }: Props) {
  const [mode, setMode] = useState<Mode>("paste");
  const [text, setText] = useState("");
  const [tags, setTags] = useState<Tag[]>(defaultNewGameTags);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileName = filePath.split("/").pop() ?? filePath;

  const preview: LocalGame[] = useMemo(() => {
    if (mode !== "paste" || !text.trim()) return [];
    try {
      return splitPgnFile(text);
    } catch {
      return [];
    }
  }, [mode, text]);

  // Validation differs per mode.
  const scratchValid = useMemo(() => {
    const white = tags.find((t) => t.name === "White")?.value.trim() ?? "";
    const black = tags.find((t) => t.name === "Black")?.value.trim() ?? "";
    return white.length > 0 && black.length > 0;
  }, [tags]);

  const canSubmit =
    !submitting &&
    (mode === "paste" ? preview.length > 0 : scratchValid);

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      let pgn: string;
      let count: number;
      if (mode === "paste") {
        pgn = text;
        count = preview.length;
      } else {
        // Persist the user's chosen Site as the default for future new games.
        rememberPgnSite(tags.find((t) => t.name === "Site")?.value ?? "");
        const result = tags.find((t) => t.name === "Result")?.value || "*";
        // Body is just the result token — a valid PGN movetext for an empty game.
        pgn = buildBlock(tags, result);
        count = 1;
      }
      await invoke("append_pgn_file", { path: filePath, pgn });
      onAppended(count);
      onClose();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-on-surface/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface-container-high rounded-xl shadow-2xl w-[42rem] max-w-[92vw] max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 shrink-0">
          <div>
            <div className="text-title-md text-on-surface">Add game</div>
            <div className="text-body-sm text-on-surface-variant truncate max-w-[32rem]" title={filePath}>
              Append to {fileName}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard text-lg leading-none"
            title="Close"
          >
            ×
          </button>
        </div>

        {/* M3 primary tabs */}
        <div className="flex border-b border-outline-variant shrink-0 px-2">
          <ModeTab active={mode === "paste"} onClick={() => setMode("paste")}>
            Paste PGN
          </ModeTab>
          <ModeTab active={mode === "scratch"} onClick={() => setMode("scratch")}>
            From scratch
          </ModeTab>
        </div>

        <div className="flex flex-col gap-3 p-6 overflow-y-auto">
          {mode === "paste" ? (
            <>
              <label className="text-label-sm text-on-surface-variant uppercase tracking-wider">PGN</label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder='Paste a PGN game here, e.g. from Lichess.&#10;&#10;[Event "Casual game"]&#10;[White "..."]&#10;...'
                rows={12}
                spellCheck={false}
                className="bg-surface-container-lowest text-on-surface text-body-sm font-mono px-3 py-2 rounded-sm border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant resize-y transition-colors duration-short3 ease-standard"
              />

              {text.trim() && preview.length === 0 && (
                <div className="text-body-sm text-warning">
                  No games detected. PGN must start with an <code>[Event "…"]</code> tag.
                </div>
              )}

              {preview.length > 0 && (
                <div>
                  <div className="text-label-md text-on-surface-variant mb-1">
                    Detected {preview.length} game{preview.length !== 1 ? "s" : ""}:
                  </div>
                  <div className="bg-surface-container rounded-sm max-h-48 overflow-y-auto">
                    {preview.map((g, i) => (
                      <div key={i} className="px-3 py-2 text-body-sm">
                        <div className="text-on-surface truncate">
                          {g.white} {g.white_elo ? `(${g.white_elo})` : ""} – {g.black}{" "}
                          {g.black_elo ? `(${g.black_elo})` : ""}
                        </div>
                        <div className="text-on-surface-variant flex gap-2 truncate mt-0.5">
                          {g.result && <span>{g.result === "1/2-1/2" ? "½-½" : g.result}</span>}
                          {g.date && <span>{g.date.slice(0, 10)}</span>}
                          {g.event && <span className="truncate">{g.event}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <PgnHeaderForm tags={tags} onChange={setTags} autoFocus />
              {!scratchValid && (
                <div className="text-body-sm text-on-surface-variant">
                  Fill in White and Black to create the game. Moves can be added later.
                </div>
              )}
            </>
          )}

          {error && (
            <div className="text-body-sm text-error whitespace-pre-wrap break-words">{error}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 shrink-0">
          {/* Text button */}
          <button
            onClick={onClose}
            disabled={submitting}
            className="h-9 px-4 inline-flex items-center rounded-full text-primary text-label-lg hover:bg-primary/8 active:bg-primary/12 disabled:opacity-50 transition-colors duration-short3 ease-standard"
          >
            Cancel
          </button>
          {/* Filled button */}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 transition-all duration-short3 ease-standard"
          >
            {submitting
              ? mode === "paste" ? "Appending…" : "Creating…"
              : mode === "paste"
              ? preview.length > 1
                ? `Append ${preview.length} games`
                : "Append game"
              : "Create game"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeTab({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  // M3 primary tab — colored text + indicator on active
  return (
    <button
      onClick={onClick}
      className={`px-4 py-3 text-label-lg border-b-2 -mb-px transition-colors duration-short3 ease-standard ${
        active
          ? "text-primary border-primary"
          : "text-on-surface-variant border-transparent hover:text-on-surface hover:bg-on-surface/4"
      }`}
    >
      {children}
    </button>
  );
}
