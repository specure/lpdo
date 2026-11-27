// A game whose players are not in its `[White]` and `[Black]`, but written
// out in one line — the way courses name their model games, and the way
// their exports hand them over: the whole of it in `[White]`, `[Black "?"]`,
// `[Event]` empty or the course's name, `[Date]` the day of the export.
//
//   Yilmazyerli, Mert vs. Dolgun, Can (Ayvalik Petro, 2022)
//   Adly, Ahmed vs. Harikrishna, Pentala, Batumi 2018
//   Wesley So – Magnus Carlsen, chess.com 2017
//   Anish Giri – Maxime Vachier Lagrave, Warsaw 2021 (Blitz Wch)
//   1E | Bassem Amin – Fabiano Caruana | Warschau 2021
//   3.Nc3 Nc6 - 5.Bd3: Abergel, Thal vs. Romanov, Evgeny
//   Kamsky, Gata vs. Khanin, Semen
//
// Read here into the two players, and the event and the year where the line
// names them — for the printed page, whose heading sets each player on a
// line of their own.

export interface Pairing {
  white: string;
  black: string;
  /** Where it was played, with whatever else the line said of the game — a
   *  course's own label for it ("1E"), a note in brackets ("Blitz Wch"). */
  event: string | null;
  year: string | null;
}

/** What stands between the two players, the surest first: a hyphen is also
 *  found inside a label ("3.Nc3 Nc6 - 5.Bd3: …"), "vs." nowhere else. */
const BETWEEN = [" vs. ", " vs ", " – ", " — ", " - "];

/** "Batumi 2018", "Ayvalik Petro, 2022", "2019": an event and the year it
 *  ends in — or, with no year at its end, all of it the event. */
function eventAndYear(text: string): { event: string | null; year: string | null } {
  // The year need not stand apart ("Cheboksary2022"), only not be the end of
  // a longer number (an engine's "20200511").
  const m = /^(.*?)[,\s]*(?<!\d)((?:1[5-9]|20)\d\d)$/.exec(text.trim());
  if (!m) return { event: text.trim() || null, year: null };
  return { event: m[1].trim() || null, year: m[2] };
}

/** The players, event and year a one-line pairing names — null when the
 *  line is not one (no "vs." or dash between two names). */
export function pairingFrom(line: string): Pairing | null {
  let text = line.replace(/\s+/g, " ").trim();
  let label: string | null = null;
  let event: string | null = null;
  let year: string | null = null;
  let note: string | null = null;

  // "1E | White – Black | Warschau 2021": the part with the players, a label
  // before it, the event after.
  const parts = text.split(/\s*\|\s*/);
  if (parts.length > 1) {
    const at = parts.findIndex((p) => BETWEEN.some((b) => p.includes(b)));
    if (at < 0) return null;
    label = parts.slice(0, at).join(" | ") || null;
    const after = parts.slice(at + 1).join(", ");
    if (after) ({ event, year } = eventAndYear(after));
    text = parts[at];
  }

  // "… (Ayvalik Petro, 2022)": the event and the year — or, with no year in
  // it, a note on the game: "… Warsaw 2021 (Blitz Wch)".
  const bracket = /^(.*\S)\s*\(([^()]*)\)$/.exec(text);
  if (bracket) {
    const inside = eventAndYear(bracket[2]);
    if (inside.year && !year) ({ event, year } = inside);
    else note = bracket[2].trim() || null;
    text = bracket[1];
  }

  const between = BETWEEN.find((b) => text.includes(b));
  if (!between) return null;
  const cut = text.indexOf(between);
  let white = text.slice(0, cut).trim();
  let black = text.slice(cut + between.length).trim();

  // "3.Nc3 Nc6 - 5.Bd3: Abergel, Thal": the course's label for the game.
  const labelled = /^(.*): (.+)$/.exec(white);
  if (labelled) {
    label = [label, labelled[1].trim()].filter(Boolean).join(" | ");
    white = labelled[2].trim();
  }

  // "Harikrishna, Pentala, Batumi 2018": what follows Black's name, when it
  // ends in a year, is the event. Black is taken to be written as White is —
  // "Surname, Name" or "Name Surname" — which says where the name ends;
  // failing that, the event is what follows the last comma.
  if (!year) {
    const pieces = black.split(/\s*,\s*/);
    const inName = white.split(",").length;
    const rest = pieces.length > inName ? eventAndYear(pieces.slice(inName).join(", ")) : null;
    const last = pieces.length > 1 ? eventAndYear(pieces[pieces.length - 1]) : null;
    if (rest?.year) {
      black = pieces.slice(0, inName).join(", ");
      ({ event, year } = rest);
    } else if (last?.year) {
      black = pieces.slice(0, -1).join(", ");
      ({ event, year } = last);
    }
  }

  if (!white || !black) return null;
  const where = event && note ? `${event} (${note})` : event ?? note;
  return { white, black, event: [label, where].filter(Boolean).join(" · ") || null, year };
}
