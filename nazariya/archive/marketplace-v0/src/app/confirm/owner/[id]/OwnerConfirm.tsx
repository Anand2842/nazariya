"use client";
import { useState } from "react";
import { ownerDecide, ownerSendCode } from "@/app/actions/owner";

export function OwnerConfirm({ authorizationId }: { authorizationId: string }) {
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (result) return <p className="rounded-xl bg-emerald-50 p-4 text-emerald-900" data-testid="owner-result">{result}</p>;
  return (
    <div className="space-y-3">
      {!sent ? (
        <button className="btn-primary w-full" data-testid="owner-send" onClick={async () => { const r = await ownerSendCode(authorizationId); if (r.ok) { setSent(true); setDevCode((r.data as { devCode?: string }).devCode ?? null); } else setErr(r.error); }}>
          Send code to my phone
        </button>
      ) : (
        <>
          <input className="input tracking-[0.4em]" inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} aria-label="Code" data-testid="owner-code" />
          {devCode && <p className="text-xs text-amber-700">Dev mode code: <b data-testid="owner-dev-code">{devCode}</b></p>}
          <div className="grid grid-cols-2 gap-2">
            <button className="btn-primary" data-testid="owner-accept" onClick={async () => { const r = await ownerDecide(authorizationId, code, true); if (r.ok) setResult("Thank you, you have confirmed this lister may market your property."); else setErr(r.error); }}>Yes, I authorise</button>
            <button className="btn-danger" onClick={async () => { const r = await ownerDecide(authorizationId, code, false); if (r.ok) setResult("Declined. Any listing relying on this request has been paused."); else setErr(r.error); }}>No, decline</button>
          </div>
        </>
      )}
      {err && <p className="text-sm text-rose-600" role="alert">{err}</p>}
    </div>
  );
}
