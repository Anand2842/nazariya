"use client";
import { publishAction, unpublishAction } from "@/app/actions/studio";
import { Msg, useAction } from "./useAction";

export function PublishBar({ spaceId, publicId, status, checklist }: { spaceId: string; publicId: string; status: string; checklist: { errors: string[]; warnings: string[] } }) {
  const { msg, busy, run } = useAction();
  return (
    <section className="card p-4" data-testid="publish-bar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          Status: <span className={`chip ${status === "published" ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-700"}`} data-testid="space-status">{status}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <a className="btn-secondary" href={`/t/${publicId}`} target="_blank" data-testid="preview-link">{status === "published" ? "Open share page" : "Preview"}</a>
          {status !== "published" ? (
            <button className="btn-primary" disabled={busy} onClick={() => run(() => publishAction(spaceId), "Published: your embed code is live")} data-testid="publish">Publish</button>
          ) : (
            <button className="btn-ghost" disabled={busy} onClick={() => run(() => unpublishAction(spaceId))} data-testid="unpublish">Unpublish</button>
          )}
        </div>
      </div>
      {status !== "published" && checklist.errors.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-sm text-rose-700" data-testid="publish-blockers">{checklist.errors.map((e) => <li key={e}>✗ {e}</li>)}</ul>
      )}
      {checklist.warnings.length > 0 && <ul className="mt-2 space-y-0.5 text-sm text-amber-700">{checklist.warnings.map((e) => <li key={e}>• {e}</li>)}</ul>}
      <Msg msg={msg} />
    </section>
  );
}
