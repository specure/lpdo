// Send to phone (#327): a chapter's practice package played as a loop of QR
// codes for the LPDO Trainer on the phone to scan — no network between them.
// The trainer's own address beside it, for a phone that does not have it
// yet; and the file, for when scanning is not at hand.

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { chapterPackage } from "../../lib/practicePackage";
import { qrSettings } from "../../lib/qrSettings";
import { encodeChapter, PARTS_NEEDED, type Frames } from "../../trainer/qrTransfer";
import QrLoop from "./QrLoop";
import { lineEndEvals, type LpdoChapter } from "../../trainer/format";
import { analyseChapters } from "../../lib/repertoire";

export const TRAINER_URL = "https://specure.github.io/lpdo/trainer/";

interface Props {
  chapterId: number;
  onClose: () => void;
  /** Save the package as a file instead (the chapter's Save for phone…). */
  onSaveFile: () => void;
}

export default function SendToPhoneDialog({ chapterId, onClose, onSaveFile }: Props) {
  const [pkg, setPkg] = useState<LpdoChapter | null>(null);
  const [frames, setFrames] = useState<Frames | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The chapter's comments go too when asked: the drill's replay shows them,
  // but they make the code about twice as long to read.
  const [comments, setComments] = useState(false);
  // Analyse now: the job asked for.
  const [analysing, setAnalysing] = useState<"no" | "asked" | "failed">("no");
  // Bytes a frame, frames a second, the code's size: Maintenance → Sending
  // to the phone.
  const [qr] = useState(qrSettings);
  const link = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        setFrames(null);
        const p = await chapterPackage(chapterId, { noComments: !comments });
        const f = await encodeChapter(p, qr.bytes);
        if (!gone) { setPkg(p); setFrames(f); }
      } catch (e) { if (!gone) setError(String(e instanceof Error ? e.message : e)); }
    })();
    return () => { gone = true; };
  }, [chapterId, comments, qr.bytes]);

  useEffect(() => {
    if (link.current) void QRCode.toCanvas(link.current, TRAINER_URL, { width: 132, margin: 1 });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40" onClick={onClose}>
      <div className="bg-surface-container-high rounded-xl shadow-2xl max-w-[94vw] max-h-[94vh] overflow-y-auto p-5 flex flex-col gap-4" style={{ width: `calc(${qr.size}px + 20rem)` }}
        onClick={(e) => e.stopPropagation()}>
        <div>
          <div className="text-title-md text-on-surface">Send to phone</div>
          <div className="text-body-sm text-on-surface-variant">
            {pkg ? <>{pkg.book.name} · {pkg.name}</> : "Preparing the chapter — the database's figures for its positions…"}
          </div>
        </div>
        <div className="flex gap-5 flex-wrap">
          <QrLoop frames={frames} fps={qr.fps} size={qr.size} error={error} />
          <div className="flex-1 min-w-[14rem] flex flex-col gap-3 text-body-sm text-on-surface">
            <ol className="list-decimal pl-5 space-y-1.5">
              <li>On your phone, open the <b>LPDO Trainer</b> and tap <b>Scan</b>.</li>
              <li>Point the camera at the code and hold it steady until the bar is full — a few seconds.</li>
            </ol>
            <label className="flex items-start gap-2 text-body-sm cursor-pointer">
              <input type="checkbox" checked={comments} onChange={(e) => setComments(e.target.checked)} className="accent-primary mt-0.5" />
              <span>Include the chapter's comments <span className="text-on-surface-variant">— shown when you replay a line; about twice as long to scan</span></span>
            </label>
            {/* Not analysed through: the ends of some lines lack Stockfish. */}
            {pkg && (() => {
              const { ends, evaluated } = lineEndEvals(pkg);
              if (!ends || evaluated >= ends) return null;
              return (
                <div className="rounded-md bg-warning-container text-on-warning-container p-2.5 text-body-sm space-y-1.5">
                  <div>
                    <b>Not fully analysed yet</b> — Stockfish has evaluated {evaluated} of {ends} line ends. The others show no
                    evaluation at the end of a replay. The server analyses chapters by itself; send it again once it is done.
                  </div>
                  {analysing === "no" ? (
                    <button onClick={() => { void analyseChapters([chapterId]).then(() => setAnalysing("asked"), () => setAnalysing("failed")); }}
                      className="h-7 px-3 rounded-full bg-on-warning-container/10 text-label-md hover:bg-on-warning-container/15">Analyse now</button>
                  ) : (
                    <div className="text-label-md">{analysing === "asked" ? "Analysis started — see the activity panel (⟳)." : "Could not start the analysis."}</div>
                  )}
                </div>
              );
            })()}
            {frames && (
              <div className="text-label-md text-on-surface-variant">
                {(frames.bytes / 1024).toFixed(1)} KB in {frames.fragments} parts · about {Math.ceil(frames.fragments * PARTS_NEEDED / qr.fps)} s to read, held steady
              </div>
            )}
            <div className="mt-auto flex items-end gap-3">
              <canvas ref={link} className="rounded-sm bg-white shrink-0" />
              <div className="text-label-md text-on-surface-variant">
                No trainer on the phone yet? Scan this with its camera, then <b>Share → Add to Home Screen</b>.
                <div className="font-mono text-label-sm mt-1 break-all">{TRAINER_URL}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onSaveFile} className="h-8 px-3 rounded-full text-label-md text-primary hover:bg-primary/8">Save as a file instead…</button>
          <button onClick={onClose} className="ml-auto h-8 px-4 rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110">Close</button>
        </div>
      </div>
    </div>
  );
}
