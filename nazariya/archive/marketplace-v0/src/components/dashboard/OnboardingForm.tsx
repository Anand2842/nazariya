"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createOrg } from "@/app/actions/lister";

export function OnboardingForm({ localities }: { localities: { id: string; name: string }[] }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="card space-y-3 p-5"
      data-testid="onboarding-form"
      action={async (fd) => {
        setErr(null);
        const r = await createOrg({
          type: fd.get("type") as "brokerage",
          displayName: String(fd.get("displayName")),
          yourName: String(fd.get("yourName")),
          localities: fd.getAll("localities").map(String),
        });
        if (r.ok) router.refresh();
        else setErr([r.error, ...(r.details ?? [])].join(" · "));
      }}
    >
      <div>
        <label className="label" htmlFor="yourName">Your full name (as on PAN)</label>
        <input id="yourName" name="yourName" className="input" required minLength={2} />
      </div>
      <div>
        <label className="label" htmlFor="type">You are a…</label>
        <select id="type" name="type" className="input" defaultValue="brokerage">
          <option value="brokerage">Broker / agency</option>
          <option value="pg_operator">PG / co-living operator</option>
          <option value="property_manager">Property manager</option>
          <option value="hotel">Hotel / guesthouse</option>
          <option value="owner_individual">Owner listing my own property</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="displayName">Business or display name</label>
        <input id="displayName" name="displayName" className="input" required minLength={2} placeholder="e.g. Sharma Properties" />
      </div>
      <div>
        <p className="label">Localities you work in</p>
        <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto text-sm">
          {localities.map((l) => (
            <label key={l.id} className="flex items-center gap-1.5"><input type="checkbox" name="localities" value={l.id} /> {l.name}</label>
          ))}
        </div>
      </div>
      {err && <p className="text-sm text-rose-600" role="alert">{err}</p>}
      <button className="btn-primary w-full" type="submit" data-testid="onboarding-submit">Create lister profile</button>
    </form>
  );
}
