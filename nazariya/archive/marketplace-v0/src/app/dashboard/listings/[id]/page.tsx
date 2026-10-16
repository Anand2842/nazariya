import Link from "next/link";
import { notFound } from "next/navigation";
import { AuthorizationPanel, AvailabilityPanel, DetailsPanel, PricingEditor, StatusPanel } from "@/components/dashboard/EditorPanels";
import { TourEditor } from "@/components/dashboard/TourEditor";
import { TrustBadges } from "@/components/TrustBadges";
import { todayIST } from "@/lib/availability";
import { formatINR } from "@/lib/money";
import { maskPhone } from "@/server/auth";
import { DomainError } from "@/server/errors";
import { listingEditorData } from "@/server/listings";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ListingEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/dashboard/listings/${id}`);
  let d;
  try {
    d = await listingEditorData(user, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ser = (x: unknown): any => JSON.parse(JSON.stringify(x));
  const listingUnits = d.allUnits.filter((u) => d.unitIds.includes(u.id));
  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-6" data-testid="listing-editor">
      <div>
        <Link href="/dashboard" className="text-sm text-nazar">← Dashboard</Link>
        <h1 className="mt-1 text-2xl font-extrabold">{d.listing.title}</h1>
        <p className="muted">{d.property.name ?? d.property.addressLine} · {d.locality.name}</p>
        <div className="mt-2"><TrustBadges badges={d.badges} showMissing /></div>
      </div>
      <StatusPanel listingId={d.listing.id} status={d.listing.status} slug={d.listing.slug} checklist={d.checklist} />
      <div className="grid gap-5 lg:grid-cols-2">
        <PricingEditor
          listingId={d.listing.id}
          category={d.listing.category}
          roomTypes={listingUnits.filter((u) => u.kind === "hotel_room_type").map((u) => ({ id: u.id, label: u.label }))}
          plans={d.plans.map((p) => ({ planKey: p.plan.planKey, label: p.plan.label, appliesTo: p.plan.appliesTo, basePaise: p.plan.basePaise, period: p.plan.period as "month", unitId: p.plan.unitId, mealPlan: p.plan.mealPlan, charges: p.input.charges, version: p.plan.version }))}
        />
        <AvailabilityPanel
          listingId={d.listing.id}
          category={d.listing.category}
          units={listingUnits.map((u) => ({ id: u.id, label: u.label, kind: u.kind, inventoryCount: u.inventoryCount }))}
          beds={ser(d.beds)}
          availability={ser(d.availability)}
          nightly={ser(d.nightly)}
          today={todayIST()}
        />
      </div>
      <TourEditor
        listingId={d.listing.id}
        propertyId={d.property.id}
        zones={ser(d.tour.map((z) => ({ ...z, unitId: z.unitId, roomDims: z.roomDims })))}
        units={d.allUnits.map((u) => ({ id: u.id, label: u.label }))}
        media={d.media.map((m) => ({ id: m.id, kind: m.kind, status: m.status, rejectReason: m.rejectReason, originalName: m.originalName, thumb: m.urls?.thumb ?? null, meta: m.meta as Record<string, unknown> }))}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <AuthorizationPanel
          listingId={d.listing.id}
          category={d.listing.category}
          authorization={d.authorization ? { id: d.authorization.id, status: d.authorization.status, basis: d.authorization.basis, exclusive: d.authorization.exclusive } : null}
          owner={d.owner ? { name: d.owner.name, phoneMasked: maskPhone(d.owner.phone) } : null}
          checks={ser(d.checks.filter((c) => c.subjectType === "authorization"))}
        />
        <DetailsPanel listingId={d.listing.id} title={d.listing.title} description={d.listing.description} />
      </div>
      <section className="card p-4">
        <p className="section-title">Price history</p>
        <p className="muted">Every change creates a new version; renters' enquiries keep the price they saw.</p>
        <table className="mt-2 w-full text-sm" data-testid="price-history">
          <tbody>
            {d.history.map((h) => (
              <tr key={`${h.planKey}-${h.version}`} className="border-t border-slate-100">
                <td className="py-1">{h.label}</td>
                <td>v{h.version}</td>
                <td>{formatINR(h.basePaise)}</td>
                <td className="text-xs text-slate-500">{h.effectiveFrom.toLocaleString("en-IN")}{h.supersededAt ? " (superseded)" : " (current)"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
