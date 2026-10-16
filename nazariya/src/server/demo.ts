import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import { organizations, spaces } from "./schema";

export const DEMO_WORKSPACE_NAME = "Nazariya Demo";

/** Published spaces of the demo workspace, shown on the landing page. */
export async function demoSpaces() {
  return db
    .select({ publicId: spaces.publicId, name: spaces.name, kind: spaces.kind })
    .from(spaces)
    .innerJoin(organizations, eq(organizations.id, spaces.orgId))
    .where(and(eq(organizations.name, DEMO_WORKSPACE_NAME), eq(spaces.status, "published")))
    .orderBy(desc(spaces.publishedAt));
}
