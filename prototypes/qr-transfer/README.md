# QR transfer — prototype

Carrying a repertoire training unit from the desktop to the phone as an
animated QR code: the payload compressed (deflate), split by a fountain code
(BC-UR, `@ngraveio/bc-ur`) into frames the phone can pick up in any order,
shown as a loop of QR codes and scanned with the phone's camera. The design
is in [docs/design/opening-repertoire.md](../../docs/design/opening-repertoire.md#practice);
this only measures whether it works well enough — nothing here ships in the
app.

## Running it

```bash
npm install
npm run phone        # builds, then serves over HTTPS on port 5443
```

`npm run phone` serves the built pages with a small Node server
(`serve.mjs`: a self-signed certificate naming this machine's addresses,
kept in `.cert/`, and a log of every connection and request).

**The iPhone needs a certificate it trusts.** Safari on iOS 18 does not let
you accept a self-signed one: "Continue" after its warning retries the
address over plain HTTP, which fails against the HTTPS port ("the network
connection was lost"). So the phone gets the pages through a Cloudflare
quick tunnel — no account, a random public address with a real certificate
while it runs (the pages carry no data; the payload goes by camera):

```bash
cloudflared tunnel --protocol http2 --url https://127.0.0.1:5443 --no-tls-verify
```

(the binary from github.com/cloudflare/cloudflared/releases; `--protocol
http2` where QUIC is blocked). The real trainer, hosted with a proper
certificate, does not have this problem.

1. On the desktop open the tunnel's `https://….trycloudflare.com/` address.
2. Choose a payload: a chapter's PGN export (the Repertoire page's ⋯ →
   Export chapter PGN…) or generated text of a given size.
3. Scan the small "Receiver" code with the phone's camera app, open the
   link, press **Start** and allow the camera.
4. Press **Play** on the desktop and point the phone at the big code. The
   phone shows progress, and at the end the time taken and a checksum that
   must match the sender's.

The phone and the desktop must be on the same network, and the port open in
the desktop's firewall.

The sliders — bytes per frame, frames per second, error correction, size —
are there to find what the phone reads fastest.

## Testing without a phone

```bash
npm run e2e -- <payload file> [bytesPerFrame=300] [fps=8] [noise=0]
```

Renders the sender's frames into a `.y4m` video, plays it to headless Chrome
as its camera, runs the receiver page on it and checks the checksum. A clean,
steady picture — it proves the pipeline, not a real camera.

## Results

Headless Chrome, fake camera, a real chapter (10.7 KB PGN, 4.6 KB
compressed), jsQR:

| Bytes a frame | Frames/s | Noise | QR version | Frames read | Time |
|---:|---:|---:|---:|---:|---:|
| 150 | 15 | ±40 | 11 | 38 | 2.4 s |
| 300 | 8 | – | 16 | 17 | 2.0 s |
| 300 | 8 | ±60 | 16 | 17 | 2.0 s |
| 400 | 10 | ±30 | 19 | 14 | 1.3 s |
| 600 | 8 | – | 23 | 9 | 1.0 s |
| 600 | 12 | ±40 | 23 | 9 | 0.6 s |

jsQR took 22–40 ms a scan on the desktop CPU.

**iPhone** (iOS 18.7, Safari, jsQR, reading the desktop's monitor):
generated text at the default settings — 300 bytes a frame, 8 frames/s,
error correction M, 560 px — arrived in **3.2 s**. At 600 bytes a frame
and 12 frames/s (QR version 23): **0.6 s and 0.9 s** at best, but at times
**up to 6 s** — the denser codes, each on screen ~80 ms, are missed more
often when the camera is not steady or in focus; the fountain code keeps
it going, only slower. Either way fast enough for a unit, taken once before
leaving. At 400 bytes and 10 frames/s: **3–4 s, consistently** — steady,
but no faster than the defaults. For the product: a steady setting like
this (300–400 bytes, 8–10 frames/s), progress shown while it reads. A
faster decoder than jsQR on the phone (ZXing as WebAssembly) may let the
denser, faster settings read as reliably — to check when the trainer is
built.
