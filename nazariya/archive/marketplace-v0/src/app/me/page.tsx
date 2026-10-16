import Link from "next/link";
import { formatINR } from "@/lib/money";
import { renterBookings, renterEnquiries } from "@/server/enquiries";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function MePage() {
  const user = await requireUser("/me");
  const [enqs, books] = await Promise.all([renterEnquiries(user), renterBookings(user)]);
  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <h1 className="text-2xl font-extrabold">My enquiries</h1>
      <p className="muted">{user.phone}</p>
      <ul className="mt-4 space-y-2" data-testid="my-enquiries">
        {enqs.map(({ enquiry, listing }) => (
          <li key={enquiry.id}>
            <Link href={`/me/enquiries/${enquiry.id}`} className="card flex items-center justify-between gap-3 p-4 hover:bg-slate-50">
              <div>
                <p className="font-semibold">{listing.title}</p>
                <p className="text-xs text-slate-500">Sent {enquiry.createdAt.toLocaleDateString("en-IN")} · {(enquiry.priceSnapshot as { plan: { label: string } }).plan.label}</p>
              </div>
              <span className="chip bg-slate-100 capitalize">{enquiry.status.replace(/_/g, " ")}</span>
            </Link>
          </li>
        ))}
        {!enqs.length && <li className="muted">No enquiries yet. <Link className="text-nazar underline" href="/search">Explore listings</Link></li>}
      </ul>
      {books.length > 0 && (
        <>
          <h2 className="mt-8 text-xl font-bold">Hotel booking requests</h2>
          <ul className="mt-3 space-y-2" data-testid="my-bookings">
            {books.map(({ booking, listing, unit }) => (
              <li key={booking.id} className="card flex justify-between gap-3 p-4 text-sm">
                <div>
                  <p className="font-semibold">{listing.title}</p>
                  <p className="text-slate-500">{unit.label} · {booking.stayFrom} → {booking.stayTo} · {formatINR((booking.quote as { totalPaise: number }).totalPaise)}</p>
                </div>
                <span className="chip bg-slate-100 capitalize">{booking.status}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
