import { notFound } from "next/navigation";
import { maskPhone } from "@/server/auth";
import { getAuthorizationForOwner } from "@/server/trust";
import { OwnerConfirm } from "./OwnerConfirm";

export const dynamic = "force-dynamic";

export default async function OwnerConfirmPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const a = await getAuthorizationForOwner(id);
  if (!a) notFound();
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-2xl font-extrabold">Confirm a listing request</h1>
      <div className="card mt-4 space-y-2 p-5 text-sm">
        <p><b>{a.org?.displayName}</b> has asked to market your property on Nazariya:</p>
        <p className="rounded-xl bg-slate-50 p-3">{a.property.name ?? ""}<br />{a.property.addressLine}</p>
        <p>Basis: {a.auth.basis.replace(/_/g, " ")}{a.auth.exclusive ? " · exclusive" : " · non-exclusive"}</p>
        <p className="text-slate-500">We will send a code to the owner number on record ({maskPhone(a.owner!.phone)}). Only confirm if you know this lister.</p>
        <p>Current status: <b data-testid="owner-auth-status">{a.auth.status}</b></p>
        {a.auth.status === "pending" ? <OwnerConfirm authorizationId={id} /> : <p className="text-slate-600">No action needed.</p>}
      </div>
    </div>
  );
}
