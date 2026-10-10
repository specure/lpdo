// A test of sending to the phone (Maintenance → Sending to the phone): a
// chapter's worth of random data played as QR codes at the computer's
// settings. The trainer knows it for a test, keeps nothing, and shows how
// the reading went — to choose the settings by.

import { useEffect, useState } from "react";
import { encodeTest, PARTS_NEEDED, type Frames } from "../../trainer/qrTransfer";
import type { QrSettings } from "../../lib/qrSettings";
import QrLoop from "./QrLoop";

const SIZES = [5, 10, 20];

export default function PhoneTestDialog({ settings, onClose }: { settings: QrSettings; onClose: () => void }) {
  // A chapter is 3–18 KB compressed; 10 a middling one.
  const [kb, setKb] = useState(10);
  const [frames, setFrames] = useState<Frames | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    setFrames(null);
    encodeTest(kb, settings).then((f) => { if (!gone) setFrames(f); }, (e) => { if (!gone) setError(String(e instanceof Error ? e.message : e)); });
    return () => { gone = true; };
  }, [kb, settings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40" onClick={onClose}>
      <div className="bg-surface-container-high rounded-xl shadow-2xl max-w-[94vw] max-h-[94vh] overflow-y-auto p-5 flex flex-col gap-4"
        style={{ width: `calc(${settings.size}px + 20rem)` }} onClick={(e) => e.stopPropagation()}>
        <div>
          <div className="text-title-md text-on-surface">Test with the phone</div>
          <div className="text-body-sm text-on-surface-variant">
            {settings.bytes} bytes a frame · {settings.fps} frames a second · {settings.size} px
          </div>
        </div>
        <div className="flex gap-5 flex-wrap">
          <QrLoop frames={frames} fps={settings.fps} size={settings.size} error={error} />
          <div className="flex-1 min-w-[14rem] flex flex-col gap-3 text-body-sm text-on-surface">
            <ol className="list-decimal pl-5 space-y-1.5">
              <li>In the <b>LPDO Trainer</b> on the phone, tap <b>Scan</b>.</li>
              <li>Hold the camera on the code as you would for a chapter, until the bar is full.</li>
              <li>The trainer shows how long it took and how many frames it caught — and keeps nothing.</li>
            </ol>
            <label className="flex items-center gap-2">
              <span>Data</span>
              <select value={kb} onChange={(e) => setKb(Number(e.target.value))}
                className="h-8 px-1 rounded-sm bg-surface-container border border-outline/40 text-on-surface text-body-sm">
                {SIZES.map((k) => <option key={k} value={k}>{k} KB</option>)}
              </select>
              <span className="text-on-surface-variant">— a chapter is 3–18 KB</span>
            </label>
            {frames && (
              <div className="text-label-md text-on-surface-variant">
                {frames.fragments} parts · about {Math.ceil(frames.fragments * PARTS_NEEDED / settings.fps)} s to read, held steady
              </div>
            )}
            <p className="text-label-md text-on-surface-variant mt-auto">
              Change the settings in Maintenance and test again: the one the phone reads fastest, reliably, is the one to keep.
            </p>
          </div>
        </div>
        <div className="flex">
          <button onClick={onClose} className="ml-auto h-8 px-4 rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110">Close</button>
        </div>
      </div>
    </div>
  );
}
