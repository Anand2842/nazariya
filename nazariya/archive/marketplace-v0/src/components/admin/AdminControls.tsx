"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { decideCaseAction, decideCheckAction, freshnessAction, verifyAuditAction } from "@/app/actions/admin";

export function CheckDecision({ checkId }: { checkId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async (d: "passed" | "failed") => {
    const r = await decideCheckAction(checkId, d, reason);
    if (r.ok) router.refresh();
    else setErr(r.error);
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      <input className="input w-48 py-1.5 text-xs" placeholder="Reason / note" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
      <button className="btn-primary px-2 py-1 text-xs" onClick={() => go("passed")} data-testid="check-approve">Approve</button>
      <button className="btn-danger px-2 py-1 text-xs" onClick={() => go("failed")}>Reject</button>
      {err && <span className="text-xs text-rose-600">{err}</span>}
    </div>
  );
}

export function CaseDecision({ caseId, kind }: { caseId: string; kind: string }) {
  const router = useRouter();
  const [rationale, setRationale] = useState("");
  const [decision, setDecision] = useState(kind === "duplicate" ? "suspend_listing" : "no_action");
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-1"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await decideCaseAction(caseId, decision as "no_action", rationale);
        if (r.ok) router.refresh();
        else setErr(r.error);
      }}
    >
      <select className="input w-52 py-1.5 text-xs" value={decision} onChange={(e) => setDecision(e.target.value)} aria-label="Decision">
        <option value="no_action">No action</option>
        <option value="edit_required">Edit required</option>
        <option value="suspend_listing">Suspend listing</option>
        <option value="restore_listing">Restore listing</option>
        {kind === "duplicate" && <option value="link_same_property">Same property (link)</option>}
        {kind === "duplicate" && <option value="mark_different">Different properties</option>}
      </select>
      <input className="input w-60 py-1.5 text-xs" placeholder="Rationale (shown to the lister)" value={rationale} onChange={(e) => setRationale(e.target.value)} required aria-label="Rationale" />
      <button className="btn-secondary px-2 py-1 text-xs" type="submit" data-testid="case-decide">Decide</button>
      {err && <span className="text-xs text-rose-600">{err}</span>}
    </form>
  );
}

export function AuditVerify() {
  const [res, setRes] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <button
        className="btn-secondary px-3 py-1.5 text-xs"
        data-testid="audit-verify"
        onClick={async () => {
          const r = await verifyAuditAction();
          const d = r.ok ? (r.data as { ok: boolean; checked: number; brokenAtId?: number; reason?: string }) : null;
          setRes(d ? (d.ok ? `✓ Chain intact (${d.checked} events)` : `✗ Broken at #${d.brokenAtId}: ${d.reason}`) : r.ok ? "" : r.error);
        }}
      >
        Verify audit chain
      </button>
      {res && <span className="text-xs" data-testid="audit-result">{res}</span>}
    </span>
  );
}

export function FreshnessRun() {
  const router = useRouter();
  const [res, setRes] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <button className="btn-secondary px-3 py-1.5 text-xs" onClick={async () => { const r = await freshnessAction(); setRes(r.ok ? `${(r.data as unknown[]).length} change(s)` : r.error); router.refresh(); }}>Run freshness sweep</button>
      {res && <span className="text-xs">{res}</span>}
    </span>
  );
}
