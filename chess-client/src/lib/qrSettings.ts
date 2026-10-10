// How the desktop plays a chapter to the phone as QR codes (#327): bytes a
// frame, frames a second, the code's size — per computer, as they depend on
// its screen. The defaults are what was measured with an iPhone reading a
// monitor (docs/design/opening-repertoire.md); Maintenance → Sending to the
// phone sets them, and tests them with the phone.

export interface QrSettings {
  /** Bytes of the chapter a frame carries. */
  bytes: number;
  /** Frames a second. */
  fps: number;
  /** The code's side, in CSS pixels. */
  size: number;
}

export const QR_DEFAULTS: QrSettings = { bytes: 400, fps: 10, size: 560 };

export const QR_LIMITS: Record<keyof QrSettings, [number, number]> = {
  bytes: [100, 1000],
  fps: [1, 20],
  size: [240, 1000],
};

const KEY = "lpdoQrSettings";

const clamp = (k: keyof QrSettings, v: unknown): number => {
  const n = Math.round(Number(v));
  const [lo, hi] = QR_LIMITS[k];
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : QR_DEFAULTS[k];
};

export function qrSettings(): QrSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<QrSettings>;
    return { bytes: clamp("bytes", s.bytes ?? QR_DEFAULTS.bytes), fps: clamp("fps", s.fps ?? QR_DEFAULTS.fps), size: clamp("size", s.size ?? QR_DEFAULTS.size) };
  } catch {
    return { ...QR_DEFAULTS };
  }
}

export function saveQrSettings(s: QrSettings): QrSettings {
  const out = { bytes: clamp("bytes", s.bytes), fps: clamp("fps", s.fps), size: clamp("size", s.size) };
  try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* per-computer convenience only */ }
  return out;
}
