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
// panel that is not one of its two neighbours is pinned to its current size, so
// the drag simply stops when the neighbour reaches its minimum.
//
//   const rz = useNeighbourResize(["rail", "board", "side"]);
//   <Group onLayoutChange={rz.onLayout}>
//     <Panel id="rail" minSize={rz.pin("rail") ?? "5"} maxSize={rz.pin("rail") ?? "16"} />
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
  // A separator counts as "in use" while dragged and while focused: keyboard
  // resizing cascades exactly like dragging, and a drag leaves focus behind.
  const [dragging, setDragging] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const active = dragging ?? focused;

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
      onPointerDownCapture: () => setDragging(i),
      onPointerUpCapture: () => setDragging(null),
      onLostPointerCaptureCapture: () => setDragging(null),
      onFocusCapture: () => setFocused(i),
      onBlurCapture: () => setFocused(null),
    }),

    /** The size panel `id` is pinned to, as a percentage string, or null when it
     *  is free to resize — no divider in use, this panel neighbours it, or we
     *  have no size for it yet. */
    pin: (id: string): string | null => {
      if (active === null) return null;
      if (id === panelIds[active] || id === panelIds[active + 1]) return null;
      const size = sizes.current[id];
      return typeof size === "number" ? String(size) : null;
    },
  };
}
