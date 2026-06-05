## What's new in LPDO 0.2.0

This release is a major upgrade to the **move editor**.

### Variations, comments & annotations
- **Lossless editing with variations** — play an alternative move mid-game and choose **New variation**, **New main line**, or **Overwrite** (ChessBase/Lichess-style). The full move tree is preserved when you save.
- **Promote / demote variations** and **delete-from-here**.
- **Comments** on moves and positions.
- **NAGs** — annotate moves (`!`, `?`, `!!`, `?!`, …) and positions (`±`, `=`, `∞`, …); they show in the move list and round-trip through PGN.
- **On-board NAG badge** — the move's glyph is shown directly on the destination square, chess.com-style.
- **Graphical annotations** — draw on the board: **Ctrl+click** for a circle, **Ctrl+drag** for an arrow. Colours: Green, Red, Yellow, Blue, plus Magenta, Cyan and Orange. Stored as standard PGN `[%cal]` / `[%csl]` tags, so they survive export.
- **Game-end / final-position analysis** and an aligned view/edit move readout with last-move highlight.

### Updates
- **In-app update notifier** — LPDO now checks GitHub on launch and shows a dismissible banner when a newer version is published, with **What's new** and **Download** links. (Updating stays a manual reinstall — see below.)

### Downloads
- **Linux** — `.deb` (Debian/Ubuntu) or `.AppImage`
- **Windows** — `.exe` installer

### Updating on Linux
Install the new package over the old one — it replaces the previous version in place, and your database is preserved:

```bash
sudo apt install ./lpdo_0.2.0_amd64.deb
```
