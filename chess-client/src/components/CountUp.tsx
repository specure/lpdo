// Animated number reveal for the Home page.
//
// Two modes:
//   - "count" (default): tweens from the previous value to the new one with
//     ease-out-quart over ~800ms. Use for tallies (game counts, activity).
//   - "fade":            value appears immediately and fades in over ~400ms.
//                        Use for scores like FIDE ratings, where counting up
//                        from 0 implies an accumulation that didn't happen.
//
// Both modes honour `prefers-reduced-motion`: count jumps to target, fade
// becomes a no-op.
//
// Usage:
//   <CountUp value={status.games} />                       // "11,995,717"
//   <CountUp value={fidePlayer.rating} plain mode="fade" /> // "1915"

import { useEffect, useRef, useState } from "react";

function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

export function useCountUp(target: number, duration = 800, startDelayMs = 0): number {
  const [value, setValue] = useState(0);
  const valueRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    valueRef.current = value;
  });

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      setValue(target);
      valueRef.current = target;
      return;
    }

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    function start() {
      const startValue = valueRef.current;
      const startTime = performance.now();

      function tick(now: number) {
        const elapsed = now - startTime;
        const t = Math.min(1, elapsed / duration);
        const eased = easeOutQuart(t);
        const next = startValue + (target - startValue) * eased;
        setValue(t === 1 ? target : next);
        if (t < 1) rafRef.current = requestAnimationFrame(tick);
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    if (startDelayMs > 0) {
      timerRef.current = setTimeout(start, startDelayMs);
    } else {
      start();
    }

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration, startDelayMs]);

  return value;
}

interface CountUpProps {
  value: number;
  /** Animation duration in ms. Defaults: 800 for "count", 400 for "fade". */
  duration?: number;
  /** Skip locale separators ("1,915" → "1915"). */
  plain?: boolean;
  /** Animation style. */
  mode?: "count" | "fade" | "none";
  /** Wait this many ms before starting — use to align the number animation
   *  with the parent section's CSS rise-in delay. */
  startDelayMs?: number;
}

export default function CountUp({
  value, duration, plain = false, mode = "count", startDelayMs = 0,
}: CountUpProps) {
  if (mode !== "count") {
    const text = plain ? String(value) : value.toLocaleString();
    if (mode === "none") return <>{text}</>;
    // Re-mount on value change so the fade animation re-triggers when the
    // user e.g. switches to a different player profile.
    const fadeMs = duration ?? 400;
    return (
      <span
        key={String(value)}
        className="lpdo-fade-in"
        style={{
          animationDuration: `${fadeMs}ms`,
          animationDelay: startDelayMs > 0 ? `${startDelayMs}ms` : undefined,
        }}
      >
        {text}
      </span>
    );
  }

  return (
    <CountUpAnimated
      value={value}
      duration={duration ?? 800}
      plain={plain}
      startDelayMs={startDelayMs}
    />
  );
}

function CountUpAnimated({
  value, duration, plain, startDelayMs,
}: { value: number; duration: number; plain: boolean; startDelayMs: number }) {
  const animated = useCountUp(value, duration, startDelayMs);
  const rounded = Math.round(animated);
  return <>{plain ? String(rounded) : rounded.toLocaleString()}</>;
}
