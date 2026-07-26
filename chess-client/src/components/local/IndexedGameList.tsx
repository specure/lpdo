import { useEffect, useRef, useState } from "react";
import { LocalGame } from "../../types";
import {
  ColorFilter,
  IndexedRow,
  PgnQuery,
  pgnClose,
  pgnGame,
  pgnOpen,
  pgnQuery,
} from "../../lib/localPgnIndex";

// Read-only browser for LARGE local PGN files (#104). The file is indexed
// in-process by the `chess-pgn` engine (no server, no DuckDB, bounded memory).
// Indexing runs in the background and the index GROWS: we poll while it fills,
// so the game count and search results appear almost immediately and keep
// climbing until `complete`. Editing (add/delete/edit) is intentionally absent —
// that's the small-file path (LocalGameList) or an import. One page at a time
// keeps the DOM bounded regardless of how many games match.

const PAGE = 200;
const POLL_MS = 500;

interface Props {
  filePath: string;
  selectedId: number | null;
  onSelect: (game: LocalGame) => void;
  onGameCount?: (count: number) => void;
}

const OPPOSITE: Record<ColorFilter, ColorFilter> = { any: "any", white: "black", black: "white" };

/** Build a LocalGame the board/App understand from an index row + fetched text. */
function toLocalGame(row: IndexedRow, pgn: string): LocalGame {
  return {
    id: row.id,
    white: row.white,
    black: row.black,
    white_elo: row.white_elo,
    black_elo: row.black_elo,
    event: row.event,
    date: row.date,
    result: row.result,
    eco: null,
    move_count: null,
    opening_line: null,
    deleted_at: null,
    pgn,
  };
}

