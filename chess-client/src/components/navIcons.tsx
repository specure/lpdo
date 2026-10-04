// Move-navigation icons for every board: first / previous / next / last move
// and flip. SVG in the text colour — emoji (⏮ ⏭) render in their own colours.

export const IconFirst = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="3" width="2" height="10" rx="1" />
    <path d="M13 3L6 8l7 5V3z" />
  </svg>
);
export const IconPrev = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M11 3L4 8l7 5V3z" />
  </svg>
);
export const IconNext = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M5 3l7 5-7 5V3z" />
  </svg>
);
export const IconLast = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="12" y="3" width="2" height="10" rx="1" />
    <path d="M3 3l7 5-7 5V3z" />
  </svg>
);
export const IconFlip = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: "rotate(90deg)" }}>
    <path d="M17 1l4 4-4 4" />
    <path d="M3 11V9a4 4 0 014-4h14" />
    <path d="M7 23l-4-4 4-4" />
    <path d="M21 13v2a4 4 0 01-4 4H3" />
  </svg>
);
