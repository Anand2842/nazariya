// HTTPS front for a production build on the LAN (phones only allow camera/motion sensors on secure origins).
// Forwards https://<lan-ip>:<port> to the app on 127.0.0.1:<target>, keeping the Host header so origin checks
// and links stay on the LAN address. Uses the self-signed certificate made by scripts/dev-https.sh.
// Usage: node scripts/https-proxy.mjs <listenPort> <targetPort>
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const [listen = "3443", target = "3100"] = process.argv.slice(2);
const server = https.createServer({ key: readFileSync(".certs/dev-key.pem"), cert: readFileSync(".certs/dev.pem") }, (req, res) => {
  const up = http.request(
    { host: "127.0.0.1", port: Number(target), path: req.url, method: req.method, headers: { ...req.headers, "x-forwarded-proto": "https", "x-forwarded-host": req.headers.host } },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("App not reachable");
  });
  req.pipe(up);
});
// Large uploads (30 photos) must not be cut off by the default request timeout.
server.requestTimeout = 0;
server.listen(Number(listen), "0.0.0.0", () => console.log(`HTTPS proxy :${listen} → 127.0.0.1:${target}`));
