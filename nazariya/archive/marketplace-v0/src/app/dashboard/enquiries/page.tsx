import Link from "next/link";
import { BookingActions } from "@/components/dashboard/BookingActions";
import { formatINR } from "@/lib/money";
import { relativeAge } from "@/lib/freshness";
import { listerBookings, listerInbox } from "@/server/enquiries";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function Inbox() {
  const user = await requireUser("/dashboard/enquiries");
  const [items, books] = await Promise.all([listerInbox(user), listerBookings(user)]);
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-2xl font-extrabold">Enquiries</h1>
      <ul className="mt-4 space-y-2" data-testid="inbox">
        {items.map(({ enquiry: e, listing, renterName }) => (
          <li key={e.id}>
            <Link href={`/dashboard/enquiries/${e.id}`} className="card flex items-center justify-between gap-3 p-4 hover:bg-slate-50">
              <div>
                <p className="font-semibold">{renterName ?? "Renter"} · {listing.title}</p>
                <p className="text-xs text-slate-500">{relativeAge(e.createdAt)} · {(e.priceSnapshot as { plan: { label: string } }).plan.label}{e.moveInDate ? ` · move-in ${e.moveInDate}` : ""}{e.stayFrom ? ` · ${e.stayFrom} → ${e.stayTo}` : ""}</p>
              </div>
              <span className={`chip capitalize ${e.status === "new" ? "bg-saffron text-white" : "bg-slate-100"}`}>{e.status.replace(/_/g, " ")}</span>
            </Link>
          </li>
        ))}
        {!items.length && <li className="muted">No enquiries yet.</li>}
      </ul>
      {books.length > 0 && (
        <>
          <h2 className="mt-8 text-xl font-bold">Booking requests</h2>
          <ul className="mt-3 space-y-2" data-testid="booking-requests">
            {books.map(({ booking: b, listing, unit, renterName }) => (
              <li key={b.id} className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                <div>
                  <p className="font-semibold">{renterName ?? "Guest"} · {unit.label}</p>
                  <p className="text-slate-500">{listing.title} · {b.stayFrom} → {b.stayTo} · {b.guests} guest(s) · {formatINR((b.quote as { totalPaise: number }).totalPaise)}</p>
                </div>
                {b.status === "requested" ? <BookingActions id={b.id} /> : <span className="chip bg-slate-100 capitalize" data-testid="booking-status">{b.status}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
