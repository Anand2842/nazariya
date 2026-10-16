import { CATEGORY_LABEL } from "@/lib/catalog";

export function SearchForm({ localities, values = {}, compact = false }: { localities: { id: string; name: string }[]; values?: Record<string, string | undefined>; compact?: boolean }) {
  return (
    <form action="/search" className={`grid gap-2 ${compact ? "sm:grid-cols-6" : "sm:grid-cols-[1fr_1fr_1fr_auto]"}`} data-testid="search-form">
      <select name="category" defaultValue={values.category ?? ""} className="input" aria-label="Category">
        <option value="">PG, flats & hotels</option>
        {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <select name="locality" defaultValue={values.locality ?? ""} className="input" aria-label="Locality">
        <option value="">All of Delhi</option>
        {localities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
      <input name="maxBudget" type="number" min={500} step={500} defaultValue={values.maxBudget ?? ""} className="input" placeholder="Max budget (₹)" aria-label="Max budget" />
      {compact && (
        <>
          <input name="moveIn" type="date" defaultValue={values.moveIn ?? ""} className="input" aria-label="Move-in date" />
          <select name="sort" defaultValue={values.sort ?? "relevance"} className="input" aria-label="Sort">
            <option value="relevance">Most trusted first</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
            <option value="newest">Newest</option>
          </select>
        </>
      )}
      <button className="btn-primary" type="submit">Search</button>
      {compact && (
        <div className="flex flex-wrap gap-3 text-sm sm:col-span-6">
          {[
            ["noBrokerage", "No brokerage"],
            ["ownerAuthorised", "Owner-authorised only"],
            ["has3d", "Has 3D tour"],
          ].map(([k, label]) => (
            <label key={k} className="flex items-center gap-1.5">
              <input type="checkbox" name={k} value="1" defaultChecked={values[k] === "1"} /> {label}
            </label>
          ))}
          <select name="gender" defaultValue={values.gender ?? ""} className="rounded-lg border border-slate-300 px-2 py-1" aria-label="PG type">
            <option value="">PG: any</option>
            <option value="female">Women only</option>
            <option value="male">Men only</option>
            <option value="coed">Co-living</option>
          </select>
          <select name="sharing" defaultValue={values.sharing ?? ""} className="rounded-lg border border-slate-300 px-2 py-1" aria-label="Sharing">
            <option value="">Sharing: any</option>
            <option value="1">Single</option>
            <option value="2">Double</option>
            <option value="3">Triple</option>
          </select>
        </div>
      )}
    </form>
  );
}
