import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { ListingForm } from "@/components/dashboard/ListingForm";
import { db } from "@/server/db";
import { properties, units } from "@/server/schema";
import { requireUser } from "@/server/session";

export default async function NewListing({ searchParams }: { searchParams: Promise<{ propertyId?: string }> }) {
  await requireUser("/dashboard");
  const { propertyId } = await searchParams;
  if (!propertyId || !/^[0-9a-f-]{36}$/.test(propertyId)) notFound();
  const [p] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!p) notFound();
  const us = await db.select({ id: units.id, label: units.label }).from(units).where(eq(units.propertyId, p.id));
  const category = p.category === "pg" ? "pg" : p.category === "hotel" || p.category === "guesthouse" ? "short_stay" : "rent";
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-extrabold">New listing</h1>
      <p className="muted mb-4">{p.name ?? p.addressLine}</p>
      <ListingForm propertyId={p.id} category={category} units={us} />
    </div>
  );
}
