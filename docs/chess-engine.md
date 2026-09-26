# Installing a chess engine

The Engine panel's **Local** analysis uses a chess engine installed on the
machine the LPDO server runs on. LPDO does not ship one: the strongest free
engine, [Stockfish](https://stockfishchess.org), is GPL-licensed, so you install
it yourself — the way ChessBase lets you add Stockfish beside Fritz. Any engine
that speaks the UCI protocol works; Stockfish is the one described here.

**Which machine?** The one running the LPDO server.

- **Everything on one computer** (the usual desktop install, with the database
  server ticked in the installer): install the engine on that computer.
- **Server on another machine** (see [remote-server.md](remote-server.md)):
  install it on the server. The client computers need nothing.

Maintenance → *Others* → **Chess engine** shows which engine the server uses.
When there is none, the Engine panel's **Local** tab lists where the server
looked.

## Linux

The simplest route is the distribution's package:

```
sudo apt install stockfish        # Debian, Ubuntu, Mint
sudo dnf install stockfish        # Fedora
sudo pacman -S stockfish          # Arch
```

Distribution packages can be several releases behind. Ubuntu 24.04, for
example, ships Stockfish 16 (2023), while the current release is 19. LPDO
checks for the newest Stockfish once a day and shows a notice when the server
runs an older one.

**For the newest release**, install the official build next to the package:

1. Download **Linux x86-64** (or **ARM64**) from
   [stockfishchess.org/download](https://stockfishchess.org/download/), or
   `stockfish-linux-x86-64-universal.tar.gz` from the
   [GitHub releases](https://github.com/official-stockfish/Stockfish/releases).
   The *universal* build picks the fastest instruction set the processor has.
2. Unpack it and install the program as `/usr/local/bin/stockfish`:

   ```
   cd /tmp && tar xzf ~/Downloads/stockfish-linux-x86-64-universal.tar.gz
   sudo install -m 755 /tmp/stockfish/stockfish-linux-x86-64-universal /usr/local/bin/stockfish
   ```

3. Check it runs: `/usr/local/bin/stockfish bench` ends with a
   `Nodes/second` line.

The server looks in `/usr/local/bin` before the package locations, so the new
build is used from then on. If no engine was running, nothing else is needed.
If an older one was, choose the new one under Maintenance → Chess engine, or
restart the server: `sudo systemctl restart lpdo-server`.

## macOS

With [Homebrew](https://brew.sh):

```
brew install stockfish
```

Homebrew keeps it current (`brew upgrade stockfish`). It installs to
`/opt/homebrew/bin` on Apple silicon and `/usr/local/bin` on Intel Macs; the
server looks in both.

## Windows

1. Download **Windows x86-64** from
   [stockfishchess.org/download](https://stockfishchess.org/download/). The
   *AVX2* build runs on most processors made since about 2013; if it will not
   start, take the plain x86-64 build.
2. Unpack the zip. It contains a program named like
   `stockfish-windows-x86-64-avx2.exe`.
3. Create the folder `C:\Program Files\Stockfish` and copy the program there,
   **renamed to `stockfish.exe`**. This takes an administrator account.

The server finds `C:\Program Files\Stockfish\stockfish.exe` by itself.

## Checking

Open the Engine panel on the Analysis page and choose **Local**. It shows the
engine's name, the depth and the speed, and lines that deepen as you watch; if
it still says *No chess engine on the server*, press **Check again**.
Maintenance → Chess engine shows the same, and lets you choose between several
installed engines and set their threads and hash.

## An engine somewhere else

The server finds engines in `$PATH` and in the standard locations above. For an
engine elsewhere, name it in `engine.json` in the server's data directory:

| Platform | File |
|---|---|
| Linux | `/var/lib/lpdo/.chess-db/engine.json` |
| macOS | `/Library/Application Support/LPDO/engine.json` |
| Windows | `C:\ProgramData\LPDO\engine.json` |

```json
{ "path": "/opt/engines/stockfish" }
```

On Windows, double the backslashes: `{ "path": "D:\\Engines\\stockfish.exe" }`.
Then restart the server.

This file on the server is the only way to name an arbitrary program. The
client can choose only among the engines found in the standard locations:
anyone who can reach the server could otherwise make it run any program.

On Linux the server runs as a system service that cannot see home directories,
so keep the engine outside `/home` — `/usr/local/bin` or `/opt` work.

## Settings

| Setting | Default | |
|---|---|---|
| Threads | half the server's logical cores | About one per physical core; the server also answers everyone's queries while it analyses. |
| Hash | a sixteenth of the memory, 256 MB – 4 GB | More keeps more of an analysis when you move on and come back; the database needs memory too. |

Maintenance → Chess engine → **Benchmark** runs Stockfish's own benchmark
with the threads and hash set there, and keeps the results in a table: change
a setting and run again to compare.

A search stops when you move to another position or close the panel, and after
five minutes at the latest.

## Measuring speed

`stockfish bench` searches a fixed set of positions and prints the nodes
searched and the speed. With the server's settings:

```
stockfish bench 256 8 20     # hash MB, threads, depth
```

With the defaults (`stockfish bench`: one thread) the node count identifies the
Stockfish build — the same build gives the same number on every machine — and
only the speed depends on the hardware. With several threads the count varies
from run to run. Compare speeds between machines for the same version only: a
newer Stockfish that searches fewer nodes is not a weaker engine.

## Leela Chess Zero

[Lc0](https://lczero.org) also speaks UCI and is found as `lc0` in the same
places, but it needs a neural-network file as well, and a graphics card to be
fast. Setting it up is not covered yet.
