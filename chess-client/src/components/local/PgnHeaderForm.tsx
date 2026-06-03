// Shared PGN header editor.
//
// Renders structured inputs for the Seven Tag Roster, an "extras" section for
// commonly-used tags (Elo, FIDE IDs), and a free-form key/value list for
// everything else. Player names autocomplete against /api/players and fill
// the matching FIDE ID; FIDE IDs reverse-resolve to names (local DB first,
// then ratings.fide.com via the `fide_player` Tauri command).

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { STR_TAGS, Tag, isValidTagName } from "../../lib/pgnEditor";
import { PlayerInfo, FidePlayer, RatingPoint, ShortlistEntry } from "../../types";

const STR_SET = new Set<string>(STR_TAGS);

/** Tags shown above the custom-tag area when present or added by the user.
 *  Site is part of the PGN Seven Tag Roster but is rarely filled — kept
 *  optional in the UI; `withStrEnsured` (in the host modal) still adds it
 *  with an empty value so spec-required tags are present in saved output. */
// Site moved out of the optional-extras list — it's part of the PGN Seven Tag
// Roster and should always be present in the form (and the saved file).
const COMMON_EXTRAS = ["WhiteElo", "BlackElo", "WhiteFideId", "BlackFideId"] as const;
const COMMON_SET = new Set<string>(COMMON_EXTRAS);

/** Names of FIDE-ID extras, used for special-case rendering. */
const FIDE_ID_TAGS = new Set<string>(["WhiteFideId", "BlackFideId"]);

/** Names of Elo extras, used for special-case rendering (FIDE fetch button). */
const ELO_TAGS = new Set<string>(["WhiteElo", "BlackElo"]);

const RESULT_OPTIONS: { value: string; label: string }[] = [
  { value: "*", label: "* (ongoing / unknown)" },
  { value: "1-0", label: "1–0 (White wins)" },
  { value: "0-1", label: "0–1 (Black wins)" },
  { value: "1/2-1/2", label: "½–½ (draw)" },
];

interface Props {
  tags: Tag[];
  onChange: (tags: Tag[]) => void;
  /** Optional: allow caller to focus the first input on mount. */
  autoFocus?: boolean;
  /**
   * Disable the White and Black name inputs unconditionally. Used when
   * editing an existing DB game's headers — per-game name edits would
   * desynchronise from the player record. Use player merge / set-fide-id
   * to fix players instead.
   */
  lockPlayerNames?: boolean;
  /**
   * Lock the corresponding FIDE-ID input. Used in DB-edit mode when the
   * player record already has a FIDE ID, so users can't drift the per-game
   * tag away from the canonical value. Players without a FIDE ID stay
   * editable so the "Save to player record" backfill still works.
   */
  lockedFideIds?: { white: boolean; black: boolean };
}

function getValue(tags: Tag[], name: string): string {
  const t = tags.find((x) => x.name === name);
  return t ? t.value : "";
}

function hasTag(tags: Tag[], name: string): boolean {
  return tags.some((t) => t.name === name);
}

function setTagValue(tags: Tag[], name: string, value: string): Tag[] {
  const idx = tags.findIndex((t) => t.name === name);
  if (idx === -1) return [...tags, { name, value }];
  const next = tags.slice();
  next[idx] = { name, value };
  return next;
}

function removeTag(tags: Tag[], name: string): Tag[] {
  return tags.filter((t) => t.name !== name);
}

