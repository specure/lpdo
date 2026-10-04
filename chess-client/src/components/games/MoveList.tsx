import { Fragment, useEffect, useState, type ReactNode } from "react";
import { LoadedGame, GameMove } from "../../lib/useGamePgn";
import type { MoveNode } from "../../lib/parsePgnTree";
import { getMoveNum } from "../../lib/moveTreeNav";
import { nagsToString } from "../../lib/parseAnnotations";

// Compact, read-only move list (area F of the Games page, #219). The main line
// drives the shared `ply` (and so the mini board E); its comments and variations
// are shown with it. Clicking a variation's move shows that position through
// `onShowFen` without leaving the main line's place; ←/→ then step along the
// variation, and back past its first move returns to the main line.

/** A move inside a variation: its line and index there. */
interface VarAt { line: MoveNode[]; index: number }

export default function MoveList({
  game,
  ply,
  setPly,
  onShowFen,
}: {
  game: LoadedGame;
  ply: number;
  setPly: (p: number) => void;
  /** Show this position on the board instead of the main line's (a variation
   *  move), or null to go back to the main line. Without it, variations are
   *  shown but not clickable. */
  onShowFen?: (fen: string | null) => void;
}) {
  const [at, setAt] = useState<VarAt | null>(null);
  // Any move of the main line — or another game — leaves the variation.
  useEffect(() => {
    setAt(null);
    onShowFen?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ply, game]);

  function showVar(next: VarAt | null) {
    setAt(next);
    onShowFen?.(next ? next.line[next.index].fen : null);
  }

  const last = game.moves.length;
  // Keyboard nav when the move list has focus: ←/→ step, Home/End jump.
  function onKeyDown(e: React.KeyboardEvent) {
    if (at) {
      if (e.key === "ArrowLeft") { e.preventDefault(); showVar(at.index > 0 ? { ...at, index: at.index - 1 } : null); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); if (at.index + 1 < at.line.length) showVar({ ...at, index: at.index + 1 }); return; }
    }
    if (e.key === "ArrowLeft") { e.preventDefault(); setPly(Math.max(0, ply - 1)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); setPly(Math.min(last, ply + 1)); }
    else if (e.key === "Home") { e.preventDefault(); showVar(null); setPly(0); }
    else if (e.key === "End") { e.preventDefault(); showVar(null); setPly(last); }
  }

  if (game.moves.length === 0) {
    return (
      <div className="p-3 text-center text-on-surface-variant text-body-sm">
        {game.unreadable ? "Couldn't read this game's moves" : "No moves"}
      </div>
    );
  }

  // Variation moves sit tighter, so their parentheses close up on them.
  const moveBtn = (current: boolean, inVariation = false) =>
    `${inVariation ? "px-0.5" : "px-1"} rounded-sm font-mono transition-colors duration-short3 ease-standard ${
      current
        ? "bg-secondary-container text-on-secondary-container"
        : inVariation
        ? "hover:bg-on-surface/8 active:bg-on-surface/12"
        : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
    }`;
  const comment = (text: string, key: string) => (
    <span key={key} className="italic font-sans text-on-surface-variant"> {text} </span>
  );

  /** A variation, recursively: numbered from its first move, comments and
   *  sub-variations inline. */
  function renderVariation(line: MoveNode[], key: string): ReactNode {
    const parts: ReactNode[] = [];
    let needNumber = true;
    line.forEach((node, i) => {
      if (node.preComment) { parts.push(comment(node.preComment, `${key}-p${i}`)); needNumber = true; }
      const no = getMoveNum(node);
      const prefix = node.color === "w" ? `${no}.` : needNumber ? `${no}...` : "";
      const current = !!at && at.line === line && at.index === i;
      parts.push(
        <span key={`${key}-m${i}`} className="whitespace-nowrap">
          {prefix && <span className="select-none">{prefix}</span>}
          {onShowFen ? (
            <button className={moveBtn(current, true)} onClick={() => showVar({ line, index: i })}>
              {node.san}{nagsToString(node.annotations.nags)}
            </button>
          ) : (
            <span className="px-0.5 font-mono">{node.san}{nagsToString(node.annotations.nags)}</span>
          )}
        </span>,
      );
      needNumber = false;
      if (node.annotations.comment) { parts.push(comment(node.annotations.comment, `${key}-c${i}`)); needNumber = true; }
      node.variations.forEach((v, vi) => {
        parts.push(<Fragment key={`${key}-v${i}-${vi}`}> {renderVariation(v, `${key}-v${i}-${vi}`)} </Fragment>);
        needNumber = true;
      });
      if (i < line.length - 1) parts.push(" ");
    });
    return <span className="text-on-surface-variant">({parts})</span>;
  }

  const tree = game.tree;
  return (
    <div tabIndex={0} onKeyDown={onKeyDown} className="h-full overflow-y-auto p-2 text-body-sm leading-6 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50">
      {tree ? (
        <span className="align-baseline">
          {tree.startComment && comment(tree.startComment, "start")}
          {(() => {
            const parts: ReactNode[] = [];
            let needNumber = true;
            tree.mainLine.forEach((node, i) => {
              const p = i + 1;
              if (node.preComment) { parts.push(comment(node.preComment, `p${i}`)); needNumber = true; }
              const no = getMoveNum(node);
              const prefix = node.color === "w" ? `${no}.` : needNumber ? `${no}...` : "";
              parts.push(
                <span key={`m${i}`} className="mr-1 whitespace-nowrap">
                  {prefix && <span className="text-on-surface-variant select-none">{prefix}</span>}
                  <button className={moveBtn(!at && ply === p)} onClick={() => { showVar(null); setPly(p); }}>
                    {node.san}{nagsToString(node.annotations.nags)}
                  </button>
                </span>,
              );
              needNumber = false;
              if (node.annotations.comment) { parts.push(comment(node.annotations.comment, `c${i}`)); needNumber = true; }
              node.variations.forEach((v, vi) => {
                parts.push(<Fragment key={`v${i}-${vi}`}>{renderVariation(v, `v${i}-${vi}`)} </Fragment>);
                needNumber = true;
              });
            });
            return parts;
          })()}
        </span>
      ) : (
        <FlatMoves game={game} ply={ply} setPly={setPly} moveBtn={moveBtn} />
      )}
      {game.result && game.result !== "*" && (
        <div className="mt-1 px-1 font-mono text-on-surface">{game.result === "1/2-1/2" ? "½-½" : game.result}</div>
      )}
    </div>
  );
}

/** The main line alone, for a game whose tree isn't at hand. */
function FlatMoves({ game, ply, setPly, moveBtn }: {
  game: LoadedGame;
  ply: number;
  setPly: (p: number) => void;
  moveBtn: (current: boolean) => string;
}) {
  // Pair half-moves into "N. white black" rows.
  const rows: { no: number; white?: GameMove; black?: GameMove }[] = [];
  for (const m of game.moves) {
    const no = Math.ceil(m.ply / 2);
    if (m.color === "w") rows.push({ no, white: m });
    else {
      const last = rows[rows.length - 1];
      if (last && last.no === no && !last.black) last.black = m;
      else rows.push({ no, black: m });
    }
  }
  return (
    <span className="align-baseline">
      {rows.map((r) => (
        <span key={r.no} className="mr-1 whitespace-nowrap">
          <span className="text-on-surface-variant select-none">{r.no}.</span>{" "}
          {r.white && <button className={moveBtn(ply === r.white.ply)} onClick={() => setPly(r.white!.ply)}>{r.white.san}</button>}
          {r.black && <> <button className={moveBtn(ply === r.black.ply)} onClick={() => setPly(r.black!.ply)}>{r.black.san}</button></>}
        </span>
      ))}
    </span>
  );
}
