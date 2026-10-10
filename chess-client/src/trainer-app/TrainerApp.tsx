// The phone trainer (#327): the chapters sent to this phone, and the drill
// on one. A static web app — on the home screen it works offline; the
// chapters and the cards stay in the phone's storage. See
// docs/design/opening-repertoire.md, "Taking chapters to the phone".

import { useEffect, useRef, useState } from "react";
import { validate, type LpdoChapter } from "../trainer/format";
import { buildDrill, cardCounts, type Card } from "../trainer/drill";
import DrillView from "../trainer/DrillView";
import { cardStore, deleteChapter, keepData, listChapters, loadPrefs, saveChapter, savePrefs, type Prefs } from "./db";

const sentOn = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/** A book's chapters in the book's order, whenever each was sent; a chapter
 *  from a package without its place (made before it was sent) after those
 *  with one, by name — "2…" before "10…". */
function inBook(a: LpdoChapter, b: LpdoChapter): number {
  const x = a.chapter.ord, y = b.chapter.ord;
  if (x != null && y != null && x !== y) return x - y;
  if ((x == null) !== (y == null)) return x == null ? 1 : -1;
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

/** The chapters by book (and colour), as sorted: White's books, then
 *  Black's, alphabetically; each one's chapters in its order. */
function byBook(chapters: LpdoChapter[]) {
  const groups = new Map<string, { book: string; color: LpdoChapter["book"]["color"]; chapters: LpdoChapter[] }>();
  for (const c of chapters) {
    const key = `${c.book.name}\u0000${c.book.color}`;
    if (!groups.has(key)) groups.set(key, { book: c.book.name, color: c.book.color, chapters: [] });
    groups.get(key)!.chapters.push(c);
  }
  return [...groups.values()];
}

/** On an iPhone, not opened from the home screen: its storage may be cleared. */
const notInstalled = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator as Navigator & { standalone?: boolean }).standalone
  && !window.matchMedia("(display-mode: standalone)").matches;

export default function TrainerApp() {
  const [chapters, setChapters] = useState<LpdoChapter[] | null>(null);
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [drilling, setDrilling] = useState<LpdoChapter | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const changePrefs = (patch: Partial<Prefs>) => setPrefs((p) => {
    if (!p) return p;
    const next = { ...p, ...patch };
    void savePrefs(next);
    return next;
  });
  const toggleFavourite = (id: number) => changePrefs({
    favourites: prefs?.favourites.includes(id) ? prefs.favourites.filter((f) => f !== id) : [...(prefs?.favourites ?? []), id],
  });
  const file = useRef<HTMLInputElement>(null);

  const load = async () => {
    const [cs, cards] = await Promise.all([listChapters(), cardStore.all()]);
    // White's books first, then Black's; each colour's alphabetically.
    cs.sort((a, b) => Number(a.book.color === "black") - Number(b.book.color === "black") || a.book.name.localeCompare(b.book.name) || inBook(a, b));
    setChapters(cs);
    setCards(cards);
  };
  useEffect(() => {
    keepData();
    void load().catch((e) => setNote({ text: String(e), error: true }));
    void loadPrefs().then(setPrefs).catch(() => setPrefs({ favourites: [], favouritesOnly: false, color: "both" }));
  }, []);

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
  const favourites = new Set(prefs?.favourites ?? []);
  // The list as the settings show it: one colour's books, the favourites.
  const shown = (chapters ?? []).filter((c) =>
    (!prefs || prefs.color === "both" || c.book.color === prefs.color) && (!prefs?.favouritesOnly || favourites.has(c.chapter.id)));
  const chip = (on: boolean) => `h-8 px-3 rounded-full text-label-md border ${on
    ? "bg-secondary-container text-on-secondary-container border-transparent" : "text-on-surface-variant border-outline/40"}`;
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
        ) : (<>
          {/* Which chapters: one colour's books or both, the favourites only. */}
          {prefs && (
            <div className="px-2 pb-2 flex items-center gap-2 flex-wrap">
              <div className="inline-flex rounded-full border border-outline/40 overflow-hidden" role="group" aria-label="Repertoire">
                {(["white", "both", "black"] as const).map((c) => (
                  <button key={c} onClick={() => changePrefs({ color: c })}
                    className={`h-8 px-3 text-label-md ${prefs.color === c ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant"}`}>
                    {c === "white" ? "White" : c === "black" ? "Black" : "Both"}
                  </button>
                ))}
              </div>
              <button onClick={() => changePrefs({ favouritesOnly: !prefs.favouritesOnly })} className={chip(prefs.favouritesOnly)}
                aria-pressed={prefs.favouritesOnly}>
                {prefs.favouritesOnly ? "★" : "☆"} Favourites only
              </button>
            </div>
          )}
          {shown.length === 0 && (
            <p className="p-4 text-body-md text-on-surface-variant">
              {prefs?.favouritesOnly
                ? <>No favourite chapters{prefs.color !== "both" ? ` for ${prefs.color === "white" ? "White" : "Black"}` : ""} — tap ☆ beside a chapter to make it one.</>
                : <>No chapters for {prefs?.color === "white" ? "White" : "Black"} on this phone.</>}
            </p>
          )}
          {/* Grouped by book — the book first, its chapters under it. */}
          <div className="space-y-4">
            {byBook(shown).map(({ book, color, chapters: cs }) => (
              <section key={`${book}\u0000${color}`}>
                <h2 className="px-2 pt-1 pb-1.5 border-b border-outline/40">
                  <span className="text-title-sm font-semibold">{book}</span>
                  <span className="text-label-md text-on-surface-variant"> · as {color === "white" ? "White" : "Black"}</span>
                </h2>
                <ul className="divide-y divide-outline/30">
                  {cs.map((c) => {
                    const n = cardCounts(buildDrill(c, 0.75), cards, now);
                    return (
                      <li key={c.chapter.id} className="flex items-center gap-2">
                        <button onClick={() => setDrilling(c)} className="flex-1 min-w-0 text-left px-2 py-2.5 active:bg-on-surface/8 rounded-md">
                          <div className="text-body-lg truncate">{c.name}</div>
                          <div className="text-label-md mt-0.5 truncate">
                            {n.due + n.fresh > 0
                              ? <><span className="text-primary">{n.due} due</span> · {n.fresh} new · {n.total} decisions</>
                              : <span className="text-success">all {n.total} known</span>}
                            <span className="text-on-surface-variant"> · sent {sentOn(c.sent)}</span>
                          </div>
                        </button>
                        <button onClick={() => toggleFavourite(c.chapter.id)} aria-pressed={favourites.has(c.chapter.id)}
                          aria-label={favourites.has(c.chapter.id) ? `Remove ${c.name} from the favourites` : `Make ${c.name} a favourite`}
                          className={`shrink-0 w-10 h-10 rounded-full text-title-md active:bg-on-surface/8 ${favourites.has(c.chapter.id) ? "text-warning" : "text-on-surface-variant"}`}>
                          {favourites.has(c.chapter.id) ? "★" : "☆"}
                        </button>
                        <button onClick={() => void remove(c)} aria-label={`Remove ${c.name}`}
                          className="shrink-0 w-10 h-10 rounded-full text-on-surface-variant active:bg-on-surface/8">✕</button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </>)}
      </main>
      <footer className="px-4 py-3 text-label-sm text-on-surface-variant">
        Everything stays on this phone — no account, nothing sent anywhere.
      </footer>
    </div>
  );
}
