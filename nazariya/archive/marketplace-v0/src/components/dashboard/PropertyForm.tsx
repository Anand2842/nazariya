"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createPropertyAction } from "@/app/actions/lister";
import { AMENITIES } from "@/lib/catalog";

type Cat = "pg" | "apartment" | "hotel";
interface UnitRow { label: string; sharing: number; ac: boolean; attachedBath: boolean; bhk: number; bathrooms: number; balconies: number; furnishing: string; floor: string; area: string; maxOccupancy: number; inventory: number }
const blank = (cat: Cat, i: number): UnitRow => ({
  label: cat === "pg" ? `Room ${101 + i}` : cat === "hotel" ? (i ? "Executive" : "Deluxe") : "Flat",
  sharing: 2, ac: true, attachedBath: true, bhk: 2, bathrooms: 2, balconies: 1, furnishing: "semi", floor: "", area: "", maxOccupancy: 2, inventory: 5,
});

export function PropertyForm({ localities, orgType, myPhone }: { localities: { id: string; name: string }[]; orgType: string; myPhone: string }) {
  const router = useRouter();
  const [cat, setCat] = useState<Cat>(orgType === "hotel" ? "hotel" : orgType === "pg_operator" ? "pg" : "apartment");
  const [units, setUnits] = useState<UnitRow[]>([blank(cat, 0)]);
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = orgType === "owner_individual";
  const set = (i: number, patch: Partial<UnitRow>) => setUnits(units.map((u, j) => (j === i ? { ...u, ...patch } : u)));

  return (
    <form
      className="space-y-5"
      data-testid="property-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setBusy(true);
        setErr(null);
        const houseRules: Record<string, string> = {};
        for (const k of ["gender", "curfew", "food", "visitors", "tenantPreference", "pets", "checkIn", "checkOut", "cancellation"]) {
          const v = String(fd.get(k) ?? "").trim();
          if (v) houseRules[k] = v;
        }
        const num = (s: string) => (s === "" ? null : Number(s));
        const r = await createPropertyAction({
          category: cat,
          name: String(fd.get("name") || "") || null,
          addressLine: String(fd.get("addressLine")),
          localityId: String(fd.get("localityId")),
          pincode: String(fd.get("pincode") || "") || null,
          floorsTotal: num(String(fd.get("floorsTotal") ?? "")),
          amenities: fd.getAll("amenities").map(String),
          houseRules,
          owner: isOwner ? { name: "Self", phone: myPhone, relationship: "owner" } : { name: String(fd.get("ownerName")), phone: String(fd.get("ownerPhone")), relationship: String(fd.get("ownerRel") || "owner") },
          authorizationBasis: isOwner ? "owner_self" : cat === "hotel" ? "hotel_management" : cat === "pg" ? "operator_lease" : "owner_mandate",
          exclusive: fd.get("exclusive") === "on",
          units: units.map((u) =>
            cat === "pg"
              ? { kind: "pg_room" as const, label: u.label, sharingCapacity: u.sharing, ac: u.ac, attachedBath: u.attachedBath, floor: num(u.floor) }
              : cat === "hotel"
                ? { kind: "hotel_room_type" as const, label: u.label, maxOccupancy: u.maxOccupancy, inventoryCount: u.inventory, declaredAreaSqft: num(u.area), ac: u.ac, attachedBath: true }
                : { kind: "flat" as const, label: u.label, bhk: u.bhk, bathrooms: u.bathrooms, balconies: u.balconies, furnishing: u.furnishing as "semi", floor: num(u.floor), declaredAreaSqft: num(u.area) },
          ),
        });
        setBusy(false);
        if (r.ok) router.push(`/dashboard/listings/new?propertyId=${(r.data as { propertyId: string }).propertyId}`);
        else setErr([r.error, ...(r.details ?? [])]);
      }}
    >
      <div className="card space-y-3 p-4">
        <p className="section-title">Property</p>
        <div className="flex gap-2" role="radiogroup" aria-label="Category">
          {(["pg", "apartment", "hotel"] as Cat[]).map((c) => (
            <button key={c} type="button" role="radio" aria-checked={cat === c} onClick={() => { setCat(c); setUnits([blank(c, 0)]); }} className={`btn ${cat === c ? "bg-nazar text-white" : "border border-slate-300 bg-white"}`} data-testid={`cat-${c}`}>
              {c === "pg" ? "PG / co-living" : c === "apartment" ? "Flat / house" : "Hotel"}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="name">Name (optional)</label><input id="name" name="name" className="input" /></div>
          <div><label className="label" htmlFor="localityId">Locality</label>
            <select id="localityId" name="localityId" className="input" required>{localities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="addressLine">Full address (private until enquiry)</label><input id="addressLine" name="addressLine" className="input" required minLength={5} /></div>
          <div><label className="label" htmlFor="pincode">Pincode</label><input id="pincode" name="pincode" className="input" inputMode="numeric" maxLength={6} /></div>
          <div><label className="label" htmlFor="floorsTotal">Floors in building</label><input id="floorsTotal" name="floorsTotal" type="number" min={1} className="input" /></div>
        </div>
        <div>
          <p className="label">Amenities</p>
          <div className="grid grid-cols-2 gap-1 text-sm sm:grid-cols-4">
            {Object.entries(AMENITIES).map(([k, v]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" name="amenities" value={k} /> {v}</label>)}
          </div>
        </div>
      </div>

      <div className="card space-y-3 p-4">
        <p className="section-title">{cat === "pg" ? "Rooms & beds" : cat === "hotel" ? "Room types" : "Unit"}</p>
        {units.map((u, i) => (
          <div key={i} className="grid gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-6" data-testid="unit-row">
            <input className="input sm:col-span-2" value={u.label} onChange={(e) => set(i, { label: e.target.value })} aria-label="Unit name" required />
            {cat === "pg" && (<>
              <select className="input" value={u.sharing} onChange={(e) => set(i, { sharing: Number(e.target.value) })} aria-label="Sharing">{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}-sharing</option>)}</select>
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={u.ac} onChange={(e) => set(i, { ac: e.target.checked })} /> AC</label>
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={u.attachedBath} onChange={(e) => set(i, { attachedBath: e.target.checked })} /> Attached bath</label>
              <input className="input" placeholder="Floor" value={u.floor} onChange={(e) => set(i, { floor: e.target.value })} aria-label="Floor" />
            </>)}
            {cat === "apartment" && (<>
              <select className="input" value={u.bhk} onChange={(e) => set(i, { bhk: Number(e.target.value) })} aria-label="BHK">{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} BHK</option>)}</select>
              <select className="input" value={u.furnishing} onChange={(e) => set(i, { furnishing: e.target.value })} aria-label="Furnishing"><option value="unfurnished">Unfurnished</option><option value="semi">Semi</option><option value="full">Full</option></select>
              <input className="input" type="number" min={0} value={u.bathrooms} onChange={(e) => set(i, { bathrooms: Number(e.target.value) })} aria-label="Bathrooms" />
              <input className="input" placeholder="Area sq ft (declared)" value={u.area} onChange={(e) => set(i, { area: e.target.value })} aria-label="Area" />
            </>)}
            {cat === "hotel" && (<>
              <input className="input" type="number" min={1} value={u.maxOccupancy} onChange={(e) => set(i, { maxOccupancy: Number(e.target.value) })} aria-label="Max guests" />
              <input className="input" type="number" min={1} value={u.inventory} onChange={(e) => set(i, { inventory: Number(e.target.value) })} aria-label="Number of rooms" />
              <input className="input" placeholder="Area sq ft" value={u.area} onChange={(e) => set(i, { area: e.target.value })} aria-label="Area" />
            </>)}
          </div>
        ))}
        {cat !== "apartment" && <button type="button" className="btn-ghost text-sm" onClick={() => setUnits([...units, blank(cat, units.length)])} data-testid="add-unit">+ Add {cat === "pg" ? "room" : "room type"}</button>}
      </div>

      <div className="card space-y-3 p-4">
        <p className="section-title">Rules & policies</p>
        {cat === "pg" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <select name="gender" className="input" aria-label="Gender policy"><option value="female">Women only</option><option value="male">Men only</option><option value="coed">Co-living</option></select>
            <input name="curfew" className="input" placeholder="Curfew (e.g. 22:30)" aria-label="Curfew" />
            <input name="food" className="input" placeholder="Food (e.g. 3 veg meals/day)" aria-label="Food" />
            <input name="visitors" className="input" placeholder="Visitor policy" aria-label="Visitors" />
          </div>
        )}
        {cat === "apartment" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <input name="tenantPreference" className="input" placeholder="Owner's tenant policy (optional)" aria-label="Tenant preference" />
            <input name="pets" className="input" placeholder="Pets policy" aria-label="Pets" />
          </div>
        )}
        {cat === "hotel" && (
          <div className="grid gap-3 sm:grid-cols-3">
            <input name="checkIn" className="input" defaultValue="12:00" aria-label="Check-in" />
            <input name="checkOut" className="input" defaultValue="11:00" aria-label="Check-out" />
            <input name="cancellation" className="input" placeholder="Cancellation policy" aria-label="Cancellation" />
          </div>
        )}
        <p className="text-xs text-slate-500">Rules are shown as your stated policy. Text that excludes people by religion, caste or region is not allowed.</p>
      </div>

      {!isOwner && (
        <div className="card space-y-3 p-4">
          <p className="section-title">Owner / landlord</p>
          <p className="muted">We will ask the owner to confirm you may list this property. Listings can be published only after the owner confirms.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <input name="ownerName" className="input" placeholder="Owner name" required aria-label="Owner name" />
            <input name="ownerPhone" className="input" placeholder="Owner mobile" required inputMode="tel" aria-label="Owner phone" />
            <input name="ownerRel" className="input" defaultValue={cat === "pg" ? "landlord" : "owner"} aria-label="Relationship" />
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="exclusive" /> Exclusive mandate (no other lister may list this unit)</label>
        </div>
      )}
      {err && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700" role="alert">{err.map((e) => <p key={e}>{e}</p>)}</div>}
      <button className="btn-primary w-full sm:w-auto" disabled={busy} type="submit" data-testid="property-submit">{busy ? "Saving…" : "Save property & continue"}</button>
    </form>
  );
}
