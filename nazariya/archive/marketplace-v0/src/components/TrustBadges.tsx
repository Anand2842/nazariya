"use client";
import { useState } from "react";
import type { DerivedBadge } from "@/lib/badges";

const ICON: Record<string, string> = { id_checked_broker: "🪪", owner_authorised: "🏠", onsite_media: "📍", charges_disclosed: "₹" };

/** Earned badges are tappable and explain what was checked AND what was not. Missing checks are listed neutrally. */
export function TrustBadges({ badges, showMissing = false }: { badges: DerivedBadge[]; showMissing?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const earned = badges.filter((b) => b.earned);
  const missing = badges.filter((b) => !b.earned);
  return (
    <div data-testid="trust-badges">
      <div className="flex flex-wrap gap-2">
        {earned.map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => setOpen(open === b.key ? null : b.key)}
            className="chip border border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100"
            data-testid={`badge-${b.key}`}
            aria-expanded={open === b.key}
          >
            <span aria-hidden>{ICON[b.key]}</span> {b.label}
          </button>
        ))}
        {!earned.length && <span className="chip bg-slate-100 text-slate-600">No verification badges yet</span>}
      </div>
      {open && (() => {
        const b = earned.find((x) => x.key === open)!;
        return (
          <div className="mt-2 rounded-xl border border-emerald-200 bg-white p-3 text-sm" role="note">
            <p className="font-semibold text-ink">{b.label}</p>
            <p className="mt-1 text-slate-700"><span className="font-medium">Checked:</span> {b.checked}</p>
            <p className="mt-1 text-slate-700"><span className="font-medium">Not checked:</span> {b.notChecked}</p>
            <p className="mt-1 text-xs text-slate-500">
              {b.verifiedAt && <>Verified {new Date(b.verifiedAt).toLocaleDateString("en-IN")}. </>}
              {b.validUntil && <>Valid until {new Date(b.validUntil).toLocaleDateString("en-IN")}.</>}
            </p>
          </div>
        );
      })()}
      {showMissing && missing.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-slate-500">
          {missing.map((b) => (
            <li key={b.key}>◦ {b.label}: not yet confirmed</li>
          ))}
        </ul>
      )}
    </div>
  );
}
