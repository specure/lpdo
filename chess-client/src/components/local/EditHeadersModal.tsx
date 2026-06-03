import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LocalGame } from "../../types";
import {
  STR_TAGS,
  Tag,
  assemblePgnFile,
  buildBlock,
  parseBlockTags,
} from "../../lib/pgnEditor";
import PgnHeaderForm from "./PgnHeaderForm";

interface Props {
  filePath: string;
  game: LocalGame;
  gameIndex: number;
  allGames: LocalGame[];
  onClose: () => void;
  onSaved: () => void;
}

function withStrEnsured(tags: Tag[]): Tag[] {
  const present = new Set(tags.map((t) => t.name));
  const missing = STR_TAGS.filter((n) => !present.has(n)).map<Tag>((name) => ({
    name,
    value: "",
  }));
  return missing.length === 0 ? tags : [...missing, ...tags];
}

export default function EditHeadersModal({
  filePath,
  game,
  gameIndex,
  allGames,
  onClose,
  onSaved,
}: Props) {
  const initial = useMemo(() => {
    const { tags, body } = parseBlockTags(game.pgn);
    return { tags: withStrEnsured(tags), body };
  }, [game.pgn]);

  const [tags, setTags] = useState<Tag[]>(initial.tags);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileName = filePath.split("/").pop() ?? filePath;

  async function handleSave() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const newBlock = buildBlock(tags, initial.body);
      const blocks = allGames.map((g, i) => (i === gameIndex ? newBlock : g.pgn));
      const content = assemblePgnFile(blocks);
      await invoke("write_pgn_file", { path: filePath, content });
      onSaved();
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
        className="bg-surface-container-high rounded-xl shadow-2xl w-[36rem] max-w-[92vw] max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 shrink-0 flex items-center justify-between">
          <div>
            <div className="text-title-md text-on-surface">Edit headers</div>
            <div className="text-body-sm text-on-surface-variant truncate max-w-[28rem]" title={filePath}>
              {fileName}
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

        <div className="px-6 py-2 overflow-y-auto">
          <PgnHeaderForm tags={tags} onChange={setTags} />
          {error && (
            <div className="text-body-sm text-error whitespace-pre-wrap break-words mt-3">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 shrink-0">
          <button
            onClick={onClose}
            disabled={submitting}
            className="h-9 px-4 inline-flex items-center rounded-full text-primary text-label-lg hover:bg-primary/8 active:bg-primary/12 disabled:opacity-50 transition-colors duration-short3 ease-standard"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={submitting}
            className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 transition-all duration-short3 ease-standard"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
