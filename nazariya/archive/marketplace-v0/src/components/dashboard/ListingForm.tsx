"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createListingAction } from "@/app/actions/lister";

export function ListingForm({ propertyId, category, units }: { propertyId: string; category: "pg" | "rent" | "short_stay"; units: { id: string; label: string }[] }) {
  const router = useRouter();
  const [err, setErr] = useState<string[] | null>(null);
  return (
    <form
      className="card space-y-3 p-4"
      data-testid="listing-form"
      action={async (fd) => {
        const r = await createListingAction({
          propertyId,
          category,
          title: String(fd.get("title")),
          description: String(fd.get("description") ?? ""),
          unitIds: fd.getAll("unitIds").map(String),
          terms: {},
        });
        if (r.ok) router.push(`/dashboard/listings/${(r.data as { id: string }).id}`);
        else setErr([r.error, ...(r.details ?? [])]);
      }}
    >
      <div><label className="label" htmlFor="title">Title</label><input id="title" name="title" className="input" required minLength={8} maxLength={90} placeholder="e.g. Sunny 2BHK near Lajpat Nagar metro" /></div>
      <div><label className="label" htmlFor="description">Description</label><textarea id="description" name="description" className="input min-h-28" maxLength={3000} placeholder="Describe the place. Prices go in the Pricing section, not here." /></div>
      <div>
        <p className="label">Units in this listing</p>
        {units.map((u) => <label key={u.id} className="mr-4 inline-flex items-center gap-1.5 text-sm"><input type="checkbox" name="unitIds" value={u.id} defaultChecked /> {u.label}</label>)}
      </div>
      {err && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700" role="alert">{err.map((e) => <p key={e}>{e}</p>)}</div>}
      <button className="btn-primary" type="submit" data-testid="listing-submit">Create draft listing</button>
    </form>
  );
}
