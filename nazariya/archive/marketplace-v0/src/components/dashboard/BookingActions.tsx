"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { decideBookingAction } from "@/app/actions/lister";

export function BookingActions({ id }: { id: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const go = async (d: "confirmed" | "declined") => {
    const r = await decideBookingAction(id, d);
    if (r.ok) router.refresh();
    else setErr(r.error);
  };
  return (
    <span className="flex items-center gap-1">
      <button className="btn-primary px-2 py-1 text-xs" onClick={() => go("confirmed")} data-testid="booking-confirm">Confirm</button>
      <button className="btn-ghost px-2 py-1 text-xs" onClick={() => go("declined")}>Decline</button>
      {err && <span className="text-xs text-rose-600">{err}</span>}
    </span>
  );
}
