import { LocalGame } from "../types";

const TAG_RE = /\[(\w+)\s+"([^"]*)"\]/g;

function getTag(tags: Map<string, string>, key: string): string | null {
  const v = tags.get(key);
  return v && v !== "?" && v !== "" ? v : null;
}

function parseElo(tags: Map<string, string>, key: string): number | null {
  const v = tags.get(key);
  if (!v || v === "?" || v === "") return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

export function splitPgnFile(text: string): LocalGame[] {
  // Split into individual game blocks by finding [Event "..."] at line start
  const games: LocalGame[] = [];
  const blocks: string[] = [];
  const eventRe = /^(\[Event\s+")/m;

  let rest = text;
  while (rest.length > 0) {
    // Find the next [Event after the first character
    const match = eventRe.exec(rest.slice(1));
    if (match) {
      const splitAt = match.index + 1;
      blocks.push(rest.slice(0, splitAt));
      rest = rest.slice(splitAt);
    } else {
      blocks.push(rest);
      break;
    }
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) continue;

    // Extract tags
    const tags = new Map<string, string>();
    let m: RegExpExecArray | null;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(block)) !== null) {
      tags.set(m[1], m[2]);
    }

    const white = getTag(tags, "White") ?? "?";
    const black = getTag(tags, "Black") ?? "?";

    games.push({
      id: -(i + 1),
      white,
      black,
      white_elo: parseElo(tags, "WhiteElo"),
      black_elo: parseElo(tags, "BlackElo"),
      event: getTag(tags, "Event"),
      date: getTag(tags, "Date"),
      result: getTag(tags, "Result"),
      eco: getTag(tags, "ECO"),
      move_count: null,
      opening_line: null,
      pgn: block,
      deleted_at: getTag(tags, "Deleted"),
    });
  }

  return games;
}
