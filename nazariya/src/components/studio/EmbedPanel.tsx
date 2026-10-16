"use client";
import { useState } from "react";
import { updateSpaceAction } from "@/app/actions/studio";
import { CopyButton } from "./CopyButton";
import { Msg, useAction } from "./useAction";

export function EmbedPanel({ spaceId, publicId, base, iframe, sdk, allowedDomains, published }: { spaceId: string; publicId: string; base: string; iframe: string; sdk: string; allowedDomains: string[]; published: boolean }) {
  const [tab, setTab] = useState<"iframe" | "sdk" | "link" | "app">("iframe");
  const { msg, busy, run } = useAction();
  const share = `${base}/t/${publicId}`;
  const code = tab === "iframe" ? iframe : tab === "sdk" ? sdk : tab === "link" ? share : `// Android (WebView) / iOS (WKWebView) / React Native (react-native-webview)\nwebView.loadUrl("${base}/embed/${publicId}?autostart=1")\n\n// Or fetch tour data for a native UI:\nGET ${base}/api/v1/spaces/${publicId}\nAuthorization: Bearer <your API key>`;
  return (
    <section className="card space-y-3 p-4" data-testid="embed-panel">
      <div className="flex items-center justify-between">
        <p className="section-title">Embed & share</p>
        {!published && <span className="chip bg-amber-50 text-amber-800">Publish to make the embed live</span>}
      </div>
      <div className="flex flex-wrap gap-1" role="tablist">
        {([["iframe", "Website (iframe)"], ["sdk", "JavaScript SDK"], ["link", "Share link"], ["app", "Mobile app"]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === k ? "bg-ink text-white" : "bg-slate-100"}`} data-testid={`embed-tab-${k}`}>{l}</button>
        ))}
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-slate-900 p-3 text-xs text-emerald-200" data-testid="embed-code">{code}</pre>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={code} label="Copy code" testId="copy-embed" />
        <a className="btn-ghost px-3 py-1.5 text-xs" href={`/examples/agency-site.html?space=${publicId}`} target="_blank">See it on an example website ↗</a>
      </div>
      <form
        className="space-y-2 rounded-xl bg-slate-50 p-3"
        action={(fd) => void run(() => updateSpaceAction(spaceId, { allowedDomains: String(fd.get("domains")).split(/[\s,]+/).filter(Boolean) }), "Allowed domains saved")}
      >
        <label className="label" htmlFor="domains">Allowed websites (optional)</label>
        <input id="domains" name="domains" className="input" defaultValue={allowedDomains.join(", ")} placeholder="skylinehomes.in, *.skylinehomes.in" data-testid="domains-input" />
        <p className="text-xs text-slate-500">If set, only these domains can embed this tour (enforced with Content-Security-Policy frame-ancestors). Leave empty to allow any site.</p>
        <button className="btn-secondary px-3 py-1.5 text-xs" disabled={busy} type="submit" data-testid="domains-save">Save domains</button>
      </form>
      <Msg msg={msg} />
    </section>
  );
}