export default function PgnHeaderForm({
  tags, onChange, autoFocus, lockPlayerNames, lockedFideIds,
}: Props) {
  // Initially show extras whose tag is present *and non-empty*. Empty STR
  // tags (Site is part of the STR even when blank) shouldn't surface as
  // visible rows — the user adds them via the "+ Site" chip if needed.
  const [extrasShown, setExtrasShown] = useState<string[]>(() =>
    COMMON_EXTRAS.filter((n) => getValue(tags, n).trim() !== ""),
  );
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const customTags = useMemo(
    () => tags.filter((t) => !STR_SET.has(t.name) && !COMMON_SET.has(t.name)),
    [tags],
  );

  const extrasAvailable = COMMON_EXTRAS.filter((n) => !extrasShown.includes(n));

  function setStrValue(name: string, value: string) {
    onChange(setTagValue(tags, name, value));
  }

  function showExtra(name: string) {
    setExtrasShown((prev) => (prev.includes(name) ? prev : [...prev, name]));
    if (!hasTag(tags, name)) onChange(setTagValue(tags, name, ""));
  }

  function hideExtra(name: string) {
    setExtrasShown((prev) => prev.filter((n) => n !== name));
    onChange(removeTag(tags, name));
  }

  function pickPlayer(color: "White" | "Black", player: PlayerInfo) {
    let next = setTagValue(tags, color, player.name);
    const fideTag = `${color}FideId`;
    if (player.fide_id !== null) {
      next = setTagValue(next, fideTag, String(player.fide_id));
      setExtrasShown((prev) => (prev.includes(fideTag) ? prev : [...prev, fideTag]));
    }
    onChange(next);
  }

  function setFideId(color: "White" | "Black", value: string) {
    setStrValue(`${color}FideId`, value);
  }

  function fillNameFromLookup(color: "White" | "Black", name: string) {
    onChange(setTagValue(tags, color, name));
  }

  function addCustomTag() {
    setAddError(null);
    const name = newName.trim();
    if (!isValidTagName(name)) {
      setAddError("Invalid tag name: must start with a letter, then letters/digits/underscore.");
      return;
    }
    if (hasTag(tags, name)) {
      setAddError(`Tag "${name}" already exists.`);
      return;
    }
    onChange([...tags, { name, value: newValue }]);
    setNewName("");
    setNewValue("");
  }

  function deleteCustomTag(name: string) {
    onChange(removeTag(tags, name));
  }

  function setCustomValue(name: string, value: string) {
    onChange(setTagValue(tags, name, value));
  }

  return (
    <div className="space-y-4">
      {/* Seven Tag Roster — structured inputs */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <EventInput
          value={getValue(tags, "Event")}
          onChange={(v) => setStrValue("Event", v)}
          autoFocus={autoFocus}
        />
        <LabeledInput
          label="Site"
          value={getValue(tags, "Site")}
          onChange={(v) => setStrValue("Site", v)}
          placeholder="City COUNTRY (e.g. Vienna AUT)"
          fullWidth
        />
        <LabeledInput
          label="Date"
          value={getValue(tags, "Date")}
          onChange={(v) => setStrValue("Date", v)}
          placeholder="YYYY-MM-DD"
          hint='ISO 8601. Use "?" for unknown parts, e.g. 2026-??-??'
          mono
        />
        <LabeledInput
          label="Round"
          value={getValue(tags, "Round")}
          onChange={(v) => setStrValue("Round", v)}
          placeholder='-'
        />
        <PlayerNameInput
          label="White"
          value={getValue(tags, "White")}
          onChangeText={(v) => setStrValue("White", v)}
          onPickPlayer={(p) => pickPlayer("White", p)}
          locked={!!lockPlayerNames || getValue(tags, "WhiteFideId").trim() !== ""}
          lockReason={lockPlayerNames ? "DB game — edit via player merge" : undefined}
        />
        <PlayerNameInput
          label="Black"
          value={getValue(tags, "Black")}
          onChangeText={(v) => setStrValue("Black", v)}
          onPickPlayer={(p) => pickPlayer("Black", p)}
          locked={!!lockPlayerNames || getValue(tags, "BlackFideId").trim() !== ""}
          lockReason={lockPlayerNames ? "DB game — edit via player merge" : undefined}
        />
        <LabeledSelect
          label="Result"
          value={getValue(tags, "Result") || "*"}
          onChange={(v) => setStrValue("Result", v)}
          options={RESULT_OPTIONS}
          fullWidth
        />
      </div>

      {/* Common extras (Elo, FIDE IDs) — shown when present or via add-buttons */}
      {(extrasShown.length > 0 || extrasAvailable.length > 0) && (
        <div className="border-t border-outline-variant pt-3 space-y-2">
          {extrasShown.length > 0 && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              {extrasShown.map((name) => {
                if (FIDE_ID_TAGS.has(name)) {
                  const color = name.startsWith("White") ? "White" : "Black";
                  const fideLocked = !!(lockedFideIds && (color === "White" ? lockedFideIds.white : lockedFideIds.black));
                  return (
                    <PlayerFideIdInput
                      key={name}
                      label={name}
                      value={getValue(tags, name)}
                      currentName={getValue(tags, color)}
                      onChange={(v) => setFideId(color, v)}
                      onUseName={(n) => fillNameFromLookup(color, n)}
                      onRemove={() => hideExtra(name)}
                      locked={fideLocked}
                      lockReason={fideLocked ? "DB game — edit via player merge" : undefined}
                    />
                  );
                }
                if (ELO_TAGS.has(name)) {
                  const color = name.startsWith("White") ? "White" : "Black";
                  return (
                    <PlayerEloInput
                      key={name}
                      label={name}
                      value={getValue(tags, name)}
                      fideId={getValue(tags, `${color}FideId`)}
                      gameDate={getValue(tags, "Date")}
                      onChange={(v) => setStrValue(name, v)}
                      onRemove={() => hideExtra(name)}
                    />
                  );
                }
                return (
                  <LabeledInput
                    key={name}
                    label={name}
                    value={getValue(tags, name)}
                    onChange={(v) => setStrValue(name, v)}
                    onRemove={() => hideExtra(name)}
                  />
                );
              })}
            </div>
          )}
          {extrasAvailable.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-label-md text-on-surface-variant">
              <span>Add:</span>
              {extrasAvailable.map((name) => (
                /* M3 assist chip */
                <button
                  key={name}
                  type="button"
                  onClick={() => showExtra(name)}
                  className="text-label-sm px-3 h-7 inline-flex items-center rounded-full border border-outline text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
                >
                  + {name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Custom tags */}
      {customTags.length > 0 && (
        <div className="border-t border-outline-variant pt-3 space-y-2">
          <div className="text-label-sm text-on-surface-variant uppercase tracking-wider">Other tags</div>
          {customTags.map((t) => (
            <div key={t.name} className="flex items-center gap-2">
              <div
                className="w-32 shrink-0 text-body-sm font-mono text-on-surface-variant truncate"
                title={t.name}
              >
                {t.name}
              </div>
              <input
                type="text"
                value={t.value}
                onChange={(e) => setCustomValue(t.name, e.target.value)}
                className="flex-1 min-w-0 h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
              />
              <button
                onClick={() => deleteCustomTag(t.name)}
                className="w-8 h-8 shrink-0 rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 inline-flex items-center justify-center transition-colors duration-short3 ease-standard"
                title="Remove tag"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add a custom tag */}
      <div className="border-t border-outline-variant pt-3">
        <div className="text-label-md text-on-surface-variant mb-1.5">Add tag</div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name"
            className="w-32 shrink-0 h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm font-mono border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant transition-colors duration-short3 ease-standard"
          />
          <input
            type="text"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="Value"
            onKeyDown={(e) => {
              if (e.key === "Enter") addCustomTag();
            }}
            className="flex-1 min-w-0 h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant transition-colors duration-short3 ease-standard"
          />
          {/* Filled tonal */}
          <button
            onClick={addCustomTag}
            disabled={!newName.trim()}
            className="h-9 px-4 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 transition-all duration-short3 ease-standard"
          >
            Add
          </button>
        </div>
        {addError && <p className="text-label-sm text-error mt-1">{addError}</p>}
      </div>
    </div>
  );
}

// ── Player widgets ───────────────────────────────────────────────────────────

/**
 * Player name input with autocomplete from /api/players?name=. Picking a
 * suggestion fills both the name (free text) and the matching FIDE ID via
 * onPickPlayer; free typing falls through onChangeText.
 */
function PlayerNameInput({
  label, value, onChangeText, onPickPlayer, locked, lockReason,
}: {
  label: "White" | "Black";
  value: string;
  onChangeText: (v: string) => void;
  onPickPlayer: (player: PlayerInfo) => void;
  locked: boolean;
  lockReason?: string;
}) {
  const [suggestions, setSuggestions] = useState<PlayerInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (locked) { setSuggestions([]); return; }
    const q = value.trim();
    if (q.length < 2) { setSuggestions([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/players?name=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => r.ok ? r.json() : [])
        .then((data: PlayerInfo[]) => setSuggestions(data.slice(0, 8)))
        .catch(() => {});
    }, 150);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [value, locked]);

  useEffect(() => { setHighlighted(0); }, [suggestions, open]);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function pick(p: PlayerInfo) {
    onPickPlayer(p);
    setOpen(false);
  }

  const showDropdown = !locked && open && suggestions.length > 0;

  return (
    <div ref={ref}>
      <label className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-0.5 block">
        {label}
      </label>
      <div className="relative">
        <input
          type="text"
          value={value}
          disabled={locked}
          onChange={(e) => { if (!locked) { onChangeText(e.target.value); setOpen(true); } }}
          onFocus={() => { if (!locked) setOpen(true); }}
          onKeyDown={(e) => {
            if (locked) return;
            if (!showDropdown) {
              if (e.key === "ArrowDown") { setOpen(true); e.preventDefault(); }
              return;
            }
            if (e.key === "ArrowDown") { setHighlighted((i) => Math.min(suggestions.length - 1, i + 1)); e.preventDefault(); }
            else if (e.key === "ArrowUp") { setHighlighted((i) => Math.max(0, i - 1)); e.preventDefault(); }
            else if (e.key === "Enter" && suggestions[highlighted]) { pick(suggestions[highlighted]); e.preventDefault(); }
            else if (e.key === "Escape") { setOpen(false); }
          }}
          placeholder="Last, First"
          title={locked ? (lockReason ?? "Locked by FIDE ID — remove the FIDE ID to edit the name") : undefined}
          className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant disabled:opacity-70 disabled:cursor-not-allowed transition-colors duration-short3 ease-standard"
        />
        {showDropdown && (
          <div className="absolute z-10 left-0 right-0 mt-1 bg-surface-container-high rounded-md shadow-xl max-h-56 overflow-y-auto py-1">
            {suggestions.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p)}
                onMouseEnter={() => setHighlighted(i)}
                className={`w-full text-left px-3 py-2 text-body-sm transition-colors duration-short3 ease-standard ${i === highlighted ? "bg-on-surface/8" : ""} hover:bg-on-surface/8`}
              >
                <div className="text-on-surface truncate">{p.name}</div>
                <div className="text-label-sm text-on-surface-variant">
                  {p.fide_id !== null ? `FIDE ${p.fide_id} · ` : ""}{p.game_count} games
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {locked && (
        <p className="text-label-sm text-on-surface-variant mt-0.5">
          {lockReason ?? "Locked by FIDE ID — remove it to edit."}
        </p>
      )}
    </div>
  );
}

/** Normalize a player name the way the DB does (case + comma + whitespace). */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/,/g, " ").split(/\s+/).filter(Boolean).join(" ");
}

/**
 * FIDE ID input that reverse-resolves to a player name (local DB first, then
 * ratings.fide.com via the `fide_player` Tauri command). When a name is found
 * and differs from the current value, an "Use this name" link offers to fill it.
 *
 * Also offers a "Save to player record" action: if the current name matches a
 * player in the DB who has no FIDE ID yet, posting to /api/players/:id/fide-id
 * back-fills the row so all of that player's existing games pick up the ID.
 */
function PlayerFideIdInput({
  label, value, currentName, onChange, onUseName, onRemove, locked, lockReason,
}: {
  label: string;
  value: string;
  currentName: string;
  onChange: (v: string) => void;
  onUseName: (name: string) => void;
  onRemove: () => void;
  locked?: boolean;
  lockReason?: string;
}) {
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [namedPlayer, setNamedPlayer] = useState<PlayerInfo | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reverse-resolve the FIDE ID → player name.
  useEffect(() => {
    const trimmed = value.trim();
    setError(null);
    setResolvedName(null);
    setSaveState("idle");
    setSaveError(null);
    if (trimmed === "") return;
    const id = parseInt(trimmed, 10);
    if (!Number.isFinite(id) || id <= 0) {
      setError("Must be a positive integer");
      return;
    }

    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setResolving(true);
      try {
        const res = await fetch(`/api/players?fide_id=${id}`, { signal: ctrl.signal });
        if (res.ok) {
          const arr: PlayerInfo[] = await res.json();
          if (arr.length > 0) {
            setResolvedName(arr[0].name);
            return;
          }
        }
        const fp = await invoke<FidePlayer | null>("fide_player", { fideId: id });
        if (fp?.name) setResolvedName(fp.name);
        else setError("No player found with this FIDE ID");
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError(String(e));
      } finally {
        setResolving(false);
      }
    }, 400);

    return () => { clearTimeout(t); ctrl.abort(); };
  }, [value]);

  // FIDE ID is authoritative: whenever resolution returns a canonical name,
  // overwrite the (locked) name field. This both fills it when empty and
  // normalises any prior spelling to the FIDE form.
  useEffect(() => {
    if (resolvedName && resolvedName !== currentName) {
      onUseName(resolvedName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedName]);

  // Look up the named player in the DB — if they exist with no FIDE ID, we
  // offer to back-fill from this input.
  useEffect(() => {
    setNamedPlayer(null);
    setSaveState("idle");
    setSaveError(null);
    const name = currentName.trim();
    if (name.length < 2) return;

    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/players?name=${encodeURIComponent(name)}`, { signal: ctrl.signal });
        if (!res.ok) return;
        const arr: PlayerInfo[] = await res.json();
        const target = normalizeName(name);
        const match = arr.find((p) => normalizeName(p.name) === target);
        if (match) setNamedPlayer(match);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {/* silent */}
      }
    }, 250);

    return () => { clearTimeout(t); ctrl.abort(); };
  }, [currentName]);

  const numericFideId = (() => {
    const n = parseInt(value.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  const canSaveToPlayer =
    saveState !== "saved" &&
    saveState !== "saving" &&
    numericFideId !== null &&
    namedPlayer !== null &&
    namedPlayer.fide_id === null;

  async function saveToPlayer() {
    if (!namedPlayer || numericFideId === null) return;
    setSaveState("saving");
    setSaveError(null);

    // The HTTP serve runs read-only; writes go through the chess-db CLI as a
    // sidecar. Tauri's parent will kill the read-only serve, take the write
    // lock, run the subcommand, and respawn serve afterwards.
    const eventId = crypto.randomUUID();
    const eventName = `chess-db:${eventId}`;
    // Collect every error event the sidecar emits — the synthesised "exited
    // with status N" arrives last, so we want the earlier lines (clap parse
    // errors, anyhow messages) for a useful diagnostic.
    const errorMessages: string[] = [];
    let didSucceed = false;

    const unlisten = await listen<string>(eventName, (event) => {
      try {
        const data = JSON.parse(event.payload);
        if (data.type === "error" && data.message) errorMessages.push(data.message);
        else if (data.type === "done") didSucceed = true;
      } catch {/* ignore non-JSON lines */}
    });

    try {
      await invoke("run_chess_db", {
        args: ["players", "set-fide-id", String(namedPlayer.id), String(numericFideId)],
        eventId,
      });
      if (didSucceed && errorMessages.length === 0) {
        setSaveState("saved");
      } else {
        setSaveState("error");
        setSaveError(errorMessages.join("\n") || "Save failed");
      }
    } catch (e) {
      setSaveState("error");
      setSaveError(String(e));
    } finally {
      unlisten();
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <label className="text-label-sm text-on-surface-variant uppercase tracking-wider">{label}</label>
        {!locked && (
          <button
            type="button"
            onClick={onRemove}
            className="text-label-sm text-on-surface-variant hover:text-on-surface transition-colors duration-short3 ease-standard"
            title={`Remove ${label}`}
          >
            remove
          </button>
        )}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={locked}
        placeholder="e.g. 1503014"
        inputMode="numeric"
        title={locked ? lockReason : undefined}
        className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm font-mono border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant disabled:opacity-70 disabled:cursor-not-allowed transition-colors duration-short3 ease-standard"
      />
      <div className="text-label-sm mt-0.5 min-h-[14px] space-y-0.5">
        {locked && lockReason && <div className="text-on-surface-variant">{lockReason}</div>}
        {!locked && resolving && <div className="text-on-surface-variant">looking up…</div>}
        {!locked && !resolving && error && <div className="text-warning">{error}</div>}
        {!locked && !resolving && resolvedName && (
          <div className="text-on-surface-variant">→ {resolvedName}</div>
        )}
        {!locked && canSaveToPlayer && (
          <div className="text-on-surface-variant">
            {namedPlayer!.game_count} game{namedPlayer!.game_count !== 1 ? "s" : ""} in DB without a FIDE ID.{" "}
            <button
              type="button"
              onClick={saveToPlayer}
              className="text-primary hover:brightness-125 underline transition-all duration-short3 ease-standard"
            >
              Save to player record
            </button>
          </div>
        )}
        {!locked && saveState === "saving" && <div className="text-on-surface-variant">saving…</div>}
        {!locked && saveState === "saved" && <div className="text-success">✓ saved to player record</div>}
        {!locked && saveState === "error" && (
          <div className="text-warning">{saveError ?? "Save failed"}</div>
        )}
      </div>
    </div>
  );
}

// ── Event autocomplete (uses Prep shortlist) ─────────────────────────────────

/** Cache the shortlist across mounts of the form so the dropdown opens
 *  instantly on subsequent uses without refetching from Tauri. Cleared by
 *  page reload — fresh enough for current UX. */
let shortlistCache: ShortlistEntry[] | null = null;

function EventInput({
  value, onChange, autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  const [shortlist, setShortlist] = useState<ShortlistEntry[]>(shortlistCache ?? []);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (shortlistCache !== null) return;
    invoke<ShortlistEntry[]>("get_shortlist")
      .then((data) => { shortlistCache = data; setShortlist(data); })
      .catch(() => { shortlistCache = []; });
  }, []);

  useEffect(() => { setHighlighted(0); }, [value, open]);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const q = value.trim().toLowerCase();
  const matches = q.length === 0
    ? shortlist
    : shortlist.filter((e) => e.name.toLowerCase().includes(q));

  function pick(entry: ShortlistEntry) {
    onChange(entry.name);
    setOpen(false);
  }

  const showDropdown = open && matches.length > 0;

  return (
    <div ref={ref} className="col-span-2">
      <label className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-0.5 block">
        Event
      </label>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (!showDropdown) {
              if (e.key === "ArrowDown") { setOpen(true); e.preventDefault(); }
              return;
            }
            if (e.key === "ArrowDown") { setHighlighted((i) => Math.min(matches.length - 1, i + 1)); e.preventDefault(); }
            else if (e.key === "ArrowUp") { setHighlighted((i) => Math.max(0, i - 1)); e.preventDefault(); }
            else if (e.key === "Enter" && matches[highlighted]) { pick(matches[highlighted]); e.preventDefault(); }
            else if (e.key === "Escape") { setOpen(false); }
          }}
          placeholder="Tournament name (or pick from your prep shortlist)"
          autoFocus={autoFocus}
          className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant transition-colors duration-short3 ease-standard"
        />
        {showDropdown && (
          <div className="absolute z-10 left-0 right-0 mt-1 bg-surface-container-high rounded-md shadow-xl max-h-56 overflow-y-auto py-1">
            {matches.map((e, i) => (
              <button
                key={`${e.kind}-${e.id}`}
                type="button"
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => pick(e)}
                onMouseEnter={() => setHighlighted(i)}
                className={`w-full text-left px-3 py-2 text-body-sm transition-colors duration-short3 ease-standard ${i === highlighted ? "bg-on-surface/8" : ""} hover:bg-on-surface/8`}
              >
                <div className="text-on-surface truncate">{e.name}</div>
                <div className="text-label-sm text-on-surface-variant">
                  {e.kind === "Team" ? "Team tournament" : "Individual tournament"}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Elo input with FIDE fetch button ─────────────────────────────────────────

/** Extract "YYYY-MM" from a date tag value. Canonical PGN uses dots
 *  ("YYYY.MM.DD") but imports sometimes carry ISO dashes ("YYYY-MM-DD")
 *  or slashes; each component can also be "??". We ignore the day,
 *  treat unknown months as January, and bail on bad input. */
function pgnDateToYearMonth(pgnDate: string): string | null {
  const m = pgnDate.trim().match(/^(\d{4})(?:[.\-/](\d{2}|\?\?))?/);
  if (!m) return null;
  const year = m[1];
  const month = m[2] && m[2] !== "??" ? m[2] : "01";
  return `${year}-${month}`;
}

/** Pick the rating that was active at `targetYM`. FIDE publishes the rating
 *  for period P at the start of P, so we want the most recent point with
 *  `period <= targetYM`. If none precedes it (game predates the player's
 *  first rating), fall back to the earliest known rating. */
function ratingForPeriod(history: RatingPoint[], targetYM: string): number | null {
  if (history.length === 0) return null;
  let best: RatingPoint | null = null;
  for (const p of history) {
    if (p.period <= targetYM) best = p;
    else break;
  }
  return (best ?? history[0]).rating;
}

function PlayerEloInput({
  label, value, fideId, gameDate, onChange, onRemove,
}: {
  label: string;
  value: string;
  fideId: string;
  /** PGN Date tag value of the current game ("YYYY.MM.DD" or partial).
   *  Used to look up the player's rating *as of that period*. */
  gameDate?: string;
  onChange: (v: string) => void;
  onRemove: () => void;
}) {
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const numericFideId = (() => {
    const n = parseInt(fideId.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  const targetYM = gameDate ? pgnDateToYearMonth(gameDate) : null;

  async function fetchFromFide() {
    if (numericFideId === null) return;
    setFetching(true);
    setError(null);
    try {
      let rating: number | null = null;
      // 1. Historical period (when we have a parseable game date).
      if (targetYM) {
        try {
          const history = await invoke<RatingPoint[]>("fide_rating_history", { fideId: numericFideId });
          rating = ratingForPeriod(history, targetYM);
        } catch {
          // history fetch failed — fall through to current-rating fallback
        }
      }
      // 2. Fallback: current standard rating.
      if (rating === null) {
        const fp = await invoke<FidePlayer | null>("fide_player", { fideId: numericFideId });
        rating = fp?.rating ?? null;
      }
      if (rating !== null) onChange(String(rating));
      else setError("No standard rating returned by FIDE");
    } catch (e) {
      setError(String(e));
    } finally {
      setFetching(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <label className="text-label-sm text-on-surface-variant uppercase tracking-wider">{label}</label>
        <button
          type="button"
          onClick={onRemove}
          className="text-label-sm text-on-surface-variant hover:text-on-surface transition-colors duration-short3 ease-standard"
          title={`Remove ${label}`}
        >
          remove
        </button>
      </div>
      <div className="flex gap-1">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="numeric"
          placeholder="e.g. 1850"
          className="flex-1 min-w-0 h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm font-mono border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant transition-colors duration-short3 ease-standard"
        />
        {numericFideId !== null && (
          <button
            type="button"
            onClick={fetchFromFide}
            disabled={fetching}
            title={targetYM
              ? `Fetch standard rating as of ${targetYM} from ratings.fide.com (falls back to current if unavailable)`
              : "Fetch current standard rating from ratings.fide.com"}
            className="h-9 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 disabled:opacity-50 transition-all duration-short3 ease-standard"
          >
            {fetching ? "…" : "↻ FIDE"}
          </button>
        )}
      </div>
      {error && <p className="text-label-sm text-warning mt-0.5">{error}</p>}
    </div>
  );
}

// ── Generic atoms ────────────────────────────────────────────────────────────

interface LabeledInputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  fullWidth?: boolean;
  autoFocus?: boolean;
  onRemove?: () => void;
}

function LabeledInput({
  label, value, onChange, placeholder, hint, mono, fullWidth, autoFocus, onRemove,
}: LabeledInputProps) {
  return (
    <div className={fullWidth ? "col-span-2" : ""}>
      <div className="flex items-center justify-between mb-0.5">
        <label className="text-label-sm text-on-surface-variant uppercase tracking-wider">{label}</label>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-label-sm text-on-surface-variant hover:text-on-surface transition-colors duration-short3 ease-standard"
            title={`Remove ${label}`}
          >
            remove
          </button>
        )}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={`w-full h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant transition-colors duration-short3 ease-standard ${
          mono ? "font-mono" : ""
        }`}
      />
      {hint && <p className="text-label-sm text-on-surface-variant mt-0.5">{hint}</p>}
    </div>
  );
}

interface LabeledSelectProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  fullWidth?: boolean;
}

function LabeledSelect({ label, value, onChange, options, fullWidth }: LabeledSelectProps) {
  return (
    <div className={fullWidth ? "col-span-2" : ""}>
      <label className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-0.5 block">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
