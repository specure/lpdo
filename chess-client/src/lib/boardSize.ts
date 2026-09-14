// Pixel size for a react-chessboard inside a measured box (#283).
//
// The boards take an explicit pixel size — a fluid container makes the move
// animation overshoot — measured from the space available minus a margin. A
// squeezed box (the notes panel dragged up, a very short window) used to yield
// a zero or negative size; react-chessboard then throws "Square width not found"
// on the next animated move. Never hand it less than a board whose squares
// still have a width.
export const MIN_BOARD_PX = 64;

export function fitBoard(rect: DOMRect, margin: number): number {
  return Math.max(MIN_BOARD_PX, Math.floor(Math.min(rect.width, rect.height)) - margin);
}
