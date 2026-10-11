import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useDefaultLayout, type Layout } from "react-resizable-panels";

// Where a divider can be grabbed: the line itself, every `<Group>` gets this.
// The library's default widens the target to 10px around a thinner divider —
// and the cursor with it — while the pin above is taken from the divider
// element: a drag begun in those outer pixels showed the resize cursor and
// moved nothing. The 6px line is the whole target, so the cursor says where a
// drag will work. (Coarse pointers keep the library's 20px: no hover there.)
export const hitTarget = { coarse: 20, fine: 6 };

// One rule for every divider in the app: it resizes the two panels it separates,
// their total stays the same, and nothing else moves.
//
// react-resizable-panels does not do the last part on its own. When the panel a
// drag is shrinking reaches its minimum, the library carries on into the panel
// beyond it — so in a group of three or more, dragging one divider can move a
// panel that divider does not touch (measured: 347px taken from the Analysis
// rail by a divider two panels away).
//
// The fix is to leave it nothing to spill into: while a divider is in use, every
// panel that is not one of its two neighbours gets a floor at its current size,
// so the drag simply stops when the neighbour reaches its minimum.
//
// Two things this got wrong before, both of which only a real mouse in the real
// webview revealed — a divider would highlight but not drag, or need a click
// first and a drag second:
//   · the floor must be in place *before* the pointer goes down. Changing a
//     panel's constraints mid-drag aborts that drag, so it is set on hover.
//   · it must be a floor, not a lock. min == max over-constrains the group, and
//     doing that to the last panel makes v4 refuse to resize at all.
//
//   const rz = useNeighbourResize(["rail", "board", "side"]);
//   <Group onLayoutChange={rz.onLayout}>
//     <Panel id="rail" minSize={rz.floor("rail") ?? "5"} maxSize="16" />
//     <Separator {...rz.separator(0)} />
//     …
//
// Only needed for groups of three or more; a two-panel group has nowhere to
// spill, so its divider already obeys the rule.
//
// One exception, wanted: a panel folded to a strip (fixed width, min == max)
// is transparent. Either divider beside it trades between the nearest open
// panels on each side — the books against the board when the chapters are a
// strip — and the strip itself keeps its width. The library does this on its
// own, since a fixed panel has nothing to give and the drag carries on past
// it; the rule only has to leave those two panels free instead of flooring
// them. `strips` names the panels folded right now.
export function useNeighbourResize(panelIds: string[], strips: string[] = []) {
  // Live sizes, in a ref: they change on every frame of a drag and no render
  // depends on them until a pin is taken. Fed from the group's onLayoutChange,
  // which reports every panel — a panel still at its default has no onResize of
  // its own to report from, and a pin with nothing to pin to silently does
  // nothing, which is how the spill got through the first version of this.
  const sizes = useRef<Layout>({});
  // A separator counts as "in use" while the pointer is within its hit
  // target — judged here with the library's own rule (the element's box,
  // widened to `hitTarget` if thinner, edges included) from the document's
  // pointer moves — and while it holds keyboard focus.
  //
  // Hover, not pointer-down, because the pin works by changing panel min/max —
  // and changing a constraint *during* a drag aborts that drag: the two dividers
  // that pin a third panel highlighted but would not move, while every divider
  // in a two-panel group (nothing to pin) dragged normally. Pinning on hover
  // settles the constraints before the drag begins, so nothing changes under it.
  //
  // Not from the library's own hover state (`data-separator="hover"`): the
  // pin's constraint change makes the group take its panels anew, which
  // resets that state to inactive — and a pin that follows it undoes itself.
  // Not from the element's pointer-enter either: at the line's exact edge the
  // library counts the pointer in while the browser's hit test counts it out,
  // so a drag begun there showed the resize cursor and moved nothing. (And
  // never `onPointerEnterCapture`: React DOM does not dispatch it.)
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const active = hovered ?? focused;
  const elements = useRef(new Map<number, HTMLElement>());
  const dragging = useRef(false);
  useEffect(() => {
    let last: number | null = null;
    const within = (r: DOMRect, x: number, y: number) => {
      if (r.width === 0 || r.height === 0) return false;
      const dx = Math.max(0, hitTarget.fine - r.width) / 2, dy = Math.max(0, hitTarget.fine - r.height) / 2;
      return x >= r.left - dx && x <= r.right + dx && y >= r.top - dy && y <= r.bottom + dy;
    };
    const move = (e: PointerEvent) => {
      // The pointer is captured and routinely leaves the separator mid-drag.
      if (dragging.current) return;
      let over: number | null = null;
      for (const [i, el] of elements.current) {
        if (within(el.getBoundingClientRect(), e.clientX, e.clientY)) { over = i; break; }
      }
      if (over === last) return;
      last = over;
      // Flushed synchronously: a render for a hover is otherwise deferred, and
      // a quick press after entering could land before the floors are in place.
      if (over !== null) flushSync(() => setHovered(over)); else setHovered(null);
    };
    const down = () => { if (last !== null) dragging.current = true; };
    const up = () => { dragging.current = false; };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    return () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
    };
  }, []);
  // One ref callback per divider, kept: a new one each render is called with
  // null and then the element again, for nothing.
  const refs = useRef(new Map<number, (el: HTMLDivElement | null) => void>());

  return {
    /** Feed the group's live layout back: `<Group onLayoutChange={rz.onLayout}>`. */
    onLayout: (layout: Layout) => { sizes.current = layout; },

    /** Wire a divider: `<Separator {...rz.separator(i)} />`, `i` counting from 0,
     *  sitting between panelIds[i] and panelIds[i + 1].
     *
     *  Capture-phase focus handlers on purpose: Separator spreads the props it
     *  is given and *then* sets its own `onFocus`/`onBlur`, so the bubble-phase
     *  versions are silently overwritten — the pin looked wired up and never
     *  fired. */
    separator: (i: number) => {
      let ref = refs.current.get(i);
      if (!ref) { ref = (el) => { if (el) elements.current.set(i, el); else elements.current.delete(i); }; refs.current.set(i, ref); }
      return {
        elementRef: ref,
        onFocusCapture: () => setFocused(i),
        onBlurCapture: () => setFocused((f) => (f === i ? null : f)),
      };
    },

    /** A floor for panel `id` — its current size, as a percentage string — or
     *  null when it is free to shrink.
     *
     *  A floor, not a lock: a spill can only ever *shrink* a panel the divider
     *  does not touch, because the panel being grown is always the divider's own
     *  neighbour. Pinning min *and* max over-constrains the group, and pinning
     *  the last panel that way made v4 refuse the drag entirely — the divider
     *  highlighted and would not move. */
    floor: (id: string): string | null => {
      if (active === null) return null;
      // The two panels the divider trades between: the nearest on each side
      // that is not a strip.
      let left = active;
      while (left > 0 && strips.includes(panelIds[left])) left--;
      let right = active + 1;
      while (right < panelIds.length - 1 && strips.includes(panelIds[right])) right++;
      if (id === panelIds[left] || id === panelIds[right]) return null;
      const size = sizes.current[id];
      return typeof size === "number" ? String(size) : null;
    },
  };
}

// A group whose panels come and go (a list hidden, a column only in one state)
// keeps a saved layout for each set of them. Saved as one, the sizes for one
// set failed to match the other's panels and every column fell back to its
// default the first time the set changed. A layout saved the old way, under
// the group's id alone, is still used for the set it was saved with.
export function usePanelLayout(id: string, panelIds: string[]) {
  const saved = useDefaultLayout({ id, panelIds, storage: localStorage });
  const key = panelIds.join(",");
  const before = useMemo(() => {
    if (saved.defaultLayout) return undefined;
    try {
      const v = JSON.parse(localStorage.getItem(`react-resizable-panels:${id}`) ?? "null") as Layout | null;
      if (v && Object.keys(v).sort().join(",") === [...panelIds].sort().join(",")) return v;
    } catch { /* none */ }
    return undefined;
  }, [saved.defaultLayout, id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...saved, defaultLayout: saved.defaultLayout ?? before };
}
