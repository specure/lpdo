// Add games to the database.
//
// One unified entry point with three input modes:
//   - From scratch: fill out a header (PgnHeaderForm) for a brand new game.
//   - Paste PGN:    paste one or more PGN games (e.g. from lichess).
//   - From file:    point at a .pgn file or a folder of .pgn files.
//
// All three modes feed the same `import-pgn` sidecar pipeline (dedup, FIDE-id
// resolution, position indexing). For scratch/paste the content is written to
// a temp file via `write_temp_pgn_file` so the sidecar can ingest a path.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Tag, buildBlock, defaultNewGameTags, rememberPgnSite } from "../lib/pgnEditor";
import { splitPgnFile } from "../lib/pgnSplitter";
import { useSidecarProgress } from "../hooks/useSidecarProgress";
import PgnHeaderForm from "./local/PgnHeaderForm";

// "replace" is supported by the CLI's value-parser but not actually implemented,
// so it is intentionally not offered here.
type DedupMode = "skip" | "always";
type Mode = "scratch" | "paste" | "file";

interface CollectionInfo {
  id: number;
  name: string;
  game_count: number;
}

interface Preset {
  key: string;
  label: string;
  collection: string;
  isPublic: boolean;
}

const PRESETS: Preset[] = [
  { key: "own",        label: "My games (private)",   collection: "My games",    isPublic: false },
  { key: "megabase",   label: "Megabase (public)",    collection: "Megabase",    isPublic: true  },
  { key: "bundesliga", label: "Bundesliga (public)",  collection: "Bundesliga",  isPublic: true  },
];

interface Props {
  embedded?: boolean;
  initialMode?: Mode;
  /** Restrict which input modes are offered. When one mode remains the tab bar
   *  is hidden. Defaults to all three. The setup wizard passes `["file"]`, since
   *  scratch/paste are only useful for adding games after initial setup. */
  allowedModes?: Mode[];
  /** Prefilled tag set for "From scratch" mode. Falls back to `defaultNewGameTags`. */
  initialTags?: Tag[];
  onClose: () => void;
  /** Fires once the sidecar reports done (or on Done click in modal mode). */
  onImported?: () => void;
  /** Fires when the running flag flips. Used by SetupWizard to disable nav. */
  onRunningChange?: (running: boolean) => void;
  /** Bulk import (the wizard's Databases step): use --fast appender inserts and
   *  skip per-import position indexing — the wizard's Index step rebuilds the
   *  whole position index at the end, so indexing here would be wasted work. */
  bulk?: boolean;
}

const ALL_MODES: { mode: Mode; label: string }[] = [
  { mode: "scratch", label: "From scratch" },
  { mode: "paste",   label: "Paste PGN" },
  { mode: "file",    label: "From file" },
];

