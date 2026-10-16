import Link from "next/link";
import { OnboardingForm } from "@/components/dashboard/OnboardingForm";
import { ReconfirmButton } from "@/components/dashboard/ListingRowActions";
import { deriveBadges } from "@/lib/badges";
import { CATEGORY_LABEL } from "@/lib/catalog";
import { relativeAge } from "@/lib/freshness";
import { listerInbox } from "@/server/enquiries";
import { allLocalities, listerOverview } from "@/server/listings";
import { requireUser } from "@/server/session";
import { checksFor } from "@/server/trust";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  published: "bg-emerald-50 text-emerald-800",
  draft: "bg-slate-100 text-slate-700",
  stale: "bg-amber-50 text-amber-800",
  expired: "bg-rose-50 text-rose-700",
  paused: "bg-amber-50 text-amber-800",
  suspended: "bg-rose-100 text-rose-800",
  closed: "bg-slate-100 text-slate-500",
};

export default async function Dashboard() {
  const user = await requireUser("/dashboard");
  if (!user.orgs.length) {
    return (
      <div className="mx-auto max-w-lg px-4 py-10">
        <h1 className="text-2xl font-extrabold">List on Nazariya</h1>
        <p className="muted mb-5 mt-1">Set up your lister profile. You can verify your identity right after.</p>
        <OnboardingForm localities={await allLocalities()} />
      </div>
    );
  }
  const [{ listings, properties }, inbox, myChecks] = await Promise.all([listerOverview(user), listerInbox(user), checksFor("user", [user.id])]);
  const idBadge = deriveBadges(myChecks).find((b) => b.key === "id_checked_broker")!;
  const newEnq = inbox.filter((i) => i.enquiry.status === "new").length;
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">{user.orgs[0].displayName}</h1>
          <p className="muted">Lister dashboard</p>
        </div>
        <div className="flex gap-2">
          <Link className="btn-secondary" href="/dashboard/enquiries">Enquiries {newEnq ? <span className="chip bg-saffron text-white">{newEnq} new</span> : null}</Link>
          <Link className="btn-primary" href="/dashboard/properties/new" data-testid="add-property">+ Add property</Link>
        </div>
      </div>
      {!idBadge.earned && (
        <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900" data-testid="kyc-nudge">
          Verify your identity to earn the <b>ID-checked lister</b> badge. Listings with badges rank higher. <Link className="font-semibold underline" href="/dashboard/verification">Verify now →</Link>
        </div>
      )}
      <section className="mt-6">
        <h2 className="section-title">Listings</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-testid="listings-table">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr><th className="p-2">Listing</th><th className="p-2">Status</th><th className="p-2">Availability</th><th className="p-2" /></tr>
            </thead>
            <tbody>
              {listings.map(({ listing: l, locality, freshness }) => (
                <tr key={l.id} className="border-t border-slate-200">
                  <td className="p-2">
                    <Link className="font-semibold text-ink hover:underline" href={`/dashboard/listings/${l.id}`}>{l.title}</Link>
                    <div className="text-xs text-slate-500">{CATEGORY_LABEL[l.category]} · {locality.name}</div>
                  </td>
                  <td className="p-2"><span className={`chip ${STATUS_TONE[l.status] ?? "bg-slate-100"}`} data-testid="listing-status">{l.status}</span></td>
                  <td className="p-2 text-xs">
                    {l.lastConfirmedAt ? `Confirmed ${relativeAge(l.lastConfirmedAt)}` : "Not confirmed"}
                    {freshness === "due_soon" && <span className="ml-1 text-amber-700">· due soon</span>}
                  </td>
                  <td className="p-2 text-right">
                    {["published", "stale", "paused"].includes(l.status) && <ReconfirmButton listingId={l.id} />}
                    <Link className="btn-ghost px-2 py-1 text-xs" href={`/dashboard/listings/${l.id}`}>Manage</Link>
                    {["published", "stale"].includes(l.status) && <Link className="btn-ghost px-2 py-1 text-xs" href={`/l/${l.slug}`}>View</Link>}
                  </td>
                </tr>
              ))}
              {!listings.length && <tr><td className="p-4 text-slate-500" colSpan={4}>No listings yet. Add a property, then create a listing for it.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="mt-8">
        <h2 className="section-title">Properties</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {properties.map(({ property: p, locality }) => (
            <div key={p.id} className="card p-4 text-sm">
              <p className="font-semibold">{p.name ?? p.addressLine}</p>
              <p className="text-slate-500">{locality.name} · {p.category}</p>
              <Link className="btn-secondary mt-3 px-3 py-1.5 text-xs" href={`/dashboard/listings/new?propertyId=${p.id}`} data-testid="create-listing-link">Create listing</Link>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
