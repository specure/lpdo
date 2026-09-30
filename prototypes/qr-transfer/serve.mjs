// Serves the built pages (dist/) over HTTPS, logging every connection and
// request — to see how far a phone gets. The certificate is self-signed,
// with this machine's network addresses in it, kept in .cert/. Safari on the
// iPhone will not accept it (see README): the phone goes through a tunnel.
//
// usage: npm run phone   (builds, then serves on port 5443)
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "dist");
const CERT = resolve(import.meta.dirname, ".cert");
const PORT = Number(process.env.PORT ?? 5443);

const ips = Object.values(networkInterfaces()).flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);

// A self-signed certificate naming localhost and every current address;
// made again when the addresses change (another network).
const key = join(CERT, "key.pem"), crt = join(CERT, "cert.pem"), names = join(CERT, "names");
const wanted = ["DNS:localhost", "IP:127.0.0.1", ...ips.map((ip) => `IP:${ip}`)].join(",");
if (!existsSync(names) || readFileSync(names, "utf8") !== wanted) {
  mkdirSync(CERT, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
    "-keyout", key, "-out", crt, "-subj", "/CN=LPDO QR prototype",
    "-addext", `subjectAltName=${wanted}`, "-addext", "extendedKeyUsage=serverAuth"], { stdio: "ignore" });
  writeFileSync(names, wanted);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" };

const server = createServer({ key: readFileSync(key), cert: readFileSync(crt) }, (req, res) => {
  console.log(`${new Date().toISOString().slice(11, 19)} ${req.socket.remoteAddress} ${req.method} ${req.url} (${req.headers["user-agent"]?.slice(0, 60)})`);
  let path = decodeURIComponent(new URL(req.url, "https://x").pathname);
  if (path === "/") path = "/index.html";
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
});
// Connections and TLS failures too: a phone that never gets as far as a
// request shows up here.
server.on("secureConnection", (t) => console.log(`${new Date().toISOString().slice(11, 19)} ${t.remoteAddress} TLS ${t.getProtocol()} ${t.alpnProtocol || "-"}`));
server.on("tlsClientError", (e, t) => console.log(`${new Date().toISOString().slice(11, 19)} ${t?.remoteAddress} TLS error: ${e.code ?? e.message}`));
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Serving dist/ over HTTPS (HTTP/1.1) on port ${PORT}:`);
  for (const ip of ["localhost", ...ips]) console.log(`  https://${ip}:${PORT}/`);
});
