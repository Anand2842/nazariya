import Link from "next/link";
import { ListingCard } from "@/components/ListingCard";
import { SearchForm } from "@/components/SearchForm";
import { allLocalities, searchListings } from "@/server/listings";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [locs, results] = await Promise.all([allLocalities(), searchListings({})]);
  const by = (c: string) => results.filter((r) => r.category === c).slice(0, 3);
  return (
    <div>
      <section className="bg-gradient-to-b from-nazar-light/60 to-paper">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:py-16">
          <p className="chip bg-white text-nazar">Delhi · PGs · Flats · Hotels</p>
          <h1 className="mt-3 max-w-2xl text-3xl font-extrabold leading-tight text-ink sm:text-5xl">See the real room before you travel across Delhi.</h1>
          <p className="mt-3 max-w-2xl text-lg text-ink-soft">360° and 3D room tours, rent and brokerage declared up front, and badges that only appear when the lister and owner have actually been verified.</p>
          <div className="mt-6 max-w-3xl rounded-2xl bg-white p-3 shadow-lg">
            <SearchForm localities={locs} />
          </div>
        </div>
      </section>
      {(["pg", "rent", "short_stay"] as const).map((c) =>
        by(c).length ? (
          <section key={c} className="mx-auto max-w-6xl px-4 py-6">
            <div className="mb-3 flex items-end justify-between">
              <h2 className="text-xl font-bold">{c === "pg" ? "PGs & co-living" : c === "rent" ? "Flats & houses" : "Hotels & short stays"}</h2>
              <Link className="text-sm font-semibold text-nazar" href={`/search?category=${c}`}>See all →</Link>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {by(c).map((r) => <ListingCard key={r.id} r={r} />)}
            </div>
          </section>
        ) : null,
      )}
      <section className="mx-auto mt-6 max-w-6xl px-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            ["Walk the room", "360° tours on any phone, and a 3D walk-through where the room supports it. Facts stay next to the tour."],
            ["Know the full cost", "Deposit, brokerage, maintenance and electricity are structured fields. The move-in total is calculated for you."],
            ["Trust you can check", "Tap any badge to see what was verified, when, and what wasn't. Stale listings drop out of search automatically."],
          ].map(([t, d]) => (
            <div key={t} className="card p-5">
              <p className="font-bold text-ink">{t}</p>
              <p className="mt-1 text-sm text-slate-600">{d}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
