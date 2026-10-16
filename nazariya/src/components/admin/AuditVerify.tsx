"use client";
import { useState } from "react";
import { verifyAuditAction } from "@/app/actions/studio";

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
