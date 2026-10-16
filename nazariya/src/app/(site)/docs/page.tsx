import type { Metadata } from "next";

export const metadata: Metadata = { title: "Developers" };

const base = (process.env.APP_URL ?? "http://localhost:3100").replace(/\/$/, "");

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-emerald-200">{children}</pre>;
}

export default function Docs() {
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-8 text-sm leading-relaxed text-slate-700">
      <div>
        <h1 className="text-3xl font-extrabold text-ink">Developer guide</h1>
        <p className="mt-2">Every published space has a public ID (e.g. <code>k3m9x2pqra</code>). Use it to embed the tour on a website, in an app, or to fetch its data.</p>
      </div>
      <section>
        <h2 className="text-xl font-bold text-ink">1. iframe (any website or CMS)</h2>
        <Code>{`<iframe src="${base}/embed/SPACE_ID" width="100%" height="560"
  style="border:0;border-radius:12px" loading="lazy"
  allow="fullscreen; gyroscope; accelerometer; xr-spatial-tracking" allowfullscreen></iframe>`}</Code>
        <p className="mt-2">URL options: <code>?room=ROOM_ID</code> open a room · <code>view=3d|360|photos</code> · <code>autostart=1</code> skip the cover · <code>rooms=0</code> hide the room list.</p>
      </section>
      <section>
        <h2 className="text-xl font-bold text-ink">2. JavaScript SDK (control the tour from your page)</h2>
        <Code>{`<div id="tour" style="height:560px"></div>
<script src="${base}/sdk/nazariya.js"></script>
<script>
  const tour = Nazariya.embed("#tour", { space: "SPACE_ID", autostart: false });
  tour.on("ready", e => console.log(e.rooms));          // [{id, label}]
  tour.on("roomchange", e => console.log(e.label));
  tour.on("hotspotclick", e => console.log(e.title));
  tour.goToRoom("Kitchen");    // id, name or index
  tour.setView("360");         // "3d" | "360" | "photos"
</script>`}</Code>
        <p className="mt-2">Events: <code>ready</code>, <code>start</code>, <code>roomchange</code>, <code>viewchange</code>, <code>hotspotclick</code>, <code>error</code> (fallback). No-code: <code>{`<div data-nazariya-space="SPACE_ID" style="height:560px"></div>`}</code>.</p>
      </section>
      <section>
        <h2 className="text-xl font-bold text-ink">3. Mobile apps</h2>
        <p>Load <code>{`${base}/embed/SPACE_ID?autostart=1`}</code> in a WebView (Android WebView, iOS WKWebView, react-native-webview). Enable JavaScript and WebGL.</p>
      </section>
      <section>
        <h2 className="text-xl font-bold text-ink">4. REST API</h2>
        <p>Create an API key in Studio → Branding &amp; API keys. Keys are secret: call the API from your server, not from browsers.</p>
        <Code>{`curl -H "Authorization: Bearer nz_live_..." ${base}/api/v1/spaces
curl -H "Authorization: Bearer nz_live_..." "${base}/api/v1/spaces?externalRef=YOUR_LISTING_ID"
curl -H "Authorization: Bearer nz_live_..." ${base}/api/v1/spaces/SPACE_ID`}</Code>
        <p className="mt-2">List items include <code>embedUrl</code>, <code>shareUrl</code>, ready-made <code>iframe</code> HTML and <code>posterUrl</code>. The detail endpoint adds rooms with their 360°/3D asset URLs and hotspots, for apps that render their own UI.</p>
      </section>
      <section>
        <h2 className="text-xl font-bold text-ink">5. oEmbed (WordPress and other CMSs)</h2>
        <Code>{`GET ${base}/api/oembed?url=${base}/t/SPACE_ID`}</Code>
      </section>
      <section>
        <h2 className="text-xl font-bold text-ink">Domain restrictions</h2>
        <p>Set allowed websites per space in Studio. The embed then sends <code>Content-Security-Policy: frame-ancestors</code> with only those domains, so browsers refuse to show it elsewhere.</p>
      </section>
    </div>
  );
}
