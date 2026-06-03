import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DirectoryListing } from "../../types";

interface RecentFile {
  path: string;
  gameCount: number;
}

interface Props {
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  /** Persistent "Recent" shortcut list rendered above the directory listing.
   *  Lets users jump back to a previously-opened PGN regardless of where the
   *  file tree is currently navigated. */
  recentFiles?: RecentFile[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export default function DirectoryBrowser({ selectedFile, onSelectFile, recentFiles }: Props) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function navigate(path: string) {
    setLoading(true);
    setError(null);
    invoke<DirectoryListing>("list_directory", { path })
      .then(setListing)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    navigate("");
  }, []);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header — editable path */}
      <div className="p-3 shrink-0">
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            defaultValue={listing?.path ? `${listing.path}${listing.path.endsWith("/") ? "" : "/"}` : ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                let val = (e.target as HTMLInputElement).value.trim();
                if (val === "~" || val === "~/") {
                  navigate("");
                } else if (val.startsWith("~/")) {
                  navigate("~" + val.slice(1).replace(/\/+$/, ""));
                } else if (val === "/") {
                  navigate("/");
                } else if (val) {
                  navigate(val.replace(/\/+$/, ""));
                }
                setEditing(false);
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
            onBlur={() => setEditing(false)}
            className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-md font-mono border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
          />
        ) : (
          <div
            className="text-title-sm text-on-surface truncate cursor-text px-1"
            title={listing?.path}
            style={{ direction: "rtl", textAlign: "left" }}
            onClick={() => setEditing(true)}
          >
            {listing?.path ? `${listing.path}${listing.path.endsWith("/") ? "" : "/"}` : "Loading..."}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Recent files — persistent shortcut list at the top, independent of
            the current directory. Always visible (when any recents exist) so
            users can jump back to previously-opened PGNs at any time. */}
        {recentFiles && recentFiles.length > 0 && (
          <>
            <div className="px-4 pt-3 pb-1.5 text-label-sm text-on-surface-variant uppercase tracking-wider">
              Recent
            </div>
            {recentFiles.map((f) => {
              const selected = selectedFile === f.path;
              return (
                <button
                  key={`r-${f.path}`}
                  onClick={() => onSelectFile(f.path)}
                  title={f.path}
                  className={`w-full text-left px-4 py-2.5 transition-colors duration-short3 ease-standard ${
                    selected
                      ? "bg-secondary-container text-on-secondary-container"
                      : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
                  }`}
                >
                  <div className="text-body-md truncate">{basename(f.path)}</div>
                  <div className={`text-body-sm mt-0.5 ${selected ? "text-on-secondary-container/80" : "text-on-surface-variant"}`}>
                    {f.gameCount.toLocaleString()} {f.gameCount === 1 ? "game" : "games"}
                  </div>
                </button>
              );
            })}
            <div className="mx-4 my-2 border-t border-outline-variant" />
          </>
        )}

        {loading && (
          <div className="p-4 text-center text-on-surface-variant text-body-md">Loading...</div>
        )}
        {error && (
          <div className="p-4 text-center text-error text-body-md">{error}</div>
        )}
        {!loading && listing && (
          <>
            {/* Parent directory */}
            {listing.parent && (
              <button
                onClick={() => navigate(listing.parent!)}
                className="w-full text-left px-4 py-2 text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
              >
                <span className="text-body-md">..</span>
              </button>
            )}

            {listing.entries.length === 0 && (
              <div className="p-4 text-center text-on-surface-variant text-body-md">
                No folders or PGN files
              </div>
            )}

            {listing.entries.map((entry) => {
              const fullPath = `${listing.path}/${entry.name}`;
              if (entry.is_dir) {
                return (
                  <button
                    key={`d-${entry.name}`}
                    onClick={() => navigate(fullPath)}
                    className="w-full text-left px-4 py-2 hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
                  >
                    <div className="text-body-md text-primary truncate">
                      {entry.name}/
                    </div>
                  </button>
                );
              }
              const selected = selectedFile === fullPath;
              return (
                <button
                  key={`f-${entry.name}`}
                  onClick={() => onSelectFile(fullPath)}
                  className={`w-full text-left px-4 py-3 transition-colors duration-short3 ease-standard ${
                    selected
                      ? "bg-secondary-container text-on-secondary-container"
                      : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
                  }`}
                >
                  <div className="text-body-md truncate">{entry.name}</div>
                  <div className={`text-body-sm mt-0.5 ${selected ? "text-on-secondary-container/80" : "text-on-surface-variant"}`}>{formatSize(entry.size)}</div>
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
