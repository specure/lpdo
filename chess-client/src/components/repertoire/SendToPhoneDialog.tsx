// Send to phone (#327): a chapter's practice package played as a loop of QR
// codes for the LPDO Trainer on the phone to scan — no network between them.
// The trainer's own address beside it, for a phone that does not have it
// yet; and the file, for when scanning is not at hand.

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { chapterPackage } from "../../lib/practicePackage";
import { encodeChapter, FRAMES_PER_SECOND, type Frames } from "../../trainer/qrTransfer";
import type { LpdoChapter } from "../../trainer/format";

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
  const code = useRef<HTMLCanvasElement>(null);
  const link = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        setFrames(null);
        const p = await chapterPackage(chapterId, { noComments: !comments });
        const f = await encodeChapter(p);
        if (!gone) { setPkg(p); setFrames(f); }
      } catch (e) { if (!gone) setError(String(e instanceof Error ? e.message : e)); }
    })();
    return () => { gone = true; };
  }, [chapterId, comments]);

  // The loop of codes.
  useEffect(() => {
    if (!frames || !code.current) return;
    const canvas = code.current;
    const tick = () => { void QRCode.toCanvas(canvas, frames.next(), { errorCorrectionLevel: "L", width: 420, margin: 2 }); };
    tick();
    const t = window.setInterval(tick, 1000 / FRAMES_PER_SECOND);
    return () => window.clearInterval(t);
  }, [frames]);

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
      <div className="bg-surface-container-high rounded-xl shadow-2xl w-[44rem] max-w-[94vw] max-h-[94vh] overflow-y-auto p-5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}>
        <div>
          <div className="text-title-md text-on-surface">Send to phone</div>
          <div className="text-body-sm text-on-surface-variant">
            {pkg ? <>{pkg.book.name} · {pkg.name}</> : "Preparing the chapter — the database's figures for its positions…"}
          </div>
        </div>
        <div className="flex gap-5 flex-wrap">
          <div className="w-[420px] h-[420px] max-w-full flex items-center justify-center bg-white rounded-md">
            {error ? <span className="text-error text-body-sm p-4">{error}</span>
              : <canvas ref={code} className={frames ? "" : "hidden"} />}
            {!frames && !error && <span className="text-body-sm text-neutral-500">…</span>}
          </div>
          <div className="flex-1 min-w-[14rem] flex flex-col gap-3 text-body-sm text-on-surface">
            <ol className="list-decimal pl-5 space-y-1.5">
              <li>On your phone, open the <b>LPDO Trainer</b> and tap <b>Scan</b>.</li>
              <li>Point the camera at the code and hold it steady until the bar is full — a few seconds.</li>
            </ol>
            <label className="flex items-start gap-2 text-body-sm cursor-pointer">
              <input type="checkbox" checked={comments} onChange={(e) => setComments(e.target.checked)} className="accent-primary mt-0.5" />
              <span>Include the chapter's comments <span className="text-on-surface-variant">— shown when you replay a line; about twice as long to scan</span></span>
            </label>
            {frames && (
              <div className="text-label-md text-on-surface-variant">
                {(frames.bytes / 1024).toFixed(1)} KB in {frames.fragments} parts · about {Math.ceil(frames.fragments / FRAMES_PER_SECOND * 1.3)} s to read
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
