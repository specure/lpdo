// One's own games in the chapter on the board (#327): those that count for
// it — they reached one of its own positions by a move of one's own — newest
// first, each with how far it followed the chapter and who left it. A click
// puts the board where the game left the chapter; a double-click opens the
// game. Only on the Repertoire page (a chapter is open). With the whole book
// picked there instead, the book's games: each with the chapter it went into
// (a click puts that chapter on the board) or the move that left the book.

import { useEffect, useState } from "react";
import { getBookGameList, getChapter, getChapterGames, type BookGame, type BookGameList, type ChapterGame, type ChapterGameList } from "../../lib/repertoire";
import { parsePgnTree, type AnnotatedGame } from "../../lib/parsePgnTree";
import { cursorAtPosition } from "../../lib/repertoireLines";
import { positionKey } from "../../trainer/buildPackage";
import { currentMyPlayer } from "../MyStatsWidget";
import type { CursorPath } from "../../lib/moveTreeNav";
import type { GameSummary } from "../../types";

interface Props {
  chapterId: number;
  /** Bumped when the chapter was saved, to read it again. */
  reloadKey: number;
  onPick: (cursor: CursorPath) => void;
  onOpen: (game: GameSummary) => void;
  /** Preview a game under the list, at a move (`ply`: half-moves played). */
  onPreview?: (game: GameSummary, ply: number) => void;
  /** The whole book instead of the chapter, and putting a chapter on the board. */
  book?: { id: number; chapters: { id: number; name: string }[] } | null;
  onPickChapter?: (id: number) => void;
}

const summary = (g: ChapterGame | BookGame): GameSummary => ({
  id: g.id, white: g.white, black: g.black, white_elo: g.white_elo, black_elo: g.black_elo,
  event: g.event, date: g.date, result: g.result, eco: null, move_count: null, opening_line: null,
});

export default function MyGamesPanel(props: Props) {
  return props.book ? <BookGamesList {...props} book={props.book} /> : <ChapterGamesList {...props} />;
}

/** One's result in a game, from one's own side: "1", "½", "0". */
function myResult(result: string | null, meWhite: boolean): string {
  return result === "1/2-1/2" ? "½" : result === (meWhite ? "1-0" : "0-1") ? "1" : result ? "0" : "";
}
const resultTone = (r: string) => (r === "1" ? "text-success" : r === "0" ? "text-error" : "text-on-surface-variant");

/** A game's row: both players with their ratings and the result (coloured
 *  from one's own side); the event and the date; then `how` — how far it
 *  followed the chapter, or which chapter it went into. */
function GameRow({ g, meWhite, picked, how, title, onClick, onDoubleClick }: {
  g: ChapterGame | BookGame; meWhite: boolean; picked: boolean; how: React.ReactNode; title: string;
  onClick: () => void; onDoubleClick: () => void;
}) {
  const mine = myResult(g.result, meWhite);
  const result = g.result === "1/2-1/2" ? "½-½" : g.result ?? "";
  return (
    <button onClick={onClick} onDoubleClick={onDoubleClick} title={title}
      className={`w-full flex flex-col px-3 py-1.5 text-left text-body-sm rounded-sm transition-colors duration-short3 ease-standard ${
        picked ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8"
      }`}>
      <span className="flex items-baseline gap-2 w-full">
        <span className="min-w-0 flex-1 truncate">
          {g.white}{g.white_elo != null && <span className="tabular-nums opacity-70"> ({g.white_elo})</span>}
          {" – "}
          {g.black}{g.black_elo != null && <span className="tabular-nums opacity-70"> ({g.black_elo})</span>}
        </span>
        <span className={`shrink-0 tabular-nums font-medium ${resultTone(mine)}`}>{result}</span>
      </span>
      <span className="text-label-sm text-on-surface-variant truncate w-full">
        {[g.event, g.date].filter(Boolean).join(" · ")}
      </span>
      <span className="text-label-sm text-on-surface-variant truncate w-full">{how}</span>
    </button>
  );
}

/** How far a game followed its chapter — the same words in both lists. */
function followed(f: Pick<ChapterGame, "followed" | "left_by" | "move" | "at_ply">): React.ReactNode {
  return f.followed === "left"
    ? <span className={f.left_by === "you" ? "text-error" : ""}>{f.left_by === "you" ? "you" : "your opponent"} deviated at {f.move}</span>
    : f.followed === "end" ? "followed to the end of a line"
    : f.followed === "index" ? `in the chapter beyond move ${Math.floor(f.at_ply / 2) + 1} (the index ends)`
    : "the game ended in the chapter";
}

/** Who left the book, and where: the move's own number says whose it was
 *  ("3...Bb4": Black's). */
function leftBook(move: string | null, meWhite: boolean) {
  if (!move) return "deviated from the book";
  const mine = move.includes("...") !== meWhite;
  return <span className={mine ? "text-error" : ""}>{mine ? "you" : "your opponent"} deviated from the book at {move}</span>;
}

