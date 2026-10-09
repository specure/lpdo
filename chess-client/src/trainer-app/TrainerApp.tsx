// The phone trainer (#327): the chapters sent to this phone, and the drill
// on one. A static web app — on the home screen it works offline; the
// chapters and the cards stay in the phone's storage. See
// docs/design/opening-repertoire.md, "Taking chapters to the phone".

import { useEffect, useRef, useState } from "react";
import { validate, type LpdoChapter } from "../trainer/format";
import { buildDrill, cardCounts, type Card } from "../trainer/drill";
import DrillView from "../trainer/DrillView";
import { cardStore, deleteChapter, keepData, listChapters, saveChapter } from "./db";

const sentOn = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/** On an iPhone, not opened from the home screen: its storage may be cleared. */
const notInstalled = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator as Navigator & { standalone?: boolean }).standalone
  && !window.matchMedia("(display-mode: standalone)").matches;

export default function TrainerApp() {
  const [chapters, setChapters] = useState<LpdoChapter[] | null>(null);
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [drilling, setDrilling] = useState<LpdoChapter | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = async () => {
    const [cs, cards] = await Promise.all([listChapters(), cardStore.all()]);
    cs.sort((a, b) => a.book.name.localeCompare(b.book.name) || a.name.localeCompare(b.name));
    setChapters(cs);
    setCards(cards);
  };
  useEffect(() => { keepData(); void load().catch((e) => setNote({ text: String(e), error: true })); }, []);

  async function addFile(f: File) {
    try {
      const pkg = JSON.parse(await f.text()) as LpdoChapter;
      const problem = validate(pkg);
      if (problem) throw new Error(`${f.name}: ${problem}`);
      const had = chapters?.some((c) => c.chapter.id === pkg.chapter.id);
      await saveChapter(pkg);
      await load();
      setNote({ text: `${had ? "Updated" : "Added"} “${pkg.name}”` });
    } catch (e) {
      setNote({ text: e instanceof SyntaxError ? `${f.name} is not a chapter file` : String(e instanceof Error ? e.message : e), error: true });
    }
  }

  async function remove(c: LpdoChapter) {
    if (!window.confirm(`Remove “${c.name}” from this phone? What you have learnt is kept, should you add it again.`)) return;
    await deleteChapter(c);
    await load();
  }

  if (drilling) {
    return (
      <div className="h-[100dvh] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] bg-surface">
        <DrillView chapter={drilling} store={cardStore} onClose={() => { setDrilling(null); void load(); }} />
      </div>
    );
  }

  const now = Date.now();
  return (
    <div className="min-h-[100dvh] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] bg-surface text-on-surface flex flex-col">
      <header className="px-4 py-3 flex items-center gap-3 border-b border-outline/40">
        <img src="./icon-192.png" alt="" className="w-8 h-8 rounded-md" />
        <h1 className="text-title-md flex-1">LPDO Trainer</h1>
        <button onClick={() => file.current?.click()}
          className="h-9 px-4 rounded-full bg-primary text-on-primary text-label-lg">Add chapter</button>
        <input ref={file} type="file" accept=".json,application/json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void addFile(f); }} />
      </header>

      {notInstalled() && (
        <div className="mx-4 mt-3 p-3 rounded-md bg-secondary-container text-on-secondary-container text-body-sm">
          Add this page to your Home Screen (Share → Add to Home Screen) and open it from there: it then works offline and
          keeps your chapters and what you have learnt.
        </div>
      )}
      {note && (
        <div className={`mx-4 mt-3 text-body-sm ${note.error ? "text-error" : "text-success"}`}>{note.text}</div>
      )}

      <main className="flex-1 px-2 py-2">
        {chapters === null ? (
          <p className="p-4 text-body-md text-on-surface-variant">Loading…</p>
        ) : chapters.length === 0 ? (
          <div className="p-4 space-y-2 text-body-md text-on-surface-variant">
            <p>No chapters on this phone yet.</p>
            <p>In LPDO on your computer, choose <b>Save for phone…</b> in a chapter's menu on the Repertoire page, get the
              file onto this phone, and add it here with <b>Add chapter</b>.</p>
          </div>
        ) : (
          <ul className="divide-y divide-outline/30">
            {chapters.map((c) => {
              const n = cardCounts(buildDrill(c, 0.75), cards, now);
              return (
                <li key={c.chapter.id} className="flex items-center gap-2">
                  <button onClick={() => setDrilling(c)} className="flex-1 min-w-0 text-left px-2 py-3 active:bg-on-surface/8 rounded-md">
                    <div className="text-body-lg truncate">{c.name}</div>
                    <div className="text-label-md text-on-surface-variant truncate">
                      {c.book.name} · as {c.book.color === "white" ? "White" : "Black"} · sent {sentOn(c.sent)}
                    </div>
                    <div className="text-label-md mt-0.5">
                      {n.due + n.fresh > 0
                        ? <><span className="text-primary">{n.due} due</span> · {n.fresh} new · {n.total} decisions</>
                        : <span className="text-success">all {n.total} known</span>}
                    </div>
                  </button>
                  <button onClick={() => void remove(c)} aria-label={`Remove ${c.name}`}
                    className="shrink-0 w-10 h-10 rounded-full text-on-surface-variant active:bg-on-surface/8">✕</button>
                </li>
              );
            })}
          </ul>
        )}
      </main>
      <footer className="px-4 py-3 text-label-sm text-on-surface-variant">
        Everything stays on this phone — no account, nothing sent anywhere.
      </footer>
    </div>
  );
}
