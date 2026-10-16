import { PropertyForm } from "@/components/dashboard/PropertyForm";
import { allLocalities } from "@/server/listings";
import { requireUser } from "@/server/session";
import { redirect } from "next/navigation";

export default async function NewProperty() {
  const user = await requireUser("/dashboard/properties/new");
  if (!user.orgs.length) redirect("/dashboard");
  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <h1 className="mb-4 text-2xl font-extrabold">Add a property</h1>
      <PropertyForm localities={await allLocalities()} orgType={user.orgs[0].type} myPhone={user.phone} />
    </div>
  );
}
