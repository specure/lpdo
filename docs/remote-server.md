# Running the server on another machine (local network)

LPDO is already split into a **client** (the desktop app) and a **server** (the
`chess-db` daemon that owns the database). Normally both run on your own machine
and talk over `127.0.0.1`. You can instead put the server on one computer — a
desktop, a home server, a NAS-like box — and use it from LPDO on other machines
on the same network. The database lives in one place; every client sees the same
games, collections and activity.

> **Local networks only.** The connection is **not encrypted** and the access
> token is sent as-is. Use this on a network you trust. Do **not** port-forward
> the server to the internet or expose it to a public/guest network.
> For an encrypted connection — including reaching the server from outside your
> home — see [Encrypted connections](#encrypted-connections) below.

## How access is controlled

While the server listens only on `127.0.0.1`, the operating system guarantees
that nothing outside the machine can reach it, so there is nothing to configure.

The moment it listens on the network, that guarantee is gone — and the API can
delete games, purge the database and reset setup. So a network-facing server
**requires an access token**: it generates one the first time it starts that way
and refuses to serve requests without it. The token is a long random string kept
in the server's data directory:

| Platform | Token file |
|---|---|
| Windows | `C:\ProgramData\LPDO\access-token` |
| Linux | `/var/lib/lpdo/.chess-db/access-token` |
| macOS | `/Library/Application Support/LPDO/access-token` |

Anyone with the token has full control of the database, so treat it like a
password. `GET /status` (version and counters only) stays open, which is how a
client can tell "server unreachable" from "wrong token".

## Setting up the server

### Windows

Tick **"Allow other computers on this network to connect"** on the installer's
components page. That is all: the service is configured to listen on the network
and a firewall rule is added for private networks. The setting is remembered
across upgrades.

To turn it off later, re-run the installer and untick it.

### Linux

Add the bind address to the service environment:

```bash
sudo systemctl edit lpdo-server
```

```ini
[Service]
Environment=LPDO_BIND=0.0.0.0
```

```bash
sudo systemctl restart lpdo-server
sudo cat /var/lib/lpdo/.chess-db/access-token   # note this down
```

The token file is written as the server starts; if `cat` says it doesn't exist
yet, wait a second and retry.

If a firewall is active, allow the port — e.g. `sudo ufw allow 7777/tcp`.

### macOS

Add to `/Library/LaunchDaemons/com.specure.lpdo.server.plist`, inside the
existing `EnvironmentVariables` dictionary:

```xml
<key>LPDO_BIND</key>
<string>0.0.0.0</string>
```

Then reload it:

```bash
sudo launchctl bootout system/com.specure.lpdo.server
sudo launchctl bootstrap system /Library/LaunchDaemons/com.specure.lpdo.server.plist
sudo cat "/Library/Application Support/LPDO/access-token"
```

### Running it by hand

```bash
chess-db serve --bind 0.0.0.0            # any interface
chess-db serve --bind 192.168.1.50       # one specific interface
```

`--bind` beats `$LPDO_BIND`; the default stays `127.0.0.1`.

## Pointing the client at it

In LPDO on the client machine: **Maintenance → Others → Server connection**.

1. **Server address** — `http://<server-ip-or-hostname>:7777`
2. **Access token** — paste the contents of the server's `access-token` file
3. **Save and reconnect**

"Use this machine" switches back to the local server. This card is reachable
even when the app shows *Server offline*, which is exactly when you need it.

A client-only install is a normal option: on Windows, untick the database-server
component (and its LAN option) so the machine runs just the app.

## Using the CLI against it

```bash
chess-db --host 192.168.1.50 --token <token> status
chess-db --host 192.168.1.50 --token <token> sources list

export LPDO_HOST=192.168.1.50            # or set these once
export LPDO_TOKEN=<token>
chess-db status
```

`--host` implies remote operation: if the server cannot be reached, the command
fails rather than quietly falling back to a local database.

## Notes and limits

- **Several clients at once** work. The server serialises all writes, so
  everyone sees one consistent database and the same activity list.
- **A server without internet access** still works: imports of your own PGN files
  are uploaded from the client, so they need no connectivity on the server. The
  online sources (TWIC, Lichess, the FIDE list) will keep pausing and retrying,
  since they are the server's own downloads.
- **First-run setup** can be done remotely, but the wizard's sources are
  downloaded *by the server* — so an offline server should be filled by importing
  PGN files from a client instead.
- **Local PGN browsing** (the PGNs tab) always reads files on the *client*
  machine; it never touches the server.
- **Backups** are built by the server and streamed to the client, so the file is
  saved where you ask for it on the client machine.
- **No TLS, no user accounts.** One shared token per server; anyone holding it
  has full access.

## Encrypted connections

LPDO's own protocol is deliberately plain HTTP + token, scoped to a trusted
LAN. When you want encryption — an untrusted network segment, or access from
outside the house — put the connection inside a secure tunnel instead of
exposing port 7777. This is not a workaround: tools like WireGuard use
better-reviewed cryptography and identity handling than an application should
hand-roll, and they compose cleanly with the token.

### Tailscale (easiest, works from anywhere)

[Tailscale](https://tailscale.com/) builds a private WireGuard mesh between
your devices; free for personal use.

1. Install Tailscale on the server machine and on each client machine, signed
   into the same account.
2. Server setup is exactly as above (`LPDO_BIND=0.0.0.0` + token). Traffic on
   the tailnet is end-to-end encrypted, and machines outside your tailnet
   cannot reach the port at all.
3. In the client, use the server's Tailscale address:
   `http://<server-tailscale-ip>:7777` (or its MagicDNS name).

This also solves "use my database from anywhere" — a laptop on hotel Wi-Fi
reaches the tailnet exactly as it would at home, still encrypted.

For a plain **WireGuard** setup without Tailscale's account layer, the same
applies: put both machines in the tunnel and use the tunnel addresses.

### SSH tunnel (no LAN mode needed at all)

If the server machine runs SSH, you can skip LAN mode entirely — the server
stays loopback-only with **no open port and no token**, which is the most
locked-down configuration possible:

```bash
# on the client machine — forwards local 7777 to the server's loopback
ssh -N -L 7777:localhost:7777 user@server
```

Leave the client's server address at its default
(`http://127.0.0.1:7777`); the tunnel delivers it to the server machine,
encrypted and authenticated by your SSH keys.

### What not to do

- Don't port-forward 7777 on your router. There is no TLS and one shared
  token; the internet is not a trusted network.
- Don't put the server on a public/guest network segment, even with the token.

Native in-app encryption (certificate pairing between client and server) is a
possible future feature — tracked in the issue linked from #247 — but the
tunnel approaches above are not a stopgap; they are what we recommend.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| *Server offline* in the client | Wrong address or port; server not started with a bind address; firewall blocking 7777 |
| Client connects but every action fails | Missing or wrong access token |
| CLI: "no lpdo-server daemon reachable" | Same as above — the message lists what to check |
| CLI: "rejected the access token" | `--token`/`$LPDO_TOKEN` does not match the server's file |
| Works on the server machine, not from others | Server is still on `127.0.0.1`, or the firewall rule is missing |
