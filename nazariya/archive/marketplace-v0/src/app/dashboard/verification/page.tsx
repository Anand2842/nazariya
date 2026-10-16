import { KycForms } from "@/components/dashboard/KycForms";
import { TrustBadges } from "@/components/TrustBadges";
import { deriveBadges, isCheckValid } from "@/lib/badges";
import { CHECK_TYPES } from "@/lib/catalog";
import { requireUser } from "@/server/session";
import { checksFor } from "@/server/trust";

export const dynamic = "force-dynamic";

export default async function Verification() {
  const user = await requireUser("/dashboard/verification");
  const checks = await checksFor("user", [user.id]);
  const now = new Date();
  const has = (t: string) => checks.some((c) => c.checkType === t && (isCheckValid(c, now) || c.status === "needs_review"));
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-extrabold">Identity verification</h1>
      <p className="muted mt-1">Badges are earned only from checks that pass. They expire and must be renewed.</p>
      <div className="mt-4"><TrustBadges badges={deriveBadges(checks).filter((b) => b.key === "id_checked_broker")} showMissing /></div>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <KycForms hasPan={has("pan_verified")} hasDl={has("identity_digilocker")} />
        <div className="card p-4">
          <p className="font-semibold">Your checks</p>
          <ul className="mt-2 space-y-2 text-sm" data-testid="my-checks">
            {checks.map((c) => (
              <li key={c.id} className="flex justify-between gap-2 border-b border-slate-100 pb-1">
                <span>{CHECK_TYPES[c.checkType]?.label ?? c.checkType}</span>
                <span className={c.status === "passed" ? "text-emerald-700" : c.status === "needs_review" ? "text-amber-700" : "text-rose-700"}>
                  {c.status.replace("_", " ")}{c.expiresAt ? ` · until ${c.expiresAt.toLocaleDateString("en-IN")}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
