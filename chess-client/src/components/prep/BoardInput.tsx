import { useState } from "react";

interface Props {
  onSubmit: (board: number) => void;
  loading: boolean;
}

export default function BoardInput({ onSubmit, loading }: Props) {
  const [value, setValue] = useState("");

  function handleSubmit() {
    const board = parseInt(value, 10);
    if (board > 0) onSubmit(board);
  }

  return (
    <div className="flex items-center gap-2">
      <label className="text-label-md text-on-surface-variant shrink-0">Your board</label>
      <input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
        min={1}
        placeholder="e.g. 5"
        className="w-16 h-8 px-2 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
      />
      <button
        onClick={handleSubmit}
        disabled={!value || loading}
        className="h-8 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-md hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 transition-all duration-short3 ease-standard"
      >{loading ? "Loading…" : "Load opponents"}</button>
    </div>
  );
}
