import type { Metadata } from "next";
import { ListingCard } from "@/components/ListingCard";
import { SearchForm } from "@/components/SearchForm";
import { allLocalities, searchListings, searchSchema } from "@/server/listings";

export const metadata: Metadata = { title: "Search rentals in Delhi" };
export const dynamic = "force-dynamic";

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const clean = Object.fromEntries(Object.entries(sp).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = searchSchema.safeParse(clean);
  const [locs, results] = await Promise.all([allLocalities(), parsed.success ? searchListings(parsed.data) : Promise.resolve([])]);
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <h1 className="mb-3 text-2xl font-extrabold">Find a place</h1>
      <div className="card p-3">
        <SearchForm localities={locs} values={sp} compact />
      </div>
      {!parsed.success && <p className="mt-3 text-sm text-rose-600">Some filters were invalid and were ignored.</p>}
      <p className="mt-4 text-sm text-slate-500" data-testid="result-count">
        {results.length} listing{results.length === 1 ? "" : "s"} · only listings with recently confirmed availability are shown
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {results.map((r) => <ListingCard key={r.id} r={r} />)}
      </div>
      {!results.length && <p className="mt-10 text-center text-slate-500">No listings match. Try a wider budget or another locality.</p>}
    </div>
  );
}
