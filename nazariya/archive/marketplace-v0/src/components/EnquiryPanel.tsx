"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { submitBookingRequest, submitEnquiry } from "@/app/actions/renter";
import { formatINR } from "@/lib/money";
import type { CostSummary, StayQuote } from "@/lib/pricing";
import { OtpLogin } from "./OtpLogin";

interface PlanOpt {
  planKey: string;
  label: string;
  unitId: string | null;
  summary: CostSummary;
}

export function EnquiryPanel({
  listingId,
  category,
  plans,
  loggedIn,
  isOwner,
  minDate,
}: {
  listingId: string;
  category: string;
  plans: PlanOpt[];
  loggedIn: boolean;
  isOwner: boolean;
  minDate: string;
}) {
  const router = useRouter();
  const [planKey, setPlanKey] = useState(plans[0]?.planKey ?? "");
  const [moveIn, setMoveIn] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [guests, setGuests] = useState(category === "short_stay" ? 2 : 1);
  const [message, setMessage] = useState("");
  const [quote, setQuote] = useState<StayQuote | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const plan = plans.find((p) => p.planKey === planKey);
  const hotel = category === "short_stay";

  useEffect(() => {
    if (!hotel || !from || !to || !plan?.unitId) return setQuote(null);
    const ctrl = new AbortController();
    fetch(`/api/quote?listingId=${listingId}&unitId=${plan.unitId}&from=${from}&to=${to}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => setQuote(d.quote ?? null))
      .catch(() => {});
    return () => ctrl.abort();
  }, [hotel, from, to, plan?.unitId, listingId]);

  if (isOwner) return <p className="muted">This is your listing. Manage it from the dashboard.</p>;
  if (done) {
    return (
      <div className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900" data-testid="enquiry-done">
        <p className="font-semibold">{done}</p>
        <p className="mt-1">The lister has been notified. Track replies and visit slots in <a className="underline" href="/me">My enquiries</a>.</p>
      </div>
    );
  }
  if (needLogin && !loggedIn) {
    return (
      <div>
        <p className="mb-2 text-sm font-semibold text-ink">Verify your number to send the enquiry</p>
        <OtpLogin compact onDone={() => { setNeedLogin(false); router.refresh(); }} />
      </div>
    );
  }

  async function send(kind: "enquiry" | "booking") {
    if (!loggedIn) return setNeedLogin(true);
    setBusy(true);
    setError(null);
    const r =
      kind === "booking"
        ? await submitBookingRequest({ listingId, unitId: plan!.unitId!, from, to, guests })
        : await submitEnquiry({ listingId, planKey, unitId: plan?.unitId, moveInDate: hotel ? null : moveIn || null, stayFrom: hotel ? from : null, stayTo: hotel ? to : null, guests, message });
    setBusy(false);
    if (r.ok) setDone(kind === "booking" ? "Booking request sent" : "Enquiry sent");
    else setError([r.error, ...(r.details ?? [])].join(" · "));
  }

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void send("enquiry"); }} data-testid="enquiry-form">
      <div>
        <label className="label" htmlFor="plan">{hotel ? "Room type" : "Option"}</label>
        <select id="plan" className="input" value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
          {plans.map((p) => (
            <option key={p.planKey} value={p.planKey}>
              {p.label}: {formatINR(p.summary.basePaise)}/{p.summary.period}
            </option>
          ))}
        </select>
      </div>
      {hotel ? (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="from">Check-in</label>
            <input id="from" type="date" className="input" min={minDate} value={from} onChange={(e) => setFrom(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="to">Check-out</label>
            <input id="to" type="date" className="input" min={from || minDate} value={to} onChange={(e) => setTo(e.target.value)} required />
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="guests">Guests</label>
            <input id="guests" type="number" min={1} max={6} className="input" value={guests} onChange={(e) => setGuests(Number(e.target.value))} />
          </div>
          {quote && (
            <div className="col-span-2 rounded-xl bg-slate-50 p-3 text-sm" data-testid="stay-quote">
              {quote.available ? (
                <>
                  <div className="flex justify-between"><span>{quote.nights} night{quote.nights > 1 ? "s" : ""}</span><span>{formatINR(quote.roomSubtotalPaise)}</span></div>
                  <div className="flex justify-between text-slate-600"><span>Taxes (as charged by hotel)</span><span>{formatINR(quote.taxPaise)}</span></div>
                  <div className="mt-1 flex justify-between font-bold"><span>Total</span><span data-testid="stay-total">{formatINR(quote.totalPaise)}</span></div>
                </>
              ) : (
                <p className="text-rose-700" data-testid="stay-unavailable">{quote.reason}</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="movein">Move-in date</label>
          <input id="movein" type="date" className="input" min={minDate} value={moveIn} onChange={(e) => setMoveIn(e.target.value)} />
        </div>
      )}
      <div>
        <label className="label" htmlFor="msg">Message (optional)</label>
        <textarea id="msg" className="input min-h-20" maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={hotel ? "Arrival time, special requests…" : "Tell the lister about yourself and when you can visit"} />
      </div>
      {error && <p className="text-sm text-rose-600" role="alert" data-testid="enquiry-error">{error}</p>}
      {hotel ? (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="btn-primary" disabled={busy || !quote?.available} onClick={() => send("booking")} data-testid="booking-submit">Request booking</button>
          <button type="submit" className="btn-secondary" disabled={busy || !from || !to}>Ask a question</button>
        </div>
      ) : (
        <button type="submit" className="btn-primary w-full" disabled={busy} data-testid="enquiry-submit">{busy ? "Sending…" : "Send enquiry"}</button>
      )}
      <p className="text-xs text-slate-500">The price shown now is saved with your enquiry. Pay nothing in advance before you visit.</p>
    </form>
  );
}
