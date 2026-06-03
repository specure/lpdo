import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ParticipantDto, ShortlistEntry, TeamDto, TournamentMeta } from "../../types";

interface Props {
  onClose: () => void;
  onAdded: (entries: ShortlistEntry[]) => void;
}

type Step = "url" | "individual" | "team";

export default function AddTournamentModal({ onClose, onAdded }: Props) {
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [meta, setMeta] = useState<TournamentMeta | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  // Individual fields
  const [participants, setParticipants] = useState<ParticipantDto[]>([]);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [participantSearch, setParticipantSearch] = useState("");
  const [selectedParticipant, setSelectedParticipant] = useState<ParticipantDto | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Team fields
  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [myTeamName, setMyTeamName] = useState("");
  const [homeBlackBoard1, setHomeBlackBoard1] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Auto-focus search when individual step becomes active
  useEffect(() => {
    if (step === "individual") {
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [step]);

  async function handleDetect() {
    if (!url.trim()) return;
    setDetecting(true);
    setDetectError(null);
    try {
      const result = await invoke<TournamentMeta>("fetch_tournament_meta", { url: url.trim() });
      setMeta(result);
      if (result.kind === "team") {
        setStep("team");
        setTeamsLoading(true);
        invoke<TeamDto[]>("fetch_team_list", { tournamentId: result.id })
          .then((list) => { setTeams(list); if (list.length > 0) setMyTeamName(list[0].name); })
          .catch(() => {})
          .finally(() => setTeamsLoading(false));
      } else {
        setStep("individual");
        setParticipantsLoading(true);
        invoke<ParticipantDto[]>("fetch_participant_list", { tournamentId: result.id })
          .then((list) => setParticipants(list))
          .catch(() => {})
          .finally(() => setParticipantsLoading(false));
      }
    } catch (e) {
      setDetectError(String(e));
    } finally {
      setDetecting(false);
    }
  }

  async function handleAdd() {
    if (!meta) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      let entries: ShortlistEntry[];
      if (meta.kind === "individual") {
        if (!selectedParticipant) { setSubmitError("Select your name from the list."); setSubmitting(false); return; }
        entries = await invoke<ShortlistEntry[]>("add_individual_tournament", {
          url: url.trim(),
          tournamentId: meta.id,
          name: meta.name,
          mySnr: selectedParticipant.snr,
          myName: selectedParticipant.name,
          myFideId: null,
        });
      } else {
        if (!myTeamName.trim()) { setSubmitError("Enter your team name."); setSubmitting(false); return; }
        entries = await invoke<ShortlistEntry[]>("add_team_tournament", {
          url: url.trim(),
          tournamentId: meta.id,
          name: meta.name,
          myTeamName: myTeamName.trim(),
          homeBlackBoard1,
        });
      }
      onAdded(entries);
    } catch (e) {
      setSubmitError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const filteredParticipants = participantSearch.trim()
    ? participants.filter((p) =>
        p.name.toLowerCase().includes(participantSearch.toLowerCase())
      ).slice(0, 50)
    : [];

  // Reusable M3 input style for this dialog
  const textInput = "w-full h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant disabled:opacity-50 transition-colors duration-short3 ease-standard";

  return (
    <div className="fixed inset-0 bg-on-surface/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-container-high rounded-xl shadow-2xl w-full max-w-md mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-title-md text-on-surface mb-5">Add tournament</h2>

        {/* Step 1: URL */}
        <div className="mb-4">
          <label className="block text-label-md text-on-surface-variant mb-1.5">chess-results.com URL or tournament ID</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setMeta(null); setDetectError(null); setStep("url"); setParticipants([]); setSelectedParticipant(null); setParticipantSearch(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleDetect(); }}
              placeholder="https://chess-results.com/tnr1234567.aspx"
              className={`flex-1 ${textInput}`}
            />
            {/* Filled tonal */}
            <button
              onClick={handleDetect}
              disabled={!url.trim() || detecting}
              className="h-9 px-4 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 transition-all duration-short3 ease-standard shrink-0"
            >{detecting ? "Detecting…" : "Detect"}</button>
          </div>
          {detectError && <p className="mt-1.5 text-body-sm text-error">{detectError}</p>}
        </div>

        {/* Detected info */}
        {meta && (
          <div className="mb-4 p-3 bg-surface-container-highest rounded-md text-body-sm">
            <div className="text-on-surface">{meta.name}</div>
            <div className="text-on-surface-variant mt-0.5">
              {meta.kind === "team" ? "Team tournament" : "Individual tournament"} · ID: {meta.id}
            </div>
          </div>
        )}

        {/* Step 2: Individual fields */}
        {step === "individual" && meta && (
          <div className="mb-4">
            <label className="block text-label-md text-on-surface-variant mb-1.5">Your name</label>

            {selectedParticipant ? (
              /* Selected state — sits inside an outlined chip-like row */
              <div className="flex items-center justify-between gap-2 px-3 py-2 bg-surface-container-highest rounded-md text-body-md">
                <span className="text-on-surface truncate">{selectedParticipant.name}</span>
                <span className="text-on-surface-variant text-body-sm shrink-0">
                  SNR {selectedParticipant.snr}{selectedParticipant.rating ? ` · ${selectedParticipant.rating}` : ""}
                </span>
                <button
                  onClick={() => { setSelectedParticipant(null); setParticipantSearch(""); setTimeout(() => searchRef.current?.focus(), 0); }}
                  className="w-6 h-6 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard shrink-0 text-label-sm"
                  title="Clear"
                >✕</button>
              </div>
            ) : (
              /* Search state */
              <div>
                <div className="relative">
                  <input
                    ref={searchRef}
                    type="text"
                    value={participantSearch}
                    onChange={(e) => setParticipantSearch(e.target.value)}
                    placeholder={participantsLoading ? "Loading participants…" : "Type to search…"}
                    disabled={participantsLoading}
                    className={textInput}
                  />
                </div>
                {filteredParticipants.length > 0 && (
                  <div className="mt-1 max-h-48 overflow-y-auto rounded-md bg-surface-container-highest py-1">
                    {filteredParticipants.map((p) => (
                      <button
                        key={p.snr}
                        onClick={() => setSelectedParticipant(p)}
                        className="w-full text-left px-3 py-2 text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard flex items-baseline gap-2"
                      >
                        <span className="flex-1 text-body-md truncate">{p.name}</span>
                        <span className="text-on-surface-variant text-body-sm shrink-0">
                          SNR {p.snr}{p.rating ? ` · ${p.rating}` : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {participantSearch.trim() && !participantsLoading && filteredParticipants.length === 0 && (
                  <p className="mt-1 text-body-sm text-on-surface-variant">No matches.</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Team fields */}
        {step === "team" && meta && (
          <div className="space-y-3 mb-4">
            <div>
              <label className="block text-label-md text-on-surface-variant mb-1.5">Your team</label>
              {teamsLoading ? (
                <div className="text-body-sm text-on-surface-variant py-1">Loading teams…</div>
              ) : teams.length > 0 ? (
                <div className="relative">
                  <select
                    value={myTeamName}
                    onChange={(e) => setMyTeamName(e.target.value)}
                    className="appearance-none w-full h-9 pl-3 pr-7 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary cursor-pointer transition-colors duration-short3 ease-standard"
                  >
                    {teams.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}{t.rtg_avg ? ` (${t.rtg_avg})` : ""}
                      </option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant text-label-sm">▾</span>
                </div>
              ) : (
                <input
                  type="text"
                  value={myTeamName}
                  onChange={(e) => setMyTeamName(e.target.value)}
                  placeholder="e.g. Sc Donaustadt"
                  className={textInput}
                />
              )}
            </div>
            <div>
              <label className="block text-label-md text-on-surface-variant mb-2">Home team color on board 1</label>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-body-md text-on-surface cursor-pointer">
                  <input
                    type="radio"
                    checked={!homeBlackBoard1}
                    onChange={() => setHomeBlackBoard1(false)}
                    className="accent-primary w-4 h-4"
                  />
                  White on board 1, alternating
                </label>
                <label className="flex items-center gap-2 text-body-md text-on-surface cursor-pointer">
                  <input
                    type="radio"
                    checked={homeBlackBoard1}
                    onChange={() => setHomeBlackBoard1(true)}
                    className="accent-primary w-4 h-4"
                  />
                  Black on board 1, alternating
                </label>
              </div>
            </div>
          </div>
        )}

        {submitError && <p className="mb-3 text-body-sm text-error">{submitError}</p>}

        <div className="flex justify-end gap-2">
          {/* Text button */}
          <button
            onClick={onClose}
            className="h-9 px-4 inline-flex items-center rounded-full text-primary text-label-lg hover:bg-primary/8 active:bg-primary/12 transition-colors duration-short3 ease-standard"
          >Cancel</button>
          {step !== "url" && (
            /* Filled button */
            <button
              onClick={handleAdd}
              disabled={submitting}
              className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 transition-all duration-short3 ease-standard"
            >{submitting ? "Adding…" : "Add"}</button>
          )}
        </div>
      </div>
    </div>
  );
}
