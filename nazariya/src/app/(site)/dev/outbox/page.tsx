import { desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/server/db";
import { devToolsEnabled } from "@/server/notify";
import { notifications } from "@/server/schema";

export const dynamic = "force-dynamic";

/** DEV ONLY: shows OTPs and WhatsApp/SMS messages that a production adapter would deliver. */
export default async function Outbox() {
  if (!devToolsEnabled()) notFound();
  const rows = await db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(80);
  const linkify = (s: string) =>
    s.split(/(https?:\/\/\S+)/).map((part, i) =>
      /^https?:\/\//.test(part) ? <Link key={i} className="text-nazar underline" href={part.replace(/^https?:\/\/[^/]+/, "")}>{part.replace(/^https?:\/\/[^/]+/, "")}</Link> : part,
    );
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-extrabold">Dev outbox</h1>
      <p className="muted">Messages that would go out by SMS/WhatsApp. Disabled in production.</p>
      <ul className="mt-4 space-y-2" data-testid="outbox">
        {rows.map((n) => (
          <li key={n.id} className="card p-3 text-sm">
            <p className="text-xs text-slate-500">{n.createdAt.toLocaleString("en-IN")} · {n.channel} → {n.toPhone ?? "—"} · {n.template} · {n.status}</p>
            <p className="mt-1">{linkify(n.body)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
