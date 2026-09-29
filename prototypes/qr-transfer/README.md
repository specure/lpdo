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
npm run dev          # HTTPS on port 5443, self-signed
```

1. On the desktop open the **Network** address Vite prints
   (`https://<this machine's IP>:5443/`), not localhost, and accept the
   certificate warning.
2. Choose a payload: a chapter's PGN export (the Repertoire page's ⋯ →
   Export chapter PGN…) or generated text of a given size.
3. Scan the small "Receiver" code with the phone's camera app, open the
   link, accept the certificate warning, press **Start** and allow the
   camera.
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

**iPhone:** to do — the measurement this prototype is for.
