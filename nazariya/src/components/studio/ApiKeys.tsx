"use client";
import { useState } from "react";
import { createApiKeyAction, revokeApiKeyAction } from "@/app/actions/studio";
import { CopyButton } from "./CopyButton";
import { Msg, useAction } from "./useAction";

export function ApiKeys({ keys }: { keys: { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }[] }) {
  const { msg, busy, run } = useAction();
  const [fresh, setFresh] = useState<string | null>(null);
  return (
    <section className="card space-y-3 p-4" data-testid="api-keys">
      <p className="section-title">API keys</p>
      <p className="muted">Use a key from your server or app to list your published tours and get embed URLs: <code>GET /api/v1/spaces</code>. <a className="text-nazar underline" href="/docs">Docs</a></p>
      <form
        className="flex gap-2"
        action={async (fd) => {
          const r = await run(() => createApiKeyAction(String(fd.get("name"))));
          if (r.ok) setFresh((r.data as { key: string }).key);
        }}
      >
        <input name="name" className="input" placeholder="Key name, e.g. Website" required aria-label="Key name" />
        <button className="btn-secondary" disabled={busy} type="submit" data-testid="create-key">Create key</button>
      </form>
      {fresh && (
        <div className="rounded-xl bg-amber-50 p-3 text-sm" data-testid="new-key">
          <p className="font-semibold">Copy this key now. It won&apos;t be shown again.</p>
          <code className="block break-all py-1" data-testid="new-key-value">{fresh}</code>
          <CopyButton text={fresh} />
        </div>
      )}
      <ul className="divide-y divide-slate-100 text-sm">
        {keys.map((k) => (
          <li key={k.id} className="flex items-center justify-between gap-2 py-2">
            <span><b>{k.name}</b> <code className="text-slate-500">{k.prefix}…</code> {k.lastUsedAt ? <span className="text-xs text-slate-400">used {new Date(k.lastUsedAt).toLocaleDateString("en-IN")}</span> : null}</span>
            {k.revokedAt ? <span className="text-xs text-rose-600">revoked</span> : <button className="text-xs text-rose-600 underline" onClick={() => run(() => revokeApiKeyAction(k.id), "Key revoked")}>Revoke</button>}
          </li>
        ))}
      </ul>
      <Msg msg={msg} />
    </section>
  );
}
