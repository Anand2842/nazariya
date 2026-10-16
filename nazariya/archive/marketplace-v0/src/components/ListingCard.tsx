import Link from "next/link";
import { CATEGORY_LABEL } from "@/lib/catalog";
import { formatINR } from "@/lib/money";
import { relativeAge } from "@/lib/freshness";
import type { SearchResult } from "@/server/listings";
import { ShortlistButton } from "./ShortlistButton";

export function ListingCard({ r }: { r: SearchResult }) {
  const earned = r.badges.filter((b) => b.earned);
  const movein = r.plans[0];
  return (
    <article className="card overflow-hidden" data-testid="listing-card">
      <Link href={`/l/${r.slug}`} className="block">
        <div className="relative aspect-[16/10] bg-slate-200">
          {r.poster?.poster || r.poster?.full ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={(r.poster.poster ?? r.poster.full)!} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : null}
          <div className="absolute left-2 top-2 flex gap-1">
            {r.has3d && <span className="chip bg-ink/85 text-white">3D tour</span>}
            {r.has360 && <span className="chip bg-white/90 text-ink">360°</span>}
          </div>
        </div>
      </Link>
      <div className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-nazar">{CATEGORY_LABEL[r.category]} · {r.locality}</p>
            <Link href={`/l/${r.slug}`} className="mt-0.5 line-clamp-2 font-semibold text-ink hover:underline">{r.title}</Link>
          </div>
          <ShortlistButton id={r.id} />
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-xs text-slate-500">from</span>
          <span className="text-lg font-extrabold text-ink">{formatINR(r.fromPaise)}</span>
          <span className="text-sm text-slate-500">/{r.period}</span>
        </div>
        {movein && movein.period === "month" && (
          <p className="text-xs text-slate-600">
            Move-in {formatINR(movein.moveInPaise)} · Brokerage: {movein.brokeragePaise ? formatINR(movein.brokeragePaise) : "none"}
          </p>
        )}
        <div className="flex flex-wrap gap-1">
          {earned.map((b) => (
            <span key={b.key} className="chip bg-emerald-50 text-emerald-800">{b.label}</span>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          {r.lastConfirmedAt ? `Confirmed ${relativeAge(r.lastConfirmedAt)}` : "Not confirmed"}
          {r.nearestMetro ? ` · Metro: ${r.nearestMetro}` : ""}
        </p>
      </div>
    </article>
  );
}
