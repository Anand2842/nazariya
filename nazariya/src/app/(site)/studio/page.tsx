import Link from "next/link";
import { OnboardingForm } from "@/components/studio/OnboardingForm";
import { NewSpaceForm } from "@/components/studio/NewSpaceForm";
import { SPACE_KINDS } from "@/lib/catalog";
import { requireUser } from "@/server/session";
import { listSpaces } from "@/server/studio";

export const dynamic = "force-dynamic";

export default async function Studio() {
  const user = await requireUser("/studio");
  if (!user.orgs.length) {
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <h1 className="text-2xl font-extrabold">Create your workspace</h1>
        <p className="muted mb-5 mt-1">Your team&apos;s tours, branding and API keys live here.</p>
        <OnboardingForm />
      </div>
    );
  }
  const spaces = await listSpaces(user);
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">{user.orgs[0].name}</h1>
          <p className="muted">Studio · {spaces.length} space{spaces.length === 1 ? "" : "s"} · plan: {user.orgs[0].plan}</p>
        </div>
        <Link className="btn-secondary" href="/studio/settings">Branding & API keys</Link>
      </div>
      <NewSpaceForm />
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="space-grid">
        {spaces.map((s) => (
          <Link key={s.id} href={`/studio/spaces/${s.id}`} className="card overflow-hidden hover:shadow-md" data-testid="space-card">
            <div className="relative aspect-[16/9] bg-slate-200">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {s.poster && <img src={s.poster} alt="" className="h-full w-full object-cover" />}
              <span className={`chip absolute left-2 top-2 ${s.status === "published" ? "bg-emerald-600 text-white" : "bg-white/90 text-ink"}`}>{s.status}</span>
            </div>
            <div className="p-4">
              <p className="font-semibold text-ink">{s.name}</p>
              <p className="text-xs text-slate-500">{SPACE_KINDS[s.kind] ?? s.kind} · {s.rooms} room{s.rooms === 1 ? "" : "s"} · {s.threeD} in 3D · {s.views30d} views (30d)</p>
            </div>
          </Link>
        ))}
        {!spaces.length && <p className="muted">No spaces yet. Create your first one above.</p>}
      </div>
    </div>
  );
}
