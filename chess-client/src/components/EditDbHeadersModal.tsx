// Edit headers of an existing DB game.
//
// Pre-loads the game's PGN, parses tags, mounts PgnHeaderForm with player
// names locked (per-game name edits would desync from the player record).
// On Save submits the tag update as a daemon mutation (postJson) — the
// daemon's single writer serialises it with any running jobs.

import { useEffect, useState } from "react";
import { postJson } from "../api";
import { STR_TAGS, Tag, parseBlockTags } from "../lib/pgnEditor";
import PgnHeaderForm from "./local/PgnHeaderForm";

interface Props {
  gameId: number;
  pgn: string;
  /** Authoritative FIDE IDs from the player records (joined). Used to overlay
   *  the WhiteFideId/BlackFideId tag values, which can carry stale or
   *  sentinel values like ChessBase's `-1` (= unknown). */
  whiteFideId: number | null;
  blackFideId: number | null;
  onClose: () => void;
  /** Fires after a successful save — caller refetches the game detail. */
  onSaved?: () => void;
}

function withStrEnsured(tags: Tag[]): Tag[] {
  const present = new Set(tags.map((t) => t.name));
  const missing = STR_TAGS.filter((n) => !present.has(n)).map<Tag>((name) => ({
    name,
    value: "",
  }));
  return missing.length === 0 ? tags : [...missing, ...tags];
}

/** Overlay a tag's value (or remove if null/0). */
function setOrRemoveTag(tags: Tag[], name: string, value: number | null): Tag[] {
  const filtered = tags.filter((t) => t.name !== name);
  if (value !== null && value > 0) {
    return [...filtered, { name, value: String(value) }];
  }
  return filtered;
}

export default function EditDbHeadersModal({
  gameId, pgn, whiteFideId, blackFideId, onClose, onSaved,
}: Props) {
  const [tags, setTags] = useState<Tag[]>(() => {
    let parsed: Tag[];
    try {
      parsed = parseBlockTags(pgn).tags;
    } catch {
      parsed = [];
    }
    // Player record is authoritative for FIDE IDs — overlay them so stale
    // PGN-tag values (ChessBase `-1`, typos, etc.) don't leak into the form.
    parsed = setOrRemoveTag(parsed, "WhiteFideId", whiteFideId);
    parsed = setOrRemoveTag(parsed, "BlackFideId", blackFideId);
    return withStrEnsured(parsed);
  });
  const [saving, setSaving] = useState(false);
  const [errorLines, setErrorLines] = useState<string[]>([]);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setErrorLines([]);

    try {
      await postJson(`/games/${gameId}/headers`, {
        tags: tags.map((t) => ({ name: t.name, value: t.value })),
      });
      onSaved?.();
      onClose();
    } catch (e) {
      setErrorLines([String(e)]);
      setSaving(false);
    }
  }

  function handleClose() {
    if (saving && !window.confirm("Save in progress. Close anyway?")) return;
    onClose();
  }

  // Esc to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40"
      onClick={handleClose}
    >
      {/* M3 dialog — Expressive xl (28px) corners */}
      <div
        className="bg-surface-container-high rounded-xl shadow-2xl w-[42rem] max-w-[92vw] max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 shrink-0 flex items-center justify-between">
          <div>
            <h2 className="text-title-md text-on-surface">Edit headers</h2>
            <p className="text-label-sm text-on-surface-variant font-mono">game id {gameId}</p>
          </div>
          <button
            onClick={handleClose}
            className="w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard text-lg leading-none"
          >×</button>
        </div>

        <div className="px-6 py-2 flex-1 overflow-y-auto">
          <PgnHeaderForm
            tags={tags}
            onChange={setTags}
            lockPlayerNames
            lockedFideIds={{
              white: whiteFideId !== null && whiteFideId > 0,
              black: blackFideId !== null && blackFideId > 0,
            }}
          />
          {errorLines.length > 0 && (
            <div className="mt-3 text-body-sm text-error whitespace-pre-wrap break-words">
              {errorLines.join("\n")}
            </div>
          )}
        </div>

        <div className="px-6 py-4 shrink-0 flex items-center justify-end gap-2">
          {/* Text button */}
          <button
            onClick={handleClose}
            disabled={saving}
            className="h-9 px-4 inline-flex items-center rounded-full text-primary text-label-lg hover:bg-primary/8 active:bg-primary/12 disabled:opacity-50 transition-colors duration-short3 ease-standard"
          >
            Cancel
          </button>
          {/* Filled button */}
          <button
            onClick={handleSave}
            disabled={saving}
            className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-50 transition-all duration-short3 ease-standard"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
