"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { digilockerAction, panAction, reraAction } from "@/app/actions/lister";

export function KycForms({ hasPan, hasDl }: { hasPan: boolean; hasDl: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const done = (r: { ok: boolean; error?: string; data?: unknown }, ok: string) => {
    setMsg(r.ok ? ok : r.error ?? "Failed");
    router.refresh();
  };
  return (
    <div className="space-y-4">
      {!hasPan && (
        <form className="card space-y-2 p-4" data-testid="pan-form" action={async (fd) => done(await panAction(String(fd.get("pan")), String(fd.get("name"))), "PAN submitted")}>
          <p className="font-semibold">PAN verification</p>
          <p className="muted">Sandbox provider in this demo. Only a masked PAN is stored.</p>
          <input name="pan" className="input uppercase" placeholder="ABCDE1234F" maxLength={10} required aria-label="PAN" />
          <input name="name" className="input" placeholder="Name exactly as on PAN" required aria-label="Name on PAN" />
          <button className="btn-primary" type="submit">Verify PAN</button>
        </form>
      )}
      {!hasDl && (
        <form className="card space-y-2 p-4" data-testid="dl-form" action={async (fd) => done(await digilockerAction(fd.get("consent") === "on"), "Government ID verified via DigiLocker (sandbox)")}>
          <p className="font-semibold">Government ID via DigiLocker</p>
          <p className="muted">You will be asked to consent in DigiLocker. Nazariya never stores your Aadhaar number.</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="consent" required /> I consent to share my ID details for verification</label>
          <button className="btn-primary" type="submit">Continue with DigiLocker</button>
        </form>
      )}
      <form className="card space-y-2 p-4" action={async (fd) => done(await reraAction(String(fd.get("rera"))), "RERA number submitted for review")}>
        <p className="font-semibold">Delhi RERA agent registration (optional)</p>
        <p className="muted">Shown on your profile after our team checks it on the RERA portal.</p>
        <input name="rera" className="input" placeholder="DLRERA2024A0123" required aria-label="RERA number" />
        <button className="btn-secondary" type="submit">Submit for review</button>
      </form>
      {msg && <p className="text-sm text-nazar" role="status">{msg}</p>}
    </div>
  );
}
