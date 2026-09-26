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
| Threads | one per physical core | A core's second hardware thread adds little to Stockfish, and the server also answers everyone's queries while it analyses. |
| Hash | an eighth of the memory, 256 MB – 4 GB | More keeps more of an analysis when you move on and come back. |

**Memory is one budget.** The server may use 80% of the machine's memory. The
engine's hash comes out of it and the database gets the rest, keeping at least
2 GB — on a 32 GB machine, 4 GB of hash leaves the database about 21 GB. The
card shows the split as you type; saving applies it to both at once. Less hash
leaves the database more room for large jobs such as removing duplicates,
which slow down (they spill to disk) rather than fail when memory is short.

Maintenance → Chess engine → **Benchmark** runs Stockfish's own benchmark
(depth 16) with the threads and hash set there, and keeps the results in a
table: change a setting and run again to compare. Compare the **speed**: with
several threads the time varies from run to run (8 and 16 seconds for the same
settings on one machine), and hash hardly shows in a benchmark. One run is
marked *recommended*: at most one thread per physical core, and of those the
fewest threads that reach 80% of the fastest; **Use** sets it.

A search stops when you move to another position or close the panel, when it
reaches its threshold, and after five minutes at the latest. The thresholds are
set per engine under Maintenance (0 for none): **depth 40** for Stockfish, and
**10 million nodes** for Lc0 — Lc0's "depth" is only the average length of the
lines it explores, so nodes are its measure (about five minutes on an RTX 4090).

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

[Lc0](https://lczero.org) is the second engine, beside Stockfish, in the Engine
panel's **Lc0** tab. It judges a position with a neural network and gives its
chances as **win · draw · loss** from White's side — "21·63·17" — rather than
centipawns. It is optional, because it needs a graphics card to be fast.

Measured on one machine (the network's raw speed, positions per second, with
`lc0 backendbench`; a real search is somewhat faster, from its cache):

| Hardware | Backend | Network | Positions/s |
|---|---|---|---|
| NVIDIA RTX 4090 (external, Thunderbolt 3) | `cuda-fp16` | t3-512x15x16h | ~20,000 |
| NVIDIA RTX 4090 | `cuda-fp16` | T1-256x10 | ~47,000 |
| AMD Radeon 8060S (integrated) | `opencl` | 42850 (20×256) | ~580 |
| 16-core processor | `eigen` | T1-256x10 | ~130 |

With an NVIDIA card it is a real second opinion; without a graphics card it is
too slow to be useful. Mesa's OpenCL on an AMD graphics chip works but is slow,
and runs only Lc0's older networks.

It needs two things on the server: **the program** and **a network file**.

### The program

- **Windows:** download it from [lczero.org](https://lczero.org/play/download/) —
  the CUDA build for an NVIDIA card, the *onnx-dml* build for any other — and
  put `lc0.exe` in `C:\Program Files\Lc0`.
- **macOS:** `brew install lc0`.
- **Linux:** Lc0 publishes no Linux download; it is built from source. For an
  NVIDIA card:

  1. The driver and CUDA. On Ubuntu the driver's kernel modules come prebuilt
     and signed, so Secure Boot needs no extra step:

     ```
     sudo apt install nvidia-driver-595-open linux-modules-nvidia-595-open-generic-hwe-24.04
     sudo reboot
     nvidia-smi                        # lists the card
     sudo apt install nvidia-cuda-toolkit
     ```

  2. Build Lc0 (it needs `meson`; its Python package, or the release archive
     from mesonbuild's GitHub run as `python3 meson.py`). `-Dcc_cuda=89` is the
     RTX 40 series; 86 is the 30 series, 75 the 20 series:

     ```
     git clone --depth 1 --branch v0.32.1 --recurse-submodules https://github.com/LeelaChessZero/lc0.git
     cd lc0
     meson setup build-cuda --buildtype=release -Dplain_cuda=true -Dcudnn=false -Dcc_cuda=89 \
       -Dopencl=false -Dblas=false -Donnx=false -Dgtest=false
     ninja -C build-cuda lc0
     sudo install -m 755 build-cuda/lc0 /usr/local/bin/lc0
     ```

  A driver upgrade that brings a new CUDA version may need the build repeated.

### A network

Download one from [lczero.org → Networks](https://lczero.org/play/networks/bestnets/)
and put the `.pb.gz` file in the server's `networks` folder:

| Platform | Folder |
|---|---|
| Linux | `/var/lib/lpdo/.chess-db/networks/` |
| macOS | `/Library/Application Support/LPDO/networks/` |
| Windows | `C:\ProgramData\LPDO\networks\` |

A medium network such as **t3-512x15x16h** suits a modern card; a small one
such as T1-256x10 is quicker on a weaker one. On Linux:

```
sudo install -d -o lpdo -g lpdo /var/lib/lpdo/.chess-db/networks
sudo install -m 644 -o lpdo -g lpdo t3-512x15x16h-distill-swa-2767500.pb.gz /var/lib/lpdo/.chess-db/networks/
```

The server also finds networks beside the program. Maintenance → *Others* →
**Lc0** chooses among the programs and networks found, the backend (automatic
by default) and the search threads (0 lets Lc0 choose: its work is on the
graphics card). Another network file can be named in `lc0.json` beside
`engine.json`, as `{ "weights": "/path/to/net.pb.gz" }`.

**Smart pruning** — Lc0 ending a search once its best move cannot be
overtaken — is off by default: the Engine panel shows several lines, and with it
on the second and third stop improving as soon as the first is settled. Switch
it on to have only the best move, or to spare the card.

**Benchmark:** the Lc0 card runs Lc0's standard `lc0 benchmark` — 34 positions,
ten seconds each, about six minutes — with the program, network and backend set
there. Only the full run is comparable between machines: Lc0 gets faster as each
search goes on (on an RTX 4090, 62,000 nodes/s for the standard run against
12,000 with three seconds a position, and 6,400 for `lc0 bench`).

The Linux service can use an NVIDIA card as installed: its device files are
open to every user, and the service's home, where CUDA keeps compiled kernels,
is writable.
