"use client";
import { useState } from "react";
import { changeVisit, saveOutcome, sendMessage } from "@/app/actions/renter";
import { proposeVisitsAction } from "@/app/actions/lister";
import { formatINR } from "@/lib/money";

interface Props {
  role: "renter" | "lister" | "admin";
  enquiry: { id: string; status: string; moveInDate: string | null; stayFrom: string | null; stayTo: string | null; guests: number; createdAt: string; priceSnapshot: { capturedAt: string; plan: { label: string; basePaise: number; period: string; moveInPaise: number; brokeragePaise: number | null; depositPaise: number | null } } };
  listing: { title: string; slug: string };
  messages: { id: string; senderRole: string; body: string; createdAt: string }[];
  visits: { id: string; mode: string; slotStart: string; status: string }[];
  outcome: { outcome: string } | null;
  counterpart: string;
}

const when = (s: string) => new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

export function EnquiryThread(p: Props) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [slots, setSlots] = useState<{ start: string; mode: "in_person" | "video" }[]>([{ start: "", mode: "in_person" }]);
  const snap = p.enquiry.priceSnapshot.plan;
  const run = async (f: () => Promise<{ ok: boolean; error?: string; details?: string[] }>) => {
    setErr(null);
    const r = await f();
    if (!r.ok) setErr([r.error, ...(r.details ?? [])].join(" · "));
    return r.ok;
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]" data-testid="enquiry-thread">
      <div className="card flex flex-col p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <a href={`/l/${p.listing.slug}`} className="font-semibold text-nazar underline">{p.listing.title}</a>
            <p className="text-xs text-slate-500">With {p.counterpart} · status <b data-testid="enquiry-status">{p.enquiry.status.replace(/_/g, " ")}</b></p>
          </div>
        </div>
        <ol className="flex-1 space-y-2" data-testid="messages">
          {p.messages.map((m) => (
            <li key={m.id} className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${m.senderRole === "system" ? "mx-auto bg-slate-100 text-center text-xs text-slate-500" : m.senderRole === p.role ? "ml-auto bg-nazar text-white" : "bg-slate-100 text-ink"}`}>
              {m.body}
              <div className={`mt-0.5 text-[10px] ${m.senderRole === p.role ? "text-white/70" : "text-slate-400"}`}>{when(m.createdAt)}</div>
            </li>
          ))}
        </ol>
        {p.role !== "admin" && (
          <form
            className="mt-3 flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run(() => sendMessage(p.enquiry.id, text))) setText("");
            }}
          >
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a message…" aria-label="Message" data-testid="message-input" />
            <button className="btn-primary" type="submit" data-testid="message-send">Send</button>
          </form>
        )}
        {err && <p className="mt-2 text-sm text-rose-600" role="alert">{err}</p>}
      </div>
      <div className="space-y-4">
        <div className="card p-4 text-sm">
          <p className="section-title text-base">Price snapshot</p>
          <p className="muted">Saved {when(p.enquiry.priceSnapshot.capturedAt)}. This is what was shown when the enquiry was sent.</p>
          <dl className="mt-2 space-y-1">
            <div className="flex justify-between"><dt>{snap.label}</dt><dd className="font-semibold">{formatINR(snap.basePaise)}/{snap.period}</dd></div>
            {snap.depositPaise != null && <div className="flex justify-between"><dt>Deposit</dt><dd>{formatINR(snap.depositPaise)}</dd></div>}
            {snap.brokeragePaise != null && <div className="flex justify-between"><dt>Brokerage</dt><dd data-testid="snapshot-brokerage">{snap.brokeragePaise ? formatINR(snap.brokeragePaise) : "None"}</dd></div>}
            {snap.period === "month" && <div className="flex justify-between font-semibold"><dt>To move in</dt><dd>{formatINR(snap.moveInPaise)}</dd></div>}
          </dl>
          {p.enquiry.moveInDate && <p className="mt-2 text-xs text-slate-500">Move-in: {p.enquiry.moveInDate}</p>}
          {p.enquiry.stayFrom && <p className="mt-2 text-xs text-slate-500">Stay: {p.enquiry.stayFrom} → {p.enquiry.stayTo} · {p.enquiry.guests} guest(s)</p>}
        </div>
        <div className="card p-4 text-sm" data-testid="visits">
          <p className="section-title text-base">Visits</p>
          {!p.visits.length && <p className="muted">No visit slots yet.</p>}
          <ul className="mt-2 space-y-2">
            {p.visits.map((v) => (
              <li key={v.id} className="rounded-lg border border-slate-200 p-2">
                <div className="flex justify-between gap-2">
                  <span>{when(v.slotStart)} · {v.mode === "video" ? "Video call" : "In person"}</span>
                  <b className="capitalize" data-testid="visit-status">{v.status.replace(/_/g, " ")}</b>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {p.role === "renter" && v.status === "proposed" && <button className="btn-primary px-2 py-1 text-xs" onClick={() => run(() => changeVisit(v.id, "confirmed", p.enquiry.id))} data-testid="visit-confirm">Confirm this slot</button>}
                  {v.status === "confirmed" && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => run(() => changeVisit(v.id, "completed", p.enquiry.id))}>Mark visited</button>}
                  {v.status === "confirmed" && p.role === "lister" && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => run(() => changeVisit(v.id, "no_show_renter", p.enquiry.id))}>Renter didn&apos;t come</button>}
                  {v.status === "confirmed" && p.role === "renter" && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => run(() => changeVisit(v.id, "no_show_lister", p.enquiry.id))}>Lister didn&apos;t come</button>}
                  {["proposed", "confirmed"].includes(v.status) && p.role !== "admin" && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => run(() => changeVisit(v.id, "cancelled", p.enquiry.id))}>Cancel</button>}
                </div>
              </li>
            ))}
          </ul>
          {p.role === "lister" && (
            <form
              className="mt-3 space-y-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const valid = slots.filter((s) => s.start).map((s) => ({ ...s, start: new Date(s.start).toISOString() }));
                if (await run(() => proposeVisitsAction(p.enquiry.id, valid))) setSlots([{ start: "", mode: "in_person" }]);
              }}
            >
              <p className="label">Propose slots</p>
              {slots.map((s, i) => (
                <div key={i} className="flex gap-1">
                  <input type="datetime-local" className="input" value={s.start} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} aria-label="Slot time" data-testid="slot-input" />
                  <select className="input w-28" value={s.mode} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, mode: e.target.value as "in_person" | "video" } : x)))} aria-label="Mode">
                    <option value="in_person">Visit</option>
                    <option value="video">Video</option>
                  </select>
                </div>
              ))}
              <div className="flex gap-2">
                <button type="button" className="btn-ghost text-xs" onClick={() => setSlots([...slots, { start: "", mode: "in_person" }])}>+ slot</button>
                <button type="submit" className="btn-secondary text-xs" data-testid="slots-submit">Send slots</button>
              </div>
            </form>
          )}
        </div>
        {p.role !== "admin" && (
          <div className="card p-4 text-sm">
            <p className="section-title text-base">Outcome</p>
            {p.outcome ? (
              <p className="mt-1" data-testid="outcome">Recorded: <b>{p.outcome.outcome.replace(/_/g, " ")}</b></p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1">
                {(p.role === "renter"
                  ? [["rented_here", "I took it"], ["rented_elsewhere", "Found elsewhere"], ["listing_unavailable", "It wasn't available"], ["misleading", "Not as shown"]]
                  : [["rented_here", "Rented to this renter"], ["not_rented", "Didn't work out"]]
                ).map(([k, label]) => (
                  <button key={k} className="btn-secondary px-2 py-1 text-xs" onClick={() => run(() => saveOutcome(p.enquiry.id, { outcome: k as "rented_here" }))}>{label}</button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
