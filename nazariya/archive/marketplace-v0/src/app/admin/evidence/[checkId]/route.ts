import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import { verificationEvidence } from "@/server/schema";
import { getCurrentUser } from "@/server/session";
import { openStream } from "@/server/storage";

// Private verification evidence: admins only, every access is audit-logged.
export async function GET(req: Request, ctx: { params: Promise<{ checkId: string }> }) {
  const user = await getCurrentUser();
  if (!user?.roles.includes("admin")) return new NextResponse("Forbidden", { status: 403 });
  const { checkId } = await ctx.params;
  const evidenceId = new URL(req.url).searchParams.get("e") ?? "";
  const [e] = await db.select().from(verificationEvidence).where(and(eq(verificationEvidence.id, evidenceId), eq(verificationEvidence.checkId, checkId)));
  if (!e?.storageKey) return new NextResponse("Not found", { status: 404 });
  await db.transaction((tx) => writeAudit(tx, { actorUserId: user.id, actorRole: "admin", action: "evidence.viewed", subjectType: "check", subjectId: checkId, data: { evidenceId } }));
  const ext = e.storageKey.split(".").pop();
  return new NextResponse(Readable.toWeb(openStream(e.storageKey)) as ReadableStream, {
    headers: { "Content-Type": ext === "pdf" ? "application/pdf" : `image/${ext}`, "Cache-Control": "private, no-store" },
  });
}