export default function AddGameDialog({
  embedded = false,
  initialMode,
  allowedModes,
  initialTags,
  onClose,
  onImported,
  onRunningChange,
  bulk = false,
}: Props) {
  const visibleModes = ALL_MODES.filter((m) => !allowedModes || allowedModes.includes(m.mode));
  const [mode, setMode] = useState<Mode>(initialMode ?? (embedded ? "file" : "scratch"));

  // Per-mode inputs
  const [tags, setTags] = useState<Tag[]>(initialTags ?? defaultNewGameTags);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [path, setPath] = useState("");

  // Shared
  const [collectionName, setCollectionName] = useState("My games");
  const [isPublic, setIsPublic] = useState(false);
  const [dedup, setDedup] = useState<DedupMode>("skip");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [lastAction, setLastAction] = useState<"import" | "normalise">("import");

  const progress = useSidecarProgress();
  const importedFiredRef = useRef(false);

  useEffect(() => { onRunningChange?.(progress.running); }, [progress.running]);

  useEffect(() => {
    fetch("/api/collections").then((r) => r.ok ? r.json() : []).then(setCollections).catch(() => {});
  }, []);

  // Embedded callers (SetupWizard) have no Done button — fire onImported once
  // when the import succeeds. Modal mode fires it from the explicit Done click.
  useEffect(() => {
    if (embedded && progress.done && !importedFiredRef.current) {
      importedFiredRef.current = true;
      onImported?.();
    }
  }, [embedded, progress.done]);

  const pastePreview = useMemo(() => {
    if (mode !== "paste" || !pasteText.trim()) return [];
    try { return splitPgnFile(pasteText); } catch { return []; }
  }, [mode, pasteText]);

  const scratchValid = useMemo(() => {
    const w = tags.find((t) => t.name === "White")?.value.trim() ?? "";
    const b = tags.find((t) => t.name === "Black")?.value.trim() ?? "";
    return w.length > 0 && b.length > 0;
  }, [tags]);

  const inputValid =
    mode === "scratch" ? scratchValid :
    mode === "paste"   ? pastePreview.length > 0 :
                         path.trim().length > 0;

  const canRun =
    inputValid &&
    !!collectionName.trim() &&
    !progress.running &&
    !progress.done;

  function applyPreset(p: Preset) {
    if (p.collection) setCollectionName(p.collection);
    setIsPublic(p.isPublic);
  }

  async function pasteFromClipboard() {
    setPasteError(null);
    try {
      const t = await navigator.clipboard.readText();
      if (t.trim()) setPasteText(t);
    } catch (e) {
      setPasteError(`Could not read clipboard: ${String(e)}. Paste with Ctrl+V instead.`);
    }
  }

  async function run() {
    setLastAction("import");
    setPasteError(null);
    let content: string;
    try {
      if (mode === "file") {
        // Read the file client-side — the app runs as the user, so it can read the
        // home dir — and upload its content. The sandboxed system daemon can't open
        // a path under $HOME or /tmp, so passing a path fails (#121).
        content = await invoke<string>("read_pgn_file", { path: path.trim() });
      } else {
        if (mode === "scratch") {
          // Persist the user's chosen Site as the default for future new games.
          rememberPgnSite(tags.find((t) => t.name === "Site")?.value ?? "");
        }
        content = mode === "paste"
          ? pasteText
          : buildBlock(tags, tags.find((t) => t.name === "Result")?.value || "*");
      }
    } catch (e) {
      setPasteError(String(e));
      return;
    }
    const args = [
      "import-pgn",
      "--content", content,
      "--collection", collectionName.trim(),
      "--on-duplicate", dedup,
    ];
    if (bulk) {
      // Fast bulk load for large databases (Megabase, Bundesliga): appender
      // inserts, and skip position indexing here (--max-position-depth 0) since
      // the wizard's Index step rebuilds the whole position index afterwards.
      args.push("--fast", "--max-position-depth", "0");
    }
    if (!isPublic) args.push("--private");
    void progress.run(args);
  }

  function runNormalise() {
    setLastAction("normalise");
    void progress.run(["players", "normalise"]);
  }

  function handleClose() {
    if (progress.running && !window.confirm("An import is in progress. Close anyway?")) return;
    onClose();
  }

  function handleDone() {
    onImported?.();
    onClose();
  }

  const locked = progress.running || progress.done;

  const body = (
    <div className="space-y-4">
      {/* M3 primary tabs — bottom indicator on active tab. Hidden when only a
          single mode is offered (e.g. the setup wizard's file-only import). */}
      {visibleModes.length > 1 && (
        <div className="flex border-b border-outline-variant -mx-5 px-5">
          {visibleModes.map((m) => (
            <Tab key={m.mode} active={mode === m.mode} onClick={() => setMode(m.mode)}>{m.label}</Tab>
          ))}
        </div>
      )}

      {/* Per-mode input section */}
      {mode === "scratch" && (
        <PgnHeaderForm tags={tags} onChange={setTags} autoFocus />
      )}
      {mode === "paste" && (
        <PasteSection
          text={pasteText}
          setText={setPasteText}
          preview={pastePreview}
          pasteError={pasteError}
          locked={locked}
          onPasteFromClipboard={pasteFromClipboard}
        />
      )}
      {mode === "file" && (
        <FileSection path={path} setPath={setPath} locked={locked} />
      )}

      {/* Shared collection + visibility */}
      <div className="pt-3 space-y-3">
        <Field label="Collection" hint="Pick an existing collection or type a new name. The same collection can hold games from many imports.">
          <Combobox
            value={collectionName}
            onChange={setCollectionName}
            placeholder="e.g. Bundesliga 2024"
            disabled={locked}
            options={collections.map((c) => ({
              value: c.name, label: c.name, secondary: `${c.game_count} games`,
            }))}
          />
          <div className="flex flex-wrap gap-1.5 mt-2">
            <span className="text-label-sm text-on-surface-variant self-center mr-1">Quick fill:</span>
            {PRESETS.map((p) => (
              /* M3 assist chip */
              <button
                key={p.key}
                type="button"
                disabled={locked}
                onClick={() => applyPreset(p)}
                className="text-label-sm px-3 h-7 inline-flex items-center rounded-full border border-outline text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-50 transition-colors duration-short3 ease-standard"
              >
                {p.label}
              </button>
            ))}
          </div>
        </Field>

        <label className="flex items-center gap-2 text-body-md text-on-surface cursor-pointer">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            disabled={locked}
            className="cursor-pointer accent-primary w-4 h-4"
          />
          <span>
            Public{" "}
            <span className="text-on-surface-variant">— promotes existing private duplicates to public if they match.</span>
          </span>
        </label>

        <button
          onClick={() => setAdvancedOpen(!advancedOpen)}
          disabled={locked}
          className="h-7 px-2 inline-flex items-center rounded-full text-primary text-label-md hover:bg-primary/8 disabled:opacity-50 transition-colors duration-short3 ease-standard"
        >
          {advancedOpen ? "▾" : "▸"} Advanced
        </button>

        {advancedOpen && (
          <div className="space-y-3 pl-3 border-l border-outline-variant">
            <Field label="If a game already exists">
              <Select value={dedup} disabled={locked} onChange={(v) => setDedup(v as DedupMode)} options={[
                { value: "skip",    label: "Skip duplicates (still tags into the collection)" },
                { value: "always",  label: "Always insert (may duplicate)" },
              ]} />
            </Field>
          </div>
        )}
      </div>

      {/* Run / progress */}
      {!progress.running && !progress.done && (
        <div className="space-y-2">
          {/* A failed submit (e.g. the daemon is unreachable) or a job error
              leaves running=false/done=false, so surface it here — otherwise the
              button just silently reappears and the click looks like a no-op. */}
          {(progress.error || pasteError) && (
            <div className="bg-error-container text-on-error-container rounded-md px-3 py-2 text-body-sm">
              Import failed: {progress.error ?? pasteError}
            </div>
          )}
          {/* M3 filled button — full-width primary action */}
          <button
            onClick={run}
            disabled={!canRun}
            className="w-full h-10 rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 transition-all duration-short3 ease-standard"
          >
            Add to database
          </button>
        </div>
      )}

      {(progress.running || progress.done) && (
        <div className="space-y-2">
          <div className="flex justify-between text-label-md text-on-surface-variant">
            <span>
              {progress.done ? "Complete" : (lastAction === "normalise" ? "Normalising players…" : "Adding…")}
            </span>
            <span>{Math.round(progress.percent)}%</span>
          </div>
          <ProgressBar value={progress.percent} />
          <LogBox lines={progress.log} />
          {progress.done && (
            <>
              <p className="text-success text-body-sm">✓ {progress.doneMessage}</p>
              {lastAction === "import" && (
                <div className="bg-tertiary-container text-on-tertiary-container rounded-md p-3 space-y-1.5">
                  <div className="text-title-sm">Next: normalise player names</div>
                  <p className="text-body-sm opacity-80">
                    Reconciles name variants (“Carlsen, M.” ↔ “Carlsen, Magnus”) and
                    fills missing FIDE IDs by looking up ratings.fide.com. Optional
                    but recommended after every import.
                  </p>
                  <button
                    onClick={runNormalise}
                    className="h-8 px-3 inline-flex items-center rounded-full bg-primary text-on-primary text-label-md hover:brightness-110 transition-all duration-short3 ease-standard"
                  >
                    Normalise players
                  </button>
                </div>
              )}
              <div className="flex justify-end">
                <button
                  onClick={() => { progress.reset(); importedFiredRef.current = false; setLastAction("import"); }}
                  className="h-7 px-3 inline-flex items-center rounded-full text-primary text-label-md hover:bg-primary/8 transition-colors duration-short3 ease-standard"
                >
                  Add another
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40"
      onClick={handleClose}
    >
      <div
        className="bg-surface-container-high rounded-xl shadow-2xl w-[44rem] max-w-[92vw] max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 shrink-0 flex items-center justify-between">
          <h2 className="text-title-md text-on-surface">Add games</h2>
          <button onClick={handleClose} className="w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard text-lg leading-none">×</button>
        </div>
        <div className="px-6 py-2 flex-1 overflow-y-auto">{body}</div>
        <div className="px-6 py-4 shrink-0 flex items-center justify-end gap-2">
          {progress.done ? (
            /* Filled button — primary action */
            <button onClick={handleDone} className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard">
              Done
            </button>
          ) : (
            /* Text button */
            <button
              onClick={handleClose}
              disabled={progress.running}
              className="h-9 px-4 inline-flex items-center rounded-full text-primary text-label-lg hover:bg-primary/8 active:bg-primary/12 disabled:opacity-50 transition-colors duration-short3 ease-standard"
            >
              {progress.running ? "Running…" : "Cancel"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-sections ─────────────────────────────────────────────────────────────

function PasteSection({
  text, setText, preview, pasteError, locked, onPasteFromClipboard,
}: {
  text: string;
  setText: (v: string) => void;
  preview: ReturnType<typeof splitPgnFile>;
  pasteError: string | null;
  locked: boolean;
  onPasteFromClipboard: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-label-sm text-on-surface-variant uppercase tracking-wider">PGN</label>
        <button
          onClick={onPasteFromClipboard}
          disabled={locked}
          className="h-7 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 disabled:opacity-50 transition-all duration-short3 ease-standard"
          title="Read clipboard"
        >
          Paste from clipboard
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={locked}
        placeholder='Paste a PGN game here, e.g. from Lichess.&#10;&#10;[Event "Casual game"]&#10;[White "..."]&#10;...'
        rows={10}
        spellCheck={false}
        className="w-full bg-surface-container-lowest text-on-surface text-body-sm font-mono px-3 py-2 rounded-sm border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant resize-y disabled:opacity-50 transition-colors duration-short3 ease-standard"
      />
      {pasteError && <p className="text-body-sm text-error">{pasteError}</p>}
      {text.trim() && preview.length === 0 && (
        <div className="text-body-sm text-warning">
          No games detected. PGN must start with an <code>[Event "…"]</code> tag.
        </div>
      )}
      {preview.length > 0 && (
        <div>
          <div className="text-label-md text-on-surface-variant mb-1">
            Detected {preview.length} game{preview.length !== 1 ? "s" : ""}:
          </div>
          <div className="bg-surface-container rounded-sm max-h-40 overflow-y-auto">
            {preview.map((g, i) => (
              <div key={i} className="px-3 py-2 text-body-sm">
                <div className="text-on-surface truncate">
                  {g.white} {g.white_elo ? `(${g.white_elo})` : ""} – {g.black}{" "}
                  {g.black_elo ? `(${g.black_elo})` : ""}
                </div>
                <div className="text-on-surface-variant flex gap-2 truncate mt-0.5">
                  {g.result && <span>{g.result === "1/2-1/2" ? "½-½" : g.result}</span>}
                  {g.date && <span>{g.date.slice(0, 10)}</span>}
                  {g.event && <span className="truncate">{g.event}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FileSection({ path, setPath, locked }: {
  path: string;
  setPath: (v: string) => void;
  locked: boolean;
}) {
  // M3 outlined "picker" buttons
  const pickerBtn = "h-9 px-4 inline-flex items-center rounded-full border border-outline text-on-surface text-label-md hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-50 transition-colors duration-short3 ease-standard";
  return (
    <Field label="PGN file or folder">
      <div className="flex gap-2">
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/path/to/file.pgn or /path/to/folder"
          disabled={locked}
          className="flex-1 h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm font-mono border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant disabled:opacity-50 transition-colors duration-short3 ease-standard"
        />
        <button
          disabled={locked}
          onClick={async () => {
            const picked = await openDialog({
              multiple: false,
              directory: false,
              filters: [{ name: "PGN", extensions: ["pgn"] }],
            });
            if (typeof picked === "string") setPath(picked);
          }}
          className={pickerBtn}
        >
          File…
        </button>
        <button
          disabled={locked}
          onClick={async () => {
            const picked = await openDialog({ multiple: false, directory: true });
            if (typeof picked === "string") setPath(picked);
          }}
          className={pickerBtn}
        >
          Folder…
        </button>
      </div>
    </Field>
  );
}

// ── UI atoms ─────────────────────────────────────────────────────────────────

function Tab({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  // M3 primary tab — colored text + indicator on active
  return (
    <button
      onClick={onClick}
      className={`px-4 py-3 text-label-lg border-b-2 -mb-px transition-colors duration-short3 ease-standard ${
        active
          ? "text-primary border-primary"
          : "text-on-surface-variant border-transparent hover:text-on-surface hover:bg-on-surface/4"
      }`}
    >
      {children}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-1">{label}</div>
      {children}
      {hint && <p className="text-label-sm text-on-surface-variant mt-1">{hint}</p>}
    </div>
  );
}

interface ComboboxOption { value: string; label: string; secondary?: string }

function Combobox({ value, onChange, placeholder, disabled, options }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  options: ComboboxOption[];
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const q = value.trim().toLowerCase();
  const matches = q.length === 0
    ? options
    : options.filter((o) => o.label.toLowerCase().includes(q));

  useEffect(() => { setHighlighted(0); }, [value, open]);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function pick(opt: ComboboxOption) {
    onChange(opt.value);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open) {
            if (e.key === "ArrowDown") { setOpen(true); e.preventDefault(); }
            return;
          }
          if (e.key === "ArrowDown") { setHighlighted((i) => Math.min(matches.length - 1, i + 1)); e.preventDefault(); }
          else if (e.key === "ArrowUp") { setHighlighted((i) => Math.max(0, i - 1)); e.preventDefault(); }
          else if (e.key === "Enter" && matches[highlighted]) { pick(matches[highlighted]); e.preventDefault(); }
          else if (e.key === "Escape") { setOpen(false); }
        }}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant disabled:opacity-50 transition-colors duration-short3 ease-standard"
      />
      {open && matches.length > 0 && (
        /* M3 menu surface */
        <div className="absolute z-10 left-0 right-0 mt-1 bg-surface-container-high rounded-md shadow-xl max-h-48 overflow-y-auto py-1">
          {matches.map((opt, i) => (
            <button
              key={opt.value}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(opt)}
              onMouseEnter={() => setHighlighted(i)}
              className={`w-full text-left px-3 py-2 text-body-sm transition-colors duration-short3 ease-standard ${
                i === highlighted ? "bg-on-surface/8" : ""
              } hover:bg-on-surface/8`}
            >
              <div className="text-on-surface">{opt.label}</div>
              {opt.secondary && <div className="text-label-sm text-on-surface-variant">{opt.secondary}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Select({ value, onChange, disabled, options }: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary disabled:opacity-50 transition-colors duration-short3 ease-standard"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="w-full bg-surface-container-highest rounded-full h-1.5 overflow-hidden">
      <div className="bg-primary h-1.5 rounded-full transition-all duration-medium2 ease-standard" style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

function LogBox({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="bg-surface-container-lowest rounded-sm p-2 text-label-sm font-mono text-on-surface-variant max-h-32 overflow-y-auto space-y-0.5">
      {lines.slice(-50).map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}
