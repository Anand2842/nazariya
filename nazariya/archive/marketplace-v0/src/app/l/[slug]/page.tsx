import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EnquiryPanel } from "@/components/EnquiryPanel";
import { FreshnessPill } from "@/components/FreshnessPill";
import { PriceBlock } from "@/components/PriceBlock";
import { ReportButton } from "@/components/ReportButton";
import { ShortlistButton } from "@/components/ShortlistButton";
import { TourViewer } from "@/components/tour/TourViewer";
import type { Tier } from "@/components/tour/types";
import { TrustBadges } from "@/components/TrustBadges";
import { sharingLabel, todayIST } from "@/lib/availability";
import { AMENITIES, CATEGORY_LABEL, FURNISHING, GENDER_POLICY } from "@/lib/catalog";
import { formatINR } from "@/lib/money";
import { getListingView } from "@/server/listings";
import { getCurrentUser } from "@/server/session";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const v = await getListingView(slug, null);
  if (!v || v.unavailable) return { title: "Listing not available" };
  const p = v.plans[0]?.summary;
  const desc = `${CATEGORY_LABEL[v.listing.category]} in ${v.locality.name}${p ? ` from ${formatINR(p.basePaise)}/${p.period}` : ""}. ${v.tour.length} room tour.`;
  return {
    title: v.listing.title,
    description: desc,
    openGraph: { title: v.listing.title, description: desc, images: v.poster?.poster ?? v.poster?.full ? [{ url: (v.poster?.poster ?? v.poster?.full)! }] : [] },
  };
}

