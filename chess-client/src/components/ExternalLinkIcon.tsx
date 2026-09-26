// The mark on anything that leaves the app for a web browser.
//
// It used to be the character "↗", which WebKitGTK draws from an emoji font:
// a blue boxed arrow that ignores the text colour and sits differently in
// every font size. This draws it as text does, in `currentColor`, so every
// external link looks the same wherever it appears.

export default function ExternalLinkIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="inline-block w-[1em] h-[1em] align-[-0.125em] ml-1 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}
