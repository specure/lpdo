// A folded panel opened for a moment: the strip stays where it is in the
// layout and the panel floats beside it, over whatever is there, until a
// pick is made, the pointer goes down elsewhere, Escape is pressed or the
// window changes size. Pinning it — the host's button — unfolds it in the
// layout for good instead. Click-opened on purpose, not on hover: a hover
// flyout pops open while reaching for the divider next to it, flickers when
// the pointer grazes the strip, and has no answer for the keyboard.
//
// The strip is the anchor: a pointer-down on it is not "elsewhere", so the
// strip's own click can close the flyout as well as open it.
//
// Rendered in place, not through a portal to the body: the colour scheme is
// a class on the app's root element, and a portal came out dark on a light
// page. Fixed positioning takes it out of the panel's flow and clipping.
import { useEffect, useRef, type ReactNode } from "react";

export default function Flyout({ anchor, label, onClose, children }: {
  anchor: HTMLElement;
  /** What it is, for assistive tech ("Books"). */
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);
  const r = anchor.getBoundingClientRect();
  // Wide enough to read a long book name, never past the window's edge.
  const width = Math.min(Math.max(300, Math.round(window.innerWidth * 0.22)), window.innerWidth - r.right - 12);
  return (
    <div ref={ref} role="dialog" aria-label={label}
         className="fixed z-30 flex flex-col rounded-md shadow-2xl"
         style={{ left: r.right + 6, top: r.top, height: r.height, width }}>
      {children}
    </div>
  );
}
