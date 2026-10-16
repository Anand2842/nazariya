"use client";
import { useState } from "react";
import { reconfirmAction } from "@/app/actions/lister";

export function ReconfirmButton({ listingId, label = "Still available ✓" }: { listingId: string; label?: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | string>("idle");
  if (state === "done") return <span className="text-xs text-emerald-700" data-testid="reconfirm-done">Confirmed</span>;
  return (
    <span>
      <button
        type="button"
        className="btn-secondary px-2.5 py-1 text-xs"
        disabled={state === "busy"}
        data-testid="reconfirm"
        onClick={async () => {
          setState("busy");
          const r = await reconfirmAction(listingId);
          setState(r.ok ? "done" : r.error);
        }}
      >
        {label}
      </button>
      {state !== "idle" && state !== "busy" && state !== "done" && <span className="ml-1 text-xs text-rose-600">{state}</span>}
    </span>
  );
}
