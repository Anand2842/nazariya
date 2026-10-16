"use client";
import { useRouter } from "next/navigation";
import { createSpaceAction } from "@/app/actions/studio";
import { SPACE_KINDS } from "@/lib/catalog";
import { Msg, useAction } from "./useAction";

export function NewSpaceForm() {
  const router = useRouter();
  const { msg, busy, run } = useAction();
  return (
    <form
      className="card grid gap-2 p-4 sm:grid-cols-[2fr_1fr_1fr_auto]"
      data-testid="new-space-form"
      action={async (fd) => {
        const r = await run(() => createSpaceAction({ name: String(fd.get("name")), kind: String(fd.get("kind")) as "apartment", externalRef: String(fd.get("externalRef") || "") || null }));
        if (r.ok) router.push(`/studio/spaces/${(r.data as { id: string }).id}`);
      }}
    >
      <input name="name" className="input" placeholder="Space name, e.g. 3BHK Tower B, Flat 1204" required minLength={2} aria-label="Space name" />
      <select name="kind" className="input" aria-label="Type">{Object.entries(SPACE_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <input name="externalRef" className="input" placeholder="Your listing ID (optional)" aria-label="Your listing ID" />
      <button className="btn-primary" disabled={busy} type="submit" data-testid="new-space-submit">+ New space</button>
      <div className="sm:col-span-4"><Msg msg={msg} /></div>
    </form>
  );
}
