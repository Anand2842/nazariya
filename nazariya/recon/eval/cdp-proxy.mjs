// Loopback adapter: exposes the phone's Chrome DevTools (adb-forwarded on 9333) on 9334 with a browser
// websocket URL that includes an id (/devtools/browser/<id>), which desktop-style CDP clients expect.
import http from "node:http";
import net from "node:net";
const UP = 9333, PORT = 9334, ID = "android-chrome";
const fix = (s) => s.replaceAll(`127.0.0.1:${UP}`, `127.0.0.1:${PORT}`).replace(/\/devtools\/browser"/g, `/devtools/browser/${ID}"`);
http.createServer((req, res) => {
  http.get({ host: "127.0.0.1", port: UP, path: req.url }, (r) => {
    let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { res.writeHead(r.statusCode, { "content-type": "application/json" }); res.end(fix(b)); });
  }).on("error", (e) => { res.writeHead(502); res.end(String(e)); });
}).on("upgrade", (req, sock, head) => {
  const path = req.url.replace(`/devtools/browser/${ID}`, "/devtools/browser");
  const up = net.connect(UP, "127.0.0.1", () => {
    const lines = [`${req.method} ${path} HTTP/1.1`, ...Object.entries(req.headers).map(([k, v]) => `${k}: ${k === "host" ? `127.0.0.1:${UP}` : v}`), "", ""];
    up.write(lines.join("\r\n")); if (head?.length) up.write(head); sock.pipe(up).pipe(sock);
  });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
}).listen(PORT, "127.0.0.1", () => console.log("cdp proxy on", PORT));
