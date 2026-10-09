// The phone trainer's storage (#327): the chapters sent to it and the cards'
// schedules, in the browser's IndexedDB — on the phone only, nothing sent
// anywhere. A chapter sent again replaces the one held (by its id on the
// desktop); the cards are keyed by position and move, so they stay.

import type { LpdoChapter } from "../trainer/format";
import type { Card, CardStore } from "../trainer/drill";

const DB = "lpdo-trainer";
const CHAPTERS = "chapters";
const CARDS = "cards";

let opened: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(CHAPTERS)) d.createObjectStore(CHAPTERS);
      if (!d.objectStoreNames.contains(CARDS)) d.createObjectStore(CARDS);
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

/** Ask the browser to keep the data — without it Safari may clear a site's
 *  storage after a while unused. Granted for an app on the home screen. */
export function keepData(): void {
  void navigator.storage?.persist?.().catch(() => {});
}
