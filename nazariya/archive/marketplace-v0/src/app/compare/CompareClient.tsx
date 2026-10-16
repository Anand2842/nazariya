"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { readShortlist } from "@/components/ShortlistButton";
import { CATEGORY_LABEL } from "@/lib/catalog";
import { formatINR } from "@/lib/money";
import type { SearchResult } from "@/server/listings";

export function CompareClient({ results }: { results: SearchResult[] }) {
  const [ids, setIds] = useState<string[] | null>(null);
  useEffect(() => setIds(readShortlist()), []);
  if (ids === null) return null;
  const rows = results.filter((r) => ids.includes(r.id));
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <h1 className="text-2xl font-extrabold">Compare your shortlist</h1>
      {!rows.length ? (
        <p className="muted mt-4">Tap ☆ on up to 4 listings to compare their real move-in cost side by side.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm" data-testid="compare-table">
            <thead>
              <tr>
                <th className="w-40" />
                {rows.map((r) => (
                  <th key={r.id} className="p-2 text-left align-top">
                    <Link href={`/l/${r.slug}`} className="font-semibold text-nazar underline">{r.title}</Link>
                    <div className="text-xs font-normal text-slate-500">{CATEGORY_LABEL[r.category]} · {r.locality}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ["Rent from", (r: SearchResult) => `${formatINR(r.fromPaise)}/${r.period}`],
                ["Deposit", (r: SearchResult) => (r.plans[0]?.depositPaise != null ? formatINR(r.plans[0].depositPaise) : "n/a")],
                ["Brokerage", (r: SearchResult) => (r.plans[0]?.brokerageDisclosed ? (r.plans[0].brokeragePaise ? formatINR(r.plans[0].brokeragePaise) : "None") : "n/a")],
                ["To move in", (r: SearchResult) => (r.plans[0]?.period === "month" ? formatINR(r.plans[0].moveInPaise) : "per stay")],
                ["Monthly after", (r: SearchResult) => (r.plans[0]?.period === "month" ? formatINR(r.plans[0].monthlyRecurringPaise) + (r.plans[0].hasVariableCharges ? " + metered" : "") : "n/a")],
                ["Verification", (r: SearchResult) => r.badges.filter((b) => b.earned).map((b) => b.label).join(", ") || "None yet"],
                ["Tour", (r: SearchResult) => (r.has3d ? "3D + 360°" : r.has360 ? "360°" : "Photos")],
                ["Metro", (r: SearchResult) => r.nearestMetro ?? "n/a"],
              ].map(([label, fn]) => (
                <tr key={label as string}>
                  <td className="border-t border-slate-200 p-2 font-medium text-slate-500">{label as string}</td>
                  {rows.map((r) => <td key={r.id} className="border-t border-slate-200 p-2">{(fn as (r: SearchResult) => string)(r)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
