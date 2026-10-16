import Link from "next/link";
import { notFound } from "next/navigation";
import { EmbedPanel } from "@/components/studio/EmbedPanel";
import { FloorPlanEditor } from "@/components/studio/FloorPlanEditor";
import { PublishBar } from "@/components/studio/PublishBar";
import { RoomEditor } from "@/components/studio/RoomEditor";
import { SpaceSettingsForm } from "@/components/studio/SpaceSettingsForm";
import { DomainError } from "@/server/errors";
import { requireUser } from "@/server/session";
import { embedSnippet, sdkSnippet, spaceEditorData } from "@/server/studio";

export const dynamic = "force-dynamic";

export default async function SpaceEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/studio/spaces/${id}`);
  let d;
  try {
    d = await spaceEditorData(user, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const base = (process.env.APP_URL ?? "http://localhost:3100").replace(/\/$/, "");
  const ser = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  const roomsById = new Map(d.zones.map((z) => [z.id, z]));
  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-6" data-testid="space-editor">
      <div>
        <Link href="/studio" className="text-sm text-nazar">← All spaces</Link>
        <h1 className="mt-1 text-2xl font-extrabold">{d.space.name}</h1>
        <p className="muted">ID {d.space.publicId}{d.space.externalRef ? ` · your ref ${d.space.externalRef}` : ""}</p>
      </div>
      <PublishBar spaceId={d.space.id} publicId={d.space.publicId} status={d.space.status} checklist={d.checklist} />
      <RoomEditor
        spaceId={d.space.id}
        posterAssetId={d.space.posterAssetId}
        rooms={ser(d.tour.map((z) => ({ ...z, roomDims: (roomsById.get(z.id)?.roomDims as { w: number; d: number; h: number; camH: number }) ?? z.roomDims })))}
        media={d.media.map((m) => ({ id: m.id, kind: m.kind, status: m.status, rejectReason: m.rejectReason, originalName: m.originalName, thumb: m.urls?.thumb ?? null, inApp: !!(m.meta as { capture?: unknown }).capture, warning: (m.meta as { stitch?: { warning?: string | null } }).stitch?.warning ?? null }))}
      />
      <FloorPlanEditor
        spaceId={d.space.id}
        rooms={ser(
          d.zones.map((z) => ({
            id: z.id,
            label: z.label,
            dims: z.roomDims as { w: number; d: number; h: number; camH: number },
            plan: (z.plan as never) ?? null,
            doors: (d.tour.find((t) => t.id === z.id)?.hotspots ?? []).filter((h) => h.type === "door_to_zone").map((h) => ({ targetZoneId: h.targetZoneId, yaw: h.yaw })),
          })),
        )}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <EmbedPanel
          spaceId={d.space.id}
          publicId={d.space.publicId}
          base={base}
          iframe={embedSnippet(base, d.space.publicId)}
          sdk={sdkSnippet(base, d.space.publicId)}
          allowedDomains={d.space.allowedDomains}
          published={d.space.status === "published"}
        />
        <SpaceSettingsForm space={ser({ id: d.space.id, name: d.space.name, kind: d.space.kind, address: d.space.address, description: d.space.description, externalRef: d.space.externalRef, settings: d.space.settings as object })} />
      </div>
      <section className="card p-4" data-testid="analytics">
        <p className="section-title">Analytics (last {d.stats.days} days)</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          {[["Tour opens", d.stats.opens], ["Rendered", d.stats.renders], ["Room views", d.stats.roomViews], ["Hotspot clicks", d.stats.hotspotOpens]].map(([l, n]) => (
            <div key={l as string} className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-2xl font-extrabold">{n as number}</p></div>
          ))}
        </div>
        <div className="mt-3 grid gap-4 text-sm sm:grid-cols-3">
          <div><p className="label">Top websites</p>{d.stats.byRef.map((r) => <p key={r.host ?? "direct"}>{r.host ?? "direct / app"}: <b>{r.n}</b></p>)}{!d.stats.byRef.length && <p className="muted">No views yet</p>}</div>
          <div><p className="label">Most viewed rooms</p>{d.stats.byZone.map((r) => <p key={r.zoneId}>{roomsById.get(r.zoneId ?? "")?.label ?? "Room"}: <b>{r.n}</b></p>)}</div>
          <div><p className="label">Fallbacks</p>{d.stats.fallbacks.map((r) => <p key={r.reason}>{r.reason}: <b>{r.n}</b></p>)}{!d.stats.fallbacks.length && <p className="muted">None</p>}</div>
        </div>
      </section>
    </div>
  );
}
