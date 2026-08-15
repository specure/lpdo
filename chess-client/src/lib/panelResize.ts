import { useRef, useState } from "react";
import type { Layout } from "react-resizable-panels";

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
export function useNeighbourResize(panelIds: string[]) {
  // Live sizes, in a ref: they change on every frame of a drag and no render
  // depends on them until a pin is taken. Fed from the group's onLayoutChange,
  // which reports every panel — a panel still at its default has no onResize of
  // its own to report from, and a pin with nothing to pin to silently does
  // nothing, which is how the spill got through the first version of this.
  const sizes = useRef<Layout>({});
  // A separator counts as "in use" from the moment the pointer is over it, and
  // while it holds keyboard focus.
  //
  // Hover, not pointer-down, because the pin works by changing panel min/max —
  // and changing a constraint *during* a drag aborts that drag: the two dividers
  // that pin a third panel highlighted but would not move, while every divider
  // in a two-panel group (nothing to pin) dragged normally. Pinning on hover
  // settles the constraints before the drag begins, so nothing changes under it.
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  // Only to stop hover being dropped mid-drag: the pointer is captured and
  // routinely leaves the separator while dragging.
  const dragging = useRef(false);
  const active = hovered ?? focused;

  return {
    /** Feed the group's live layout back: `<Group onLayoutChange={rz.onLayout}>`. */
    onLayout: (layout: Layout) => { sizes.current = layout; },

    /** Wire a divider: `<Separator {...rz.separator(i)} />`, `i` counting from 0,
     *  sitting between panelIds[i] and panelIds[i + 1].
     *
     *  Capture-phase handlers on purpose: Separator spreads the props it is given
     *  and *then* sets its own `onFocus`/`onBlur`, so the bubble-phase versions
     *  are silently overwritten — the pin looked wired up and never fired. */
    separator: (i: number) => ({
      onPointerEnterCapture: () => setHovered(i),
      onPointerLeaveCapture: () => { if (!dragging.current) setHovered(null); },
      onPointerDownCapture: () => { dragging.current = true; setHovered(i); },
      onPointerUpCapture: () => { dragging.current = false; },
      onLostPointerCaptureCapture: () => { dragging.current = false; setHovered(null); },
      onFocusCapture: () => setFocused(i),
      onBlurCapture: () => setFocused(null),
    }),

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
      if (id === panelIds[active] || id === panelIds[active + 1]) return null;
      const size = sizes.current[id];
      return typeof size === "number" ? String(size) : null;
    },
  };
}
