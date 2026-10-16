"use client";
import QRCode from "qrcode";
import { useState } from "react";
import { createCaptureLinkAction } from "@/app/actions/studio";

/** Lets a user start capture on their phone: a QR code with a short-lived, space-scoped capture link. */
export function PhoneCapturePanel({ spaceId, zoneId }: { spaceId: string; zoneId: string | null }) {
  const [link, setLink] = useState<{ url: string; qr: string; expiresAt: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const insecureLan = typeof window !== "undefined" && window.location.protocol === "http:" && window.location.hostname === "localhost";
  return (
    <div className="rounded-xl bg-slate-50 p-3 text-sm" data-testid="phone-capture">
      <p className="font-semibold">📱 Capture on your phone</p>
      <p className="text-xs text-slate-600">Scan the code with your phone camera. It opens the guided capture for this room; no login needed (link expires in 2 hours).</p>
      {!link ? (
        <button
          type="button"
          className="btn-secondary mt-2 w-full"
          data-testid="phone-capture-create"
          onClick={async () => {
            setErr(null);
            const r = await createCaptureLinkAction(spaceId, zoneId);
            if (!r.ok) return setErr(r.error);
            const d = r.data as { token: string; expiresAt: string };
            const url = `${window.location.origin}/capture/${d.token}${zoneId ? `?room=${zoneId}` : ""}`;
            setLink({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }), expiresAt: d.expiresAt });
          }}
        >
          Show QR code
        </button>
      ) : (
        <div className="mt-2 flex flex-col items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={link.qr} alt="QR code for phone capture" className="h-44 w-44 rounded-lg bg-white p-1" data-testid="phone-capture-qr" />
          <a className="break-all text-center text-xs text-nazar underline" href={link.url} target="_blank" data-testid="phone-capture-url">{link.url}</a>
          <p className="text-[11px] text-slate-500">Expires {new Date(link.expiresAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p>
        </div>
      )}
      {insecureLan && (
        <p className="mt-2 text-[11px] text-amber-700">Phones need HTTPS for camera and motion sensors. For local testing run <code>npm run dev:https</code> and open the studio via the https:// address it prints.</p>
      )}
      {err && <p className="mt-1 text-xs text-rose-600">{err}</p>}
    </div>
  );
}
