"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { brandingAction } from "@/app/actions/studio";
import { Msg, useAction } from "./useAction";

export function BrandingForm({ orgId, branding, logoUrl, plan }: { orgId: string; branding: { primaryColor: string; showPoweredBy: boolean; logoAssetId?: string | null }; logoUrl: string | null; plan: string }) {
  const router = useRouter();
  const { msg, busy, run, setMsg } = useAction();
  const [color, setColor] = useState(branding.primaryColor);
  const [logoId, setLogoId] = useState<string | null>(branding.logoAssetId ?? null);
  return (
    <form
      className="card space-y-3 p-4"
      data-testid="branding-form"
      action={(fd) => void run(() => brandingAction(orgId, { primaryColor: color, showPoweredBy: fd.get("powered") === "on", logoAssetId: logoId }), "Branding saved")}
    >
      <p className="section-title">Viewer branding</p>
      <label className="flex items-center gap-3 text-sm">Brand colour <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Brand colour" /> <code>{color}</code></label>
      <div className="text-sm">
        <p className="mb-1">Logo (shown in the viewer)</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {logoUrl && <img src={logoUrl} alt="Current logo" className="mb-2 h-8 rounded bg-slate-800 p-1" />}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const fd = new FormData();
            fd.set("file", f);
            fd.set("kind", "logo");
            const res = await fetch("/api/uploads", { method: "POST", body: fd });
            const data = await res.json();
            if (!res.ok) return setMsg({ tone: "err", lines: [data.error] });
            setLogoId(data.asset.id);
            setMsg({ tone: "ok", lines: ["Logo uploaded: click Save to apply"] });
            router.refresh();
          }}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="powered" defaultChecked={branding.showPoweredBy} disabled={plan === "trial"} /> Show &ldquo;Powered by Nazariya&rdquo;
        {plan === "trial" && <span className="text-xs text-slate-500">(removable on Pro)</span>}
      </label>
      <button className="btn-primary" disabled={busy} type="submit">Save branding</button>
      <Msg msg={msg} />
    </form>
  );
}
