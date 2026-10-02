// Where two versions of a comment differ, word by word: each version split
// into words, punctuation and spaces, and the words and punctuation that are
// not in the other's (by their longest common run) marked.

export interface Piece { text: string; differs: boolean }

const split = (s: string) => s.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-]/gu) ?? [];
const isSpace = (t: string) => /^\s+$/.test(t);

/** Which tokens of `a` (words and punctuation only) are in a longest common
 *  subsequence with `b`'s. */
function common(a: string[], b: string[]): boolean[] {
  const n = a.length, m = b.length;
  // Lengths of the common subsequence of a[i..] and b[j..].
  const L: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const keep = new Array<boolean>(n).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { keep[i] = true; i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return keep;
}

/** `text` in pieces, those missing from any of `others` marked as
 *  differing — against one other version, what it has that the other lacks. */
export function diffPieces(text: string, others: string[]): Piece[] {
  const tokens = split(text);
  const words = tokens.map((t, k) => ({ t, k })).filter((x) => !isSpace(x.t));
  // Too long to compare word by word (a whole page against another): unmarked.
  const differs = new Array<boolean>(tokens.length).fill(false);
  const otherWords = others.map((o) => split(o).filter((t) => !isSpace(t)));
  if (otherWords.length && otherWords.every((o) => words.length * o.length <= 4_000_000)) {
    const inAll = new Array<boolean>(words.length).fill(true);
    for (const o of otherWords) common(words.map((w) => w.t), o).forEach((c, x) => { if (!c) inAll[x] = false; });
    words.forEach((w, x) => { differs[w.k] = !inAll[x]; });
  }
  // Join neighbours alike; a space between two marked words is marked too.
  const pieces: Piece[] = [];
  tokens.forEach((t, k) => {
    const d = isSpace(t) ? differs[k - 1] === true && differs[k + 1] === true : differs[k];
    const last = pieces[pieces.length - 1];
    if (last && last.differs === d) last.text += t;
    else pieces.push({ text: t, differs: d });
  });
  return pieces;
}