function fmtDate(d: string) {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

export default async function ListingPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const user = await getCurrentUser();
  const v = await getListingView(slug, user);
  if (!v) notFound();
  if (v.unavailable) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center" data-testid="listing-unavailable">
        <h1 className="text-2xl font-bold">This listing is no longer available</h1>
        <p className="mt-2 text-slate-600">It may have been rented out, expired after its availability wasn&apos;t confirmed, or been paused for review.</p>
        <Link className="btn-primary mt-6" href="/search">Find similar places</Link>
      </div>
    );
  }
  const { listing: l, property: p, locality } = v;
  const rules = p.houseRules as Record<string, string | number>;
  const terms = l.terms as Record<string, string | number>;
  const hotel = l.category === "short_stay";
  const first = v.plans[0]?.summary;
  const zones = v.tour.map((z) => ({ ...z, startYaw: z.startYaw ?? 0 }));
  const posterUrl = v.poster?.poster ?? v.poster?.full ?? zones.find((z) => z.pano?.poster)?.pano?.poster ?? null;
  const today = todayIST();
  const tierParam = (["3d", "360", "photos"].includes(sp.tier ?? "") ? sp.tier : null) as Tier | null;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-28 pt-5 lg:pb-10">
      {l.status !== "published" && (
        <div className={`mb-4 rounded-xl px-4 py-3 text-sm ${l.status === "stale" ? "bg-amber-50 text-amber-900" : "bg-slate-100 text-slate-700"}`} data-testid="status-banner">
          {l.status === "stale"
            ? "The lister hasn't confirmed availability recently, so this listing is hidden from search. Ask before visiting."
            : `Preview: this listing is ${l.status}. Only you can see it.`}
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-nazar">
            {CATEGORY_LABEL[l.category]} · {locality.name}
            {locality.nearestMetro ? ` · near ${locality.nearestMetro} metro` : ""}
          </p>
          <h1 className="mt-1 text-2xl font-extrabold leading-tight text-ink sm:text-3xl" data-testid="listing-title">{l.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <FreshnessPill state={v.freshness} lastConfirmedAt={l.lastConfirmedAt} by={l.lastConfirmedBy} />
            {rules.gender && <span className="chip bg-slate-100 text-slate-700">{GENDER_POLICY[String(rules.gender)] ?? rules.gender}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ShortlistButton id={l.id} />
          <a className="btn-secondary" href={`https://wa.me/?text=${encodeURIComponent(`${l.title} on Nazariya: ${(process.env.APP_URL ?? "") + "/l/" + l.slug}`)}`} target="_blank" rel="noreferrer">Share</a>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-6">
          <TourViewer listingId={l.id} zones={zones} posterUrl={posterUrl} initialZoneId={sp.zone ?? null} forceTier={tierParam} />

          <section className="card p-4">
            <h2 className="section-title">Trust & verification</h2>
            <div className="mt-3">
              <TrustBadges badges={v.badges} showMissing />
            </div>
            <p className="mt-3 text-xs text-slate-500">Listed by <b className="text-ink">{v.lister.name}</b> ({v.org.displayName}){v.lister.activeSince ? `, on Nazariya since ${new Date(v.lister.activeSince).toLocaleDateString("en-IN", { month: "short", year: "numeric" })}` : ""}.</p>
          </section>

          {v.pg.length > 0 && (
            <section className="card p-4" id="availability" data-testid="pg-availability">
              <h2 className="section-title">Bed availability</h2>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {v.pg.map((s) => (
                  <div key={s.sharing} className="rounded-xl bg-slate-50 p-3">
                    <p className="font-semibold">{sharingLabel(s.sharing)} sharing</p>
                    <p className="text-sm text-slate-600">
                      {s.availableNow > 0
                        ? `${s.availableNow} bed${s.availableNow > 1 ? "s" : ""} available now`
                        : s.earliestFrom
                          ? `Next bed from ${fmtDate(s.earliestFrom)}`
                          : "Full"}
                    </p>
                    <p className="text-xs text-slate-400">{s.bedsTotal} bed{s.bedsTotal > 1 ? "s" : ""} in total</p>
                  </div>
                ))}
              </div>
              <ul className="mt-3 space-y-1 text-sm text-slate-600">
                {v.rooms.map((r) => (
                  <li key={r.unitId}>
                    <b className="text-ink">{r.label}</b>: {r.beds.map((b) => `Bed ${("label" in b ? (b as { label: string }).label : "")} ${b.status === "notice" ? `(free from ${fmtDate(String(b.noticeUntil))})` : b.status === "reserved" ? "(reserved)" : `(${b.status})`}`).join(", ")}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!hotel && v.pg.length === 0 && (
            <section className="card p-4" id="availability">
              <h2 className="section-title">Availability & lease</h2>
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                {v.availability.map((a) => (
                  <li key={a.unitId} data-testid="unit-availability">
                    <b>{a.label}</b>: {a.latest ? (a.latest.status === "available" ? `available from ${fmtDate(a.latest.availableFrom)}` : a.latest.status.replace("_", " ")) : "date not set"}
                  </li>
                ))}
                {terms.minLeaseMonths && <li>Minimum lease: {terms.minLeaseMonths} months</li>}
                {terms.lockInMonths && <li>Lock-in: {terms.lockInMonths} months</li>}
                {terms.noticeMonths && <li>Notice period: {terms.noticeMonths} month(s)</li>}
                {terms.agreement && <li>Agreement: {terms.agreement}</li>}
                {terms.escalation && <li>Rent escalation: {terms.escalation}</li>}
              </ul>
            </section>
          )}

          {hotel && (
            <section className="card p-4" data-testid="hotel-calendar">
              <h2 className="section-title">Rooms & next 14 nights</h2>
              <div className="mt-3 space-y-3">
                {v.units.map((u) => {
                  const nights = v.nightly.filter((n) => n.unitId === u.id).slice(0, 14);
                  return (
                    <div key={u.id}>
                      <p className="text-sm font-semibold">{u.label} · up to {u.maxOccupancy} guests{u.declaredAreaSqft ? ` · ${u.declaredAreaSqft} sq ft (as declared)` : ""}</p>
                      <div className="mt-1 flex gap-1 overflow-x-auto pb-1">
                        {nights.map((n) => (
                          <div key={n.date} className={`w-14 shrink-0 rounded-lg p-1 text-center text-[11px] ${n.availableCount > 0 ? "bg-emerald-50 text-emerald-900" : "bg-rose-50 text-rose-700"}`}>
                            <div>{fmtDate(n.date)}</div>
                            <div className="font-semibold">{n.availableCount > 0 ? formatINR(n.ratePaise) : "Sold out"}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-slate-500">Check-in {String(rules.checkIn ?? terms.checkIn ?? "12:00")} · Check-out {String(rules.checkOut ?? terms.checkOut ?? "11:00")} · {String(rules.cancellation ?? terms.cancellation ?? "")}</p>
            </section>
          )}

          <section className="card p-4">
            <h2 className="section-title">About this place</h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-700">{l.description}</p>
            {!hotel && v.units.length > 0 && (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {v.units.map((u) => (
                  <div key={u.id} className="rounded-xl bg-slate-50 p-3 text-sm">
                    <p className="font-semibold">{u.label}</p>
                    <p className="text-slate-600">
                      {[
                        u.bhk ? `${u.bhk} BHK` : null,
                        u.sharingCapacity ? `${sharingLabel(u.sharingCapacity)} sharing` : null,
                        u.bathrooms ? `${u.bathrooms} bath` : null,
                        u.attachedBath === true ? "attached bath" : u.attachedBath === false ? "shared bath" : null,
                        u.ac === true ? "AC" : u.ac === false ? "non-AC" : null,
                        u.furnishing ? FURNISHING[u.furnishing] : null,
                        u.floor != null ? `floor ${u.floor}` : null,
                        u.declaredAreaSqft ? `${u.declaredAreaSqft} sq ft (as declared)` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                ))}
              </div>
            )}
            {p.amenities.length > 0 && (
              <div className="mt-4">
                <p className="label">Amenities</p>
                <div className="flex flex-wrap gap-1.5">
                  {[...new Set([...p.amenities, ...v.units.flatMap((u) => u.amenities)])].map((a) => (
                    <span key={a} className="chip bg-nazar-light/50 text-nazar-dark">{AMENITIES[a] ?? a}</span>
                  ))}
                </div>
              </div>
            )}
            {Object.keys(rules).length > 0 && (
              <div className="mt-4">
                <p className="label">House rules & policies (as stated by the lister)</p>
                <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                  {Object.entries(rules).map(([k, val]) => (
                    <div key={k} className="flex justify-between gap-2 border-b border-slate-100 py-1">
                      <dt className="capitalize text-slate-500">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
                      <dd className="text-right text-ink">{k === "gender" ? GENDER_POLICY[String(val)] ?? String(val) : String(val)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            <p className="mt-4 text-xs text-slate-500">
              Location: {locality.name}, {p.city}{p.pincode ? ` ${p.pincode}` : ""}. The exact address is shared by the lister after you enquire.
            </p>
          </section>

          {v.otherListers.length > 0 && (
            <section className="card p-4" data-testid="other-listers">
              <h2 className="section-title">Also offered by {v.otherListers.length} other authorised lister{v.otherListers.length > 1 ? "s" : ""}</h2>
              <p className="muted mt-1">Same property, different lister. Compare brokerage before you choose.</p>
              <ul className="mt-2 space-y-1 text-sm">
                {v.otherListers.map((o) => (
                  <li key={o.id} className="flex justify-between gap-2">
                    <Link className="text-nazar underline" href={`/l/${o.slug}`}>{o.orgName}</Link>
                    <span>{o.plans[0] ? `Brokerage: ${o.plans[0].summary.brokeragePaise ? formatINR(o.plans[0].summary.brokeragePaise) : "none"}` : ""}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <ReportButton listingId={l.id} />
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start" id="enquire">
          <section className="card space-y-4 p-4" data-testid="price-panel">
            <h2 className="section-title">{hotel ? "Room rates" : "Rent & charges"}</h2>
            {v.plans.map((pl) => (
              <PriceBlock key={pl.plan.id} summary={pl.summary} />
            ))}
          </section>
          <section className="card p-4">
            <h2 className="section-title mb-3">{hotel ? "Check availability" : "Enquire or book a visit"}</h2>
            {l.status === "published" ? (
              <EnquiryPanel
                listingId={l.id}
                category={l.category}
                plans={v.plans.map((x) => ({ planKey: x.plan.planKey, label: x.plan.label, unitId: x.plan.unitId, summary: x.summary }))}
                loggedIn={!!user}
                isOwner={v.isOwner}
                minDate={today}
              />
            ) : (
              <p className="muted">Enquiries are paused until the lister confirms availability.</p>
            )}
          </section>
        </aside>
      </div>

      {first && (
        <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-slate-200 bg-white px-4 py-3 lg:hidden" data-testid="mobile-cta">
          <div>
            <p className="text-lg font-extrabold leading-none text-ink">{formatINR(first.basePaise)}<span className="text-sm font-normal text-slate-500">/{first.period}</span></p>
            {first.period === "month" && <p className="text-xs text-slate-500">Brokerage: {first.brokeragePaise ? formatINR(first.brokeragePaise) : "none"} · Deposit {first.depositPaise != null ? formatINR(first.depositPaise) : "n/a"}</p>}
          </div>
          <a href="#enquire" className="btn-primary">{hotel ? "Check dates" : "Enquire"}</a>
        </div>
      )}
    </div>
  );
}
