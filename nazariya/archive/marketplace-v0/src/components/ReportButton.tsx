"use client";
import { useState } from "react";
import { submitReport } from "@/app/actions/renter";
import { REPORT_REASONS } from "@/lib/catalog";

export function ReportButton({ listingId }: { listingId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("not_available");
  const [details, setDetails] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | string>("idle");
  if (state === "done") return <p className="text-sm text-emerald-700" data-testid="report-done">Thanks. Our team will review this report.</p>;
  return (
    <div>
      <button type="button" className="text-sm text-slate-500 underline" onClick={() => setOpen(!open)} data-testid="report-open">Report this listing</button>
      {open && (
        <form
          className="mt-2 space-y-2 rounded-xl border border-slate-200 p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setState("busy");
            const r = await submitReport(listingId, reason, details);
            setState(r.ok ? "done" : r.error);
          }}
        >
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
            {Object.entries(REPORT_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <textarea className="input" placeholder="What happened? (optional)" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} />
          <button className="btn-secondary" disabled={state === "busy"} type="submit" data-testid="report-submit">Submit report</button>
          {state !== "idle" && state !== "busy" && <p className="text-sm text-rose-600">{state}</p>}
        </form>
      )}
    </div>
  );
}
