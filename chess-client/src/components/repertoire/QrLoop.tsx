// The loop of QR codes the phone reads (#327): a chapter, or a test of the
// transfer — at the computer's settings (lib/qrSettings).

import { useEffect, useRef } from "react";
import QRCode from "qrcode";
import type { Frames } from "../../trainer/qrTransfer";

interface Props {
  frames: Frames | null;
  fps: number;
  /** The side, in CSS pixels. */
  size: number;
  /** Shown instead of the code (an error). */
  error?: string | null;
}

export default function QrLoop({ frames, fps, size, error }: Props) {
  const code = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!frames || !code.current) return;
    const canvas = code.current;
    // Drawn in the screen's own pixels: scaled up by the display (125%,
    // 150%…) its modules' edges blur, and the phone misses more frames.
    const width = Math.round(size * (window.devicePixelRatio || 1));
    const tick = () => { void QRCode.toCanvas(canvas, frames.next(), { errorCorrectionLevel: "L", width, margin: 2 }); };
    tick();
    const t = window.setInterval(tick, 1000 / fps);
    return () => window.clearInterval(t);
  }, [frames, fps, size]);

  return (
    <div className="max-w-full aspect-square shrink-0 flex items-center justify-center bg-white rounded-md" style={{ width: size }}>
      {error ? <span className="text-error text-body-sm p-4">{error}</span>
        : <canvas ref={code} className={frames ? "!w-full !h-full" : "hidden"} />}
      {!frames && !error && <span className="text-body-sm text-neutral-500">…</span>}
    </div>
  );
}
