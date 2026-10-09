// Drilling a chapter on the desktop (#327): its practice package built here
// — the chapter with the database's figures for its positions (stored by
// Analyse…, else worked out on the spot, a few seconds) — and the drill the
// phone trainer shares. The cards are kept in this browser's storage.

import { useEffect, useMemo, useState } from "react";
import { getChapter, getChapterStats } from "../../lib/repertoire";
import { buildPackage } from "../../trainer/buildPackage";
import type { LpdoChapter } from "../../trainer/format";
import { localCardStore } from "../../trainer/drill";
import DrillView from "../../trainer/DrillView";

export default function DrillDialog({ chapterId, onClose }: { chapterId: number; onClose: () => void }) {
  const [pkg, setPkg] = useState<LpdoChapter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const store = useMemo(() => localCardStore(), []);

  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const [c, stats] = await Promise.all([getChapter(chapterId), getChapterStats(chapterId)]);
        if (gone) return;
        setPkg(buildPackage({
          chapter: { id: c.id, name: c.name, updated_at: c.updated_at, pgn: c.pgn },
          book: { name: c.book.name, author: c.book.author, color: c.book.color },
          stats: stats.positions,
          noComments: true,
        }));
      } catch (e) { if (!gone) setError(String(e)); }
    })();
    return () => { gone = true; };
  }, [chapterId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40" onClick={onClose}>
      <div className="w-[min(72rem,94vw)] h-[min(48rem,92vh)] rounded-xl overflow-hidden shadow-2xl bg-surface" onClick={(e) => e.stopPropagation()}>
        {pkg ? <DrillView chapter={pkg} store={store} onClose={onClose} /> : (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-body-md text-on-surface-variant">
            {error ? <span className="text-error">{error}</span> : <span>Preparing the drill — the database's figures for the chapter…</span>}
            <button onClick={onClose} className="h-8 px-3 rounded-full text-label-md text-primary hover:bg-primary/8">Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