export default function IndexedGameList({ filePath, selectedId, onSelect, onGameCount }: Props) {
  const [session, setSession] = useState<number | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const [total, setTotal] = useState(0);
  const [matched, setMatched] = useState(0);
  const [rows, setRows] = useState<IndexedRow[]>([]);
  const [complete, setComplete] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [firstPageDone, setFirstPageDone] = useState(false);

  // Filters (mirror LocalGameList).
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [player1, setPlayer1] = useState("");
  const [player1Color, setPlayer1Color] = useState<ColorFilter>("any");
  const [player2, setPlayer2] = useState("");
  const [player2Color, setPlayer2Color] = useState<ColorFilter>("any");
  const [event, setEvent] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  function setP1Color(c: ColorFilter) { setPlayer1Color(c); setPlayer2Color(OPPOSITE[c]); }
  function setP2Color(c: ColorFilter) { setPlayer2Color(c); setPlayer1Color(OPPOSITE[c]); }

  // Bumped on every filter/session change so stale async results are dropped.
  const queryToken = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeFilterCount =
    (player1 ? 1 : 0) + (player2 ? 1 : 0) + (event ? 1 : 0) + (dateFrom || dateTo ? 1 : 0);

  // Open (start indexing) the file; cancel + close on unmount / path change.
  useEffect(() => {
    let cancelled = false;
    let opened: number | null = null;
    setOpenError(null);
    setSession(null);
    setRows([]);
    setFirstPageDone(false);
    setComplete(false);
    setTotal(0);
    setMatched(0);
    pgnOpen(filePath)
      .then(({ session: s }) => {
        if (cancelled) { void pgnClose(s); return; }
        opened = s;
        setSession(s);
      })
      .catch((e) => { if (!cancelled) setOpenError(String(e)); });
    return () => { cancelled = true; if (opened !== null) void pgnClose(opened); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  function buildQuery(offset: number, limit: number): PgnQuery {
    return {
      player1: player1 || null,
      player1_color: player1Color,
      player2: player2 || null,
      player2_color: player2Color,
      event: event || null,
      date_from: dateFrom || null,
      date_to: dateTo || null,
      offset,
      limit,
    };
  }

  // Fetch the first page on session/filter change, then poll the counts (only)
  // every POLL_MS while indexing — rows grow in file order at the tail, so the
  // first page is stable and new matches surface via scroll (loadMore).
  useEffect(() => {
    if (session === null) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const token = ++queryToken.current;

    const apply = (res: { total: number; matched: number; complete: boolean }) => {
      setTotal(res.total);
      setMatched(res.matched);
      setComplete(res.complete);
      onGameCount?.(res.total);
    };

    async function firstPage() {
      try {
        const res = await pgnQuery(session!, buildQuery(0, PAGE));
        if (stop || token !== queryToken.current) return;
        setRows(res.rows);
        setFirstPageDone(true);
        apply(res);
        if (!res.complete) timer = setTimeout(poll, POLL_MS);
      } catch (e) { if (!stop) setOpenError(String(e)); }
    }

    async function poll() {
      if (stop) return;
      try {
        // limit 1: refresh counts + complete cheaply without disturbing the list.
        const res = await pgnQuery(session!, buildQuery(0, 1));
        if (stop || token !== queryToken.current) return;
        apply(res);
        if (!res.complete) timer = setTimeout(poll, POLL_MS);
      } catch { /* transient; next tick retries */ if (!stop) timer = setTimeout(poll, POLL_MS); }
    }

    // Debounce filter typing; run immediately enough to feel live.
    const start = setTimeout(firstPage, 150);
    return () => { stop = true; clearTimeout(start); if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, player1, player1Color, player2, player2Color, event, dateFrom, dateTo]);

  function loadMore() {
    if (session === null || loadingMore || rows.length >= matched) return;
    const token = queryToken.current;
    setLoadingMore(true);
    pgnQuery(session, buildQuery(rows.length, PAGE))
      .then((res) => {
        if (token !== queryToken.current) return; // filters changed under us
        setRows((prev) => [...prev, ...res.rows]);
        setMatched(res.matched);
        setComplete(res.complete);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadMore();
  }

  async function select(row: IndexedRow) {
    if (session === null) return;
    try {
      const pgn = await pgnGame(session, row.id);
      onSelect(toLocalGame(row, pgn));
    } catch (e) {
      setOpenError(String(e));
    }
  }

  const fileName = filePath.split("/").pop() ?? filePath;
  const indexing = session !== null && !complete;

  function chipClass(active: boolean, hasValue: boolean) {
    const base = "inline-flex items-center h-7 px-3 rounded-full text-label-md transition-colors duration-short3 ease-standard";
    if (active) return `${base} bg-secondary-container text-on-secondary-container`;
    if (hasValue) return `${base} bg-tertiary-container text-on-tertiary-container hover:brightness-110`;
    return `${base} border border-outline text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12`;
  }

  const textInput = "h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard";
  function colorBtn(active: boolean) {
    return `text-label-md h-7 px-2.5 inline-flex items-center rounded-full transition-colors duration-short3 ease-standard ${
      active ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
    }`;
  }

  return (
    <div className="flex flex-col h-full bg-surface-container-low">
      {/* Header */}
      <div className="px-3 pt-3 pb-3 shrink-0 space-y-2">
        <div className="text-title-md text-on-surface truncate" title={filePath}>{fileName}</div>
        <div className="flex justify-between items-center gap-2 flex-wrap">
          <div className="text-label-md text-on-surface-variant flex items-center gap-1.5">
            <span>
              {matched.toLocaleString()}
              {activeFilterCount > 0 ? ` / ${total.toLocaleString()}` : ""} game{matched !== 1 ? "s" : ""}
            </span>
            {indexing && (
              <span className="inline-flex items-center gap-1 text-on-surface-variant/70">
                <span className="animate-spin text-xs">⟳</span> indexing…
              </span>
            )}
          </div>
          {!openError && (
            <button onClick={() => setFiltersOpen((o) => !o)} className={chipClass(filtersOpen, activeFilterCount > 0)}>
              {activeFilterCount > 0 ? `Filters · ${activeFilterCount}` : "Filters"}
            </button>
          )}
        </div>
        {!openError && (
          <div className="text-label-sm text-on-surface-variant/80">
            Large file — read-only browse. Import it for full search, dedup and position lookup.
          </div>
        )}
      </div>

      {/* Filters */}
      {filtersOpen && (
        <div className="p-4 bg-surface-container shrink-0 space-y-4">
          <div>
            <div className="text-label-md text-on-surface-variant mb-1.5">Player</div>
            <div className="flex gap-1">
              <input type="text" value={player1} onChange={(e) => setPlayer1(e.target.value)} placeholder="Name…" className={`flex-1 min-w-0 ${textInput}`} />
              <div className="flex gap-0.5">
                {(["any", "white", "black"] as ColorFilter[]).map((c) => (
                  <button key={c} onClick={() => setP1Color(c)} className={colorBtn(player1Color === c)}>
                    {c === "any" ? "Any" : c === "white" ? "W" : "B"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <div className="text-label-md text-on-surface-variant mb-1.5">Player 2</div>
            <div className="flex gap-1">
              <input type="text" value={player2} onChange={(e) => setPlayer2(e.target.value)} placeholder="Name…" className={`flex-1 min-w-0 ${textInput}`} />
              <div className="flex gap-0.5">
                {(["any", "white", "black"] as ColorFilter[]).map((c) => (
                  <button key={c} onClick={() => setP2Color(c)} className={colorBtn(player2Color === c)}>
                    {c === "any" ? "Any" : c === "white" ? "W" : "B"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <div className="text-label-md text-on-surface-variant mb-1.5">Event</div>
            <input type="text" value={event} onChange={(e) => setEvent(e.target.value)} placeholder="Event…" className={`w-full ${textInput}`} />
          </div>
          <div>
            <div className="text-label-md text-on-surface-variant mb-1.5">Date range</div>
            <div className="flex gap-2">
              <input type="text" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} placeholder="From (YYYY)" className={`flex-1 min-w-0 ${textInput}`} />
              <input type="text" value={dateTo} onChange={(e) => setDateTo(e.target.value)} placeholder="To (YYYY)" className={`flex-1 min-w-0 ${textInput}`} />
            </div>
          </div>
        </div>
      )}

      {/* List */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        {openError && <div className="p-4 text-center text-error text-body-md">{openError}</div>}
        {!openError && !firstPageDone && (
          <div className="p-4 text-center text-on-surface-variant text-body-md">Indexing large file…</div>
        )}
        {!openError && firstPageDone && rows.length === 0 && (
          <div className="p-4 text-center text-on-surface-variant text-body-md">
            {activeFilterCount > 0 ? (indexing ? "No matches yet — still indexing…" : "No matching games") : "No games found"}
          </div>
        )}
        {rows.map((game) => {
          const selected = selectedId === game.id;
          const subText = selected ? "text-on-secondary-container/80" : "text-on-surface-variant";
          return (
            <button
              key={game.id}
              onClick={() => select(game)}
              className={`w-full text-left px-4 py-3 transition-colors duration-short3 ease-standard ${
                selected ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
              }`}
            >
              <div className="text-body-md truncate flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full shrink-0 ${selected ? "bg-on-secondary-container" : "bg-on-surface"}`} />
                <span className="truncate">{game.white}</span>
                {game.white_elo && <span className={`text-body-sm shrink-0 ${subText}`}>({game.white_elo})</span>}
              </div>
              <div className="text-body-md truncate flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full bg-transparent shrink-0 border ${selected ? "border-on-secondary-container" : "border-on-surface-variant"}`} />
                <span className="truncate">{game.black}</span>
                {game.black_elo && <span className={`text-body-sm shrink-0 ${subText}`}>({game.black_elo})</span>}
              </div>
              <div className={`text-body-sm mt-0.5 flex gap-2 truncate ${subText}`}>
                {game.result && <span className={selected ? "" : "text-on-surface"}>{game.result === "1/2-1/2" ? "½-½" : game.result}</span>}
                {game.date && <span>{game.date.slice(0, 10)}</span>}
                {game.event && <span className="truncate">{game.event}</span>}
              </div>
            </button>
          );
        })}
        {loadingMore && <div className="p-3 text-center text-on-surface-variant text-body-sm">Loading…</div>}
        {!loadingMore && firstPageDone && rows.length < matched && (
          <div className="p-3 text-center text-on-surface-variant/70 text-body-sm">Scroll for more…</div>
        )}
      </div>
    </div>
  );
}
