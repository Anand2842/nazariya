// Create a draft space with one room for trying a reconstruction run, and print the room id for import-scene.ts.
// Draft = visible only to members of the organisation (signed in), never public.
// Usage: node --env-file=.env.local --import tsx scripts/create-test-space.ts "<name>" [orgId]
import { desc, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { shortId } from "@/server/errors";
import { organizations, spaces, zones } from "@/server/schema";

const [name, orgArg] = process.argv.slice(2);
if (!name) throw new Error('usage: create-test-space.ts "<name>" [orgId]');
let orgId = orgArg;
if (!orgId) {
  // Only guess when there is a single organisation (test runs create their own, e.g. "E2E Realty").
  const orgs = await db.select({ id: organizations.id, name: organizations.name }).from(organizations).orderBy(desc(organizations.createdAt));
  if (orgs.length !== 1) {
    console.error(orgs.length ? `several organisations, pass one as the second argument:\n${orgs.map((o) => `  ${o.id}  ${o.name}`).join("\n")}` : "no organisation found");
    process.exit(1);
  }
  orgId = orgs[0].id;
}
const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
const [space] = await db.insert(spaces).values({ orgId, publicId: shortId(10), name, kind: "room", description: "Test of the video → 3D pipeline" }).returning();
const [zone] = await db.insert(zones).values({ spaceId: space.id, label: "Walkthrough", roomType: "room" }).returning();
console.error(`created draft space "${name}" in ${org.name}: open ${process.env.APP_URL ?? "http://localhost:3100"}/t/${space.publicId} (signed in)`);
console.log(zone.id);
process.exit(0);