/** The whole book's games, each with the chapter it went into. */
function BookGamesList({ book, reloadKey, onOpen, onPickChapter }: Props & { book: NonNullable<Props["book"]> }) {
  const [list, setList] = useState<BookGameList | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => {
    let gone = false;
    setNote(null);
    void (async () => {
      const me = await currentMyPlayer();
      if (gone) return;
      if (!me) { setList(null); setNote("Set your player on the Home page to see your games here."); return; }
      try { const l = await getBookGameList(book.id, me.id); if (!gone) setList(l); }
      catch (e) { if (!gone) setNote(String(e)); }
    })();
    return () => { gone = true; };
  }, [book.id, reloadKey]);
  if (note) return <div className="p-3 text-center text-on-surface-variant text-body-sm">{note}</div>;
  if (!list) return <div className="p-3 text-center text-on-surface-variant text-body-sm">Looking up your games…</div>;
  const meWhite = list.color === "white";
  const colour = meWhite ? "White" : "Black";
  const period = list.months ? `the last ${list.months} months` : "all your games";
  const name = (id: number) => book.chapters.find((c) => c.id === id)?.name ?? `chapter ${id}`;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-1 shrink-0 text-label-sm text-on-surface-variant border-b border-outline/40" title="The period is set on the Maintenance page, Repertoire tab.">
        The whole book: {list.games.length} {list.games.length === 1 ? "game" : "games"} as {colour} · {period}
        <span className="ml-2 text-outline">click: its chapter · double-click: open</span>
      </div>
      {list.games.length === 0 ? (
        <div className="p-3 text-center text-on-surface-variant text-body-sm">None of your games as {colour} reached this book's opening in {period}.</div>
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
          {list.games.map((g) => (
            <GameRow key={g.id} g={g} meWhite={meWhite} picked={picked === g.id}
              how={g.chapters.length
                ? <>{g.chapters.map(name).join(", ")}{g.follow && <> · {followed(g.follow)}</>}</>
                : leftBook(g.left, meWhite)}
              title={`${g.white} – ${g.black}, ${g.event ?? ""} ${g.date ?? ""}. Click: its chapter on the board; double-click: open the game.`}
              onClick={() => { setPicked(g.id); if (g.chapters[0] != null) onPickChapter?.(g.chapters[0]); }}
              onDoubleClick={() => onOpen(summary(g))} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The chapter's games, each with how far it followed the chapter. */
function ChapterGamesList({ chapterId, reloadKey, onPick, onOpen, onPreview }: Props) {
  const [list, setList] = useState<ChapterGameList | null>(null);
  const [tree, setTree] = useState<AnnotatedGame | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => {
    let gone = false;
    setNote(null);
    void (async () => {
      const me = await currentMyPlayer();
      if (gone) return;
      if (!me) { setList(null); setNote("Set your player on the Home page to see your games here."); return; }
      try {
        const [l, c] = await Promise.all([getChapterGames(chapterId, me.id), getChapter(chapterId)]);
        if (gone) return;
        setList(l);
        setTree(parsePgnTree(c.pgn));
      } catch (e) { if (!gone) setNote(String(e)); }
    })();
    return () => { gone = true; };
  }, [chapterId, reloadKey]);

  if (note) return <div className="p-3 text-center text-on-surface-variant text-body-sm">{note}</div>;
  if (!list) return <div className="p-3 text-center text-on-surface-variant text-body-sm">Looking up your games…</div>;
  const colour = list.color === "white" ? "White" : "Black";
  const period = list.months ? `the last ${list.months} months` : "all your games";
  // The board where the game left the chapter, and the game previewed
  // there — the deviating move just played.
  const pick = (g: ChapterGame) => {
    setPicked(g.id);
    const at = tree && cursorAtPosition(tree, g.at_key, positionKey);
    if (at) onPick(at);
    onPreview?.(summary(g), g.followed === "left" ? g.at_ply + 1 : g.at_ply);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-1 shrink-0 text-label-sm text-on-surface-variant border-b border-outline/40"
        title="The period is set on the Maintenance page, Repertoire tab.">
        {list.games.length} {list.games.length === 1 ? "game" : "games"} as {colour} · {period}
        <span className="ml-2 text-outline">click: where it left, and the game below · double-click: open</span>
      </div>
      {list.games.length === 0 ? (
        <div className="p-3 text-center text-on-surface-variant text-body-sm">None of your games as {colour} went into this chapter in {period}.</div>
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
          {list.games.map((g) => {
            return (
              <GameRow key={g.id} g={g} meWhite={list.color === "white"} picked={picked === g.id} how={followed(g)}
                title={`${g.white} – ${g.black}, ${g.event ?? ""} ${g.date ?? ""}. Click: the board where it left the chapter; double-click: open the game.`}
                onClick={() => pick(g)} onDoubleClick={() => onOpen(summary(g))} />
            );
          })}
        </div>
      )}
    </div>
  );
}
