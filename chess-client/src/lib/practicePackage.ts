// A chapter's practice package (#327), built on the desktop from the
// server: the chapter with the database's figures for its positions —
// stored by Analyse…, else worked out on the spot (a few seconds). For the
// desktop's drill, and to save for the phone trainer.

import { getChapter, getChapterStats } from "./repertoire";
import { buildPackage } from "../trainer/buildPackage";
import type { LpdoChapter } from "../trainer/format";

export async function chapterPackage(chapterId: number, opts: { noComments?: boolean } = {}): Promise<LpdoChapter> {
  const [c, stats] = await Promise.all([getChapter(chapterId), getChapterStats(chapterId)]);
  return buildPackage({
    chapter: { id: c.id, name: c.name, updated_at: c.updated_at, pgn: c.pgn },
    book: { name: c.book.name, author: c.book.author, color: c.book.color },
    stats: stats.positions,
    noComments: opts.noComments,
  });
}
