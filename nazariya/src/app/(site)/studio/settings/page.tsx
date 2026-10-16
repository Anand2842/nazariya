import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { ApiKeys } from "@/components/studio/ApiKeys";
import { BrandingForm } from "@/components/studio/BrandingForm";
import { db } from "@/server/db";
import { mediaAssets, organizations } from "@/server/schema";
import { requireUser } from "@/server/session";
import { listApiKeys, mediaUrls } from "@/server/studio";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const user = await requireUser("/studio/settings");
  if (!user.orgs.length) redirect("/studio");
  const org = user.orgs[0];
  const [o] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  const branding = o.branding as { primaryColor: string; showPoweredBy: boolean; logoAssetId?: string | null };
  const [logo] = branding.logoAssetId ? await db.select().from(mediaAssets).where(and(eq(mediaAssets.id, branding.logoAssetId), eq(mediaAssets.orgId, org.id))) : [];
  const keys = org.role === "owner" ? await listApiKeys(user) : [];
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6">
      <h1 className="text-2xl font-extrabold">Workspace settings</h1>
      <BrandingForm orgId={org.id} branding={branding} logoUrl={mediaUrls(logo)?.full ?? null} plan={o.plan} />
      {org.role === "owner" && <ApiKeys keys={JSON.parse(JSON.stringify(keys))} />}
    </div>
  );
}
