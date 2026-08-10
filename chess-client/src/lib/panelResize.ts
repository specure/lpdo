import { useRef, useState } from "react";

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
// panel that is not one of its two neighbours is pinned to its current size, so
// the drag simply stops when the neighbour reaches its minimum.
//
//   const rz = useNeighbourResize();
//   <PanelGroup onLayout={rz.onLayout}>
//     <Panel minSize={rz.pin(0) ?? 5} maxSize={rz.pin(0) ?? 16} />
//     <PanelResizeHandle {...rz.handle(0)} />
//     …
//
// Only needed for groups of three or more; a two-panel group has nowhere to
// spill, so its divider already obeys the rule.
export function useNeighbourResize() {
  // Live sizes, in a ref: they change on every frame of a drag and no render
  // depends on them until a pin is taken. Taken from the group's onLayout rather
  // than per-panel onResize, which only fires once a panel has actually changed —
  // a panel still at its default had no size to pin to, so the pin silently did
  // nothing and the spill went through.
  const sizes = useRef<number[]>([]);
  // Index of the divider being dragged or keyboard-focused, if any.
  const [active, setActive] = useState<number | null>(null);

  return {
    /** Index of the divider currently in use, or null. Exposed for debugging. */
    active,
    /** Feed the group's layout back: `<PanelGroup onLayout={rz.onLayout}>`. */
    onLayout: (layout: number[]) => { sizes.current = layout; },
    /** Wire a divider: `<PanelResizeHandle {...rz.handle(i)} />`. Keyboard resize
     *  cascades exactly like dragging, so focus counts as "in use" too. */
    handle: (i: number) => ({
      onDragging: (dragging: boolean) => setActive(dragging ? i : null),
      onFocus: () => setActive(i),
      onBlur: () => setActive(null),
    }),
    /** The size panel `i` is pinned to, or null when it is free to resize —
     *  which is when no divider is in use, this panel neighbours it, or we have
     *  no size for it yet (nothing to pin it to). */
    pin: (i: number): number | null => {
      if (active === null || i === active || i === active + 1) return null;
      const size = sizes.current[i];
      return typeof size === "number" ? size : null;
    },
  };
}
