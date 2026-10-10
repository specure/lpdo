// The phone trainer's storage (#327): the chapters sent to it, the cards'
// schedules and the list's settings (favourites, which colour), in the
// browser's IndexedDB — on the phone only, nothing sent anywhere. A chapter
// sent again replaces the one held (by its id on the desktop); the cards are
// keyed by position and move, and the favourites by the chapter's id, so
// they stay.

import type { LpdoChapter } from "../trainer/format";
import type { Card, CardStore } from "../trainer/drill";

const DB = "lpdo-trainer";
const CHAPTERS = "chapters";
const CARDS = "cards";
const PREFS = "prefs";

let opened: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    // Version 2: the settings' store.
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of [CHAPTERS, CARDS, PREFS]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opened = null; reject(req.error); };
  });
  return opened;
}

function run<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const req = f(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

/** Every key and value of a store. */
function entries<T>(store: string): Promise<[string, T][]> {
  return db().then((d) => new Promise((resolve, reject) => {
    const out: [string, T][] = [];
    const req = d.transaction(store, "readonly").objectStore(store).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(out); return; }
      out.push([String(c.key), c.value as T]);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  }));
}

const chapterKey = (c: LpdoChapter) => String(c.chapter.id);

export const listChapters = () => entries<LpdoChapter>(CHAPTERS).then((es) => es.map(([, c]) => c));
export const saveChapter = (c: LpdoChapter) => run(CHAPTERS, "readwrite", (s) => s.put(c, chapterKey(c))).then(() => undefined);
export const deleteChapter = (c: LpdoChapter) => run(CHAPTERS, "readwrite", (s) => s.delete(chapterKey(c))).then(() => undefined);

export const cardStore: CardStore = {
  all: () => entries<Card>(CARDS).then((es) => Object.fromEntries(es)),
  put: (key, card) => run(CARDS, "readwrite", (s) => s.put(card, key)).then(() => undefined),
};

/** The list's settings: the favourite chapters (by id), only those shown,
 *  and which colour's books. */
export interface Prefs {
  favourites: number[];
  favouritesOnly: boolean;
  color: "white" | "black" | "both";
}
const DEFAULT_PREFS: Prefs = { favourites: [], favouritesOnly: false, color: "both" };

export const loadPrefs = (): Promise<Prefs> =>
  run<Partial<Prefs> | undefined>(PREFS, "readonly", (s) => s.get("list")).then((p) => ({ ...DEFAULT_PREFS, ...(p ?? {}) }));
export const savePrefs = (p: Prefs) => run(PREFS, "readwrite", (s) => s.put(p, "list")).then(() => undefined);

/** Ask the browser to keep the data — without it Safari may clear a site's
 *  storage after a while unused. Granted for an app on the home screen. */
export function keepData(): void {
  void navigator.storage?.persist?.().catch(() => {});
}
