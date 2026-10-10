// Scanning a chapter sent from the desktop (#327): the rear camera, each
// picture's centre searched for a QR code (the browser's own detector where
// there is one, jsQR on the iPhone), the codes fed to the fountain decoder
// until the chapter is whole.

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { receiver, type QrTest, type Receiver } from "../trainer/qrTransfer";
import type { LpdoChapter } from "../trainer/format";

interface Props {
  onDone: (chapter: LpdoChapter) => void;
  onCancel: () => void;
}

type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };

export default function ScanView({ onDone, onCancel }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Starting the camera…");
  const [error, setError] = useState<string | null>(null);
  // How the reading goes, to tell what slows it: the camera's picture, how
  // long a search takes, how many find a code.
  const [detail, setDetail] = useState("");
  // A test of the transfer read (sent from Maintenance): how it went.
  const [test, setTest] = useState<TestResult | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let running = true;
    let rx: Receiver | null = null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const native: Detector | null = "BarcodeDetector" in window
      ? new (window as unknown as { BarcodeDetector: new (o: object) => Detector }).BarcodeDetector({ formats: ["qr_code"] })
      : null;

    /** The centre square of the picture, at most 720 px: where the code is,
     *  and less to search. */
    const read = async (v: HTMLVideoElement): Promise<string | null> => {
      if (native) return (await native.detect(v))[0]?.rawValue ?? null;
      const side = Math.min(v.videoWidth, v.videoHeight);
      const out = Math.min(side, 720);
      canvas.width = canvas.height = out;
      ctx!.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, out, out);
      const img = ctx!.getImageData(0, 0, out, out);
      return jsQR(img.data, out, out, { inversionAttempts: "dontInvert" })?.data ?? null;
    };

    let scans = 0, found = 0, spent = 0, first = 0;
    const loop = async () => {
      const v = video.current;
      if (!running || !v || !rx) return;
      if (v.readyState >= 2) {
        const t = performance.now();
        const text = await read(v).catch(() => null);
        spent += performance.now() - t;
        scans++;
        if (text) {
          found++;
          first ||= performance.now();
          rx.receive(text);
          setProgress(rx.progress());
          setStatus("Reading — hold steady");
          if (rx.done()) {
            running = false;
            setStatus("Received");
            // The full bar a moment, before the chapter opens.
            await new Promise((r) => setTimeout(r, 300));
            const secs = (performance.now() - first) / 1000;
            try {
              const got = await rx.payload();
              if (got.kind === "chapter") onDone(got.chapter);
              else {
                const { read: parts, of } = rx.parts();
                setTest({ test: got.test, secs, parts, of, searchMs: spent / scans, found: found / scans, camera: `${v.videoWidth}×${v.videoHeight}` });
                stream?.getTracks().forEach((t) => t.stop());
              }
            } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
            return;
          }
        }
        if (scans % 10 === 0) {
          const { read: got, of } = rx.parts();
          setDetail(`Camera ${v.videoWidth}×${v.videoHeight} · ${Math.round(spent / scans)} ms a search · ${Math.round((found / scans) * 100)}% find a code`
            + (of ? ` · ${got} parts read, the chapter is ${of}` : ""));
        }
      }
      if ("requestVideoFrameCallback" in v) v.requestVideoFrameCallback(() => void loop());
      else requestAnimationFrame(() => void loop());
    };

    void (async () => {
      try {
        rx = await receiver();
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (!running || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        setStatus("Point the camera at the code on the computer");
        void loop();
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        setError(name === "NotAllowedError"
          ? "The camera is not allowed. Allow it for this app (Settings → Safari → Camera, or when asked) and try again."
          : `No camera: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    return () => {
      running = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onDone, round]);

  if (test) return <TestResultView r={test} onAgain={() => { setTest(null); setProgress(0); setDetail(""); setRound((n) => n + 1); }} onClose={onCancel} />;

  return (
    <div className="h-[100dvh] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] bg-black text-white flex flex-col">
      <div className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden">
        <video ref={video} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
        {/* Where to hold the code: the centre square the reading searches. */}
        <div className="relative w-[72vmin] h-[72vmin] rounded-xl border-4 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.35)]" />
      </div>
      <div className="shrink-0 p-4 space-y-3 bg-black">
        <div className="h-2 rounded-full bg-white/20 overflow-hidden">
          <div className="h-full bg-white transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className={`text-body-md ${error ? "text-red-300" : ""}`}>{error ?? `${status}${progress > 0 ? ` · ${Math.round(progress * 100)}%` : ""}`}</div>
        {detail && !error && <div className="text-label-sm text-white/50">{detail}</div>}
        <button onClick={onCancel} className="h-10 px-5 rounded-full bg-white/15 text-label-lg">Cancel</button>
      </div>
    </div>
  );
}

interface TestResult {
  test: QrTest;
  /** From the first code read to the last part. */
  secs: number;
  /** Distinct parts read, and the parts it is cut in. */
  parts: number;
  of: number;
  searchMs: number;
  /** The share of searches that found a code. */
  found: number;
  camera: string;
}

/** A test of the transfer, read: nothing kept — how it went, and what to
 *  change if it was slow. */
function TestResultView({ r, onAgain, onClose }: { r: TestResult; onAgain: () => void; onClose: () => void }) {
  const t = r.test;
  const shown = Math.max(1, Math.round(r.secs * t.fps));
  // Of the frames shown while reading, how many came through.
  const caught = Math.min(1, r.parts / shown);
  const kb = (t.filler.length * 0.75 / 1024).toFixed(1);
  const advice = r.searchMs > 1000 / t.fps
    ? `A search takes ${Math.round(r.searchMs)} ms, longer than a frame is shown (${Math.round(1000 / t.fps)} ms): fewer frames a second would miss fewer.`
    : caught >= 0.7 ? "The phone reads nearly every frame: more bytes a frame or more frames a second may be faster still."
    : caught >= 0.4 ? "A good reading."
    : "Many frames missed: hold the phone closer and steadier, without glare on the screen — or try a larger code, fewer bytes a frame, or fewer frames a second.";
  const row = (k: string, v: string) => (
    <div className="flex justify-between gap-4 py-1 border-b border-outline/30"><span className="text-on-surface-variant">{k}</span><span className="tabular-nums text-right">{v}</span></div>
  );
  return (
    <div className="h-[100dvh] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] bg-surface text-on-surface flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <div>
          <div className="text-title-md">Test received</div>
          <div className="text-body-sm text-on-surface-variant">A test of the transfer — nothing is kept on the phone.</div>
        </div>
        <div className="text-display-sm tabular-nums">{r.secs.toFixed(1)} s</div>
        <div className="text-body-sm">
          {row("Size", `${kb} KB, in ${r.of} parts`)}
          {row("Sent with", `${t.bytes} bytes a frame · ${t.fps} a second · ${t.size} px`)}
          {row("Frames shown meanwhile", `about ${shown}`)}
          {row("Parts read", `${r.parts} — ${Math.round(caught * 100)}% of the frames shown`)}
          {row("Searches finding a code", `${Math.round(r.found * 100)}%`)}
          {row("A search takes", `${Math.round(r.searchMs)} ms`)}
          {row("Camera", r.camera)}
        </div>
        <p className="text-body-sm">{advice}</p>
        <p className="text-label-sm text-on-surface-variant">The settings are on the computer: Maintenance → Sending to the phone.</p>
      </div>
      <div className="shrink-0 p-4 flex gap-2">
        <button onClick={onAgain} className="h-10 px-5 rounded-full bg-primary text-on-primary text-label-lg">Test again</button>
        <button onClick={onClose} className="h-10 px-5 rounded-full bg-secondary-container text-on-secondary-container text-label-lg">Close</button>
      </div>
    </div>
  );
}
