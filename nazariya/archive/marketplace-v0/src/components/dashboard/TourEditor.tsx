"use client";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { addHotspotAction, buildSplatAction, createZoneAction, deleteHotspotAction, deleteMediaAction, deleteZoneAction, startCaptureAction, updateZoneAction } from "@/app/actions/lister";
import { HOTSPOT_TYPES, ROOM_TYPES } from "@/lib/catalog";
import type { ViewerZone } from "../tour/types";

const PanoView = dynamic(() => import("../tour/PanoView"), { ssr: false });

interface ZoneRow extends ViewerZone {
  unitId: string | null;
  roomDims: { w: number; d: number; h: number; camH: number };
}
interface Media { id: string; kind: string; status: string; rejectReason: string | null; originalName: string | null; thumb: string | null; meta: Record<string, unknown> }

export function TourEditor({ listingId, propertyId, zones, units, media }: { listingId: string; propertyId: string; zones: ZoneRow[]; units: { id: string; label: string }[]; media: Media[] }) {
  const router = useRouter();
  const [sel, setSel] = useState<string | null>(zones[0]?.id ?? null);
  const [msg, setMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [pick, setPick] = useState<{ yaw: number; pitch: number } | null>(null);
  const session = useRef<string | null>(null);
  const zone = zones.find((z) => z.id === sel) ?? null;

  const report = (r: { ok: boolean; error?: string; details?: string[] }, ok?: string) => {
    setMsg(r.ok ? ok ?? null : [r.error, ...(r.details ?? [])].join(" · "));
    if (r.ok) router.refresh();
    return r.ok;
  };

  async function ensureSession(): Promise<string | null> {
    if (session.current) return session.current;
    const pos = await new Promise<GeolocationPosition | null>((res) => {
      if (!navigator.geolocation) return res(null);
      navigator.geolocation.getCurrentPosition(res, () => res(null), { enableHighAccuracy: true, timeout: 8000 });
    });
    const r = await startCaptureAction({ propertyId, device: navigator.userAgent.slice(0, 180), lat: pos?.coords.latitude ?? null, lng: pos?.coords.longitude ?? null, tier: "T1" });
    if (!r.ok) return null;
    session.current = (r.data as { id: string }).id;
    if (!pos) setMsg("Location unavailable: uploads will not earn the 'Photos taken on-site' badge.");
    return session.current;
  }

  async function upload(kind: "pano" | "photo" | "video", files: FileList | null) {
    if (!files?.length || !zone) return;
    setUploading(kind);
    const sid = await ensureSession();
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.set("file", f);
      fd.set("kind", kind);
      fd.set("propertyId", propertyId);
      fd.set("zoneId", zone.id);
      if (zone.unitId) fd.set("unitId", zone.unitId);
      if (sid) fd.set("captureSessionId", sid);
      const res = await fetch("/api/uploads", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setMsg(`${f.name}: ${data.error}`);
        break;
      }
      setMsg(`${f.name} uploaded: processing in the background (refresh in a few seconds)`);
    }
    setUploading(null);
    router.refresh();
  }

  return (
    <section className="card space-y-4 p-4" data-testid="tour-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="section-title">Room tour & media</p>
        <form
          className="flex flex-wrap gap-2"
          action={async (fd) => {
            const r = await createZoneAction(listingId, propertyId, { label: String(fd.get("label")), roomType: String(fd.get("roomType")), unitId: String(fd.get("unitId") || "") || null });
            if (report(r) && r.ok) setSel((r.data as { id: string }).id);
          }}
        >
          <input name="label" className="input w-40" placeholder="Room name" required aria-label="Room name" data-testid="zone-label" />
          <select name="roomType" className="input w-32" aria-label="Room type">{Object.entries(ROOM_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select name="unitId" className="input w-36" aria-label="Unit" defaultValue={units.length === 1 ? units[0].id : ""}><option value="">Common area</option>{units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}</select>
          <button className="btn-secondary" type="submit" data-testid="zone-add">+ Room</button>
        </form>
      </div>
      <div className="flex gap-2 overflow-x-auto">
        {zones.map((z) => (
          <button key={z.id} type="button" onClick={() => { setSel(z.id); setPick(null); }} className={`shrink-0 rounded-xl border px-3 py-1.5 text-xs ${z.id === sel ? "border-nazar bg-nazar-light/60" : "border-slate-200"}`}>
            <b>{z.label}</b>
            <span className="block text-slate-500">{z.pano?.url ? "360°" : "no 360°"} · {z.photos.length} photos · 3D: {z.splatStatus.replace(/_/g, " ")}</span>
          </button>
        ))}
      </div>
      {zone && (
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <div className="relative h-80 overflow-hidden rounded-xl bg-slate-900">
              {zone.pano?.url ? (
                <PanoView zone={zone} mobile={false} pickMode onPick={(yaw, pitch) => setPick({ yaw, pitch })} onHotspot={() => {}} />
              ) : (
                <div className="grid h-full place-items-center text-sm text-white/70">Upload a 360° capture for this room to place hotspots</div>
              )}
            </div>
            {zone.pano?.url && <p className="mt-1 text-xs text-slate-500">Click anywhere in the 360° view to place a hotspot.</p>}
            {pick && (
              <form
                className="mt-2 grid gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-2"
                data-testid="hotspot-form"
                action={async (fd) => {
                  const type = String(fd.get("type")) as "info" | "door_to_zone" | "amenity" | "issue_disclosure" | "view" | "room_label";
                  const r = await addHotspotAction(listingId, zone.id, { type, yaw: pick.yaw, pitch: pick.pitch, title: String(fd.get("title")), body: String(fd.get("body") ?? ""), targetZoneId: type === "door_to_zone" ? String(fd.get("target")) : null });
                  if (report(r, "Hotspot added")) setPick(null);
                }}
              >
                <select name="type" className="input" aria-label="Hotspot type">{Object.entries(HOTSPOT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <select name="target" className="input" aria-label="Leads to"><option value="">(for "Go to room")</option>{zones.filter((z) => z.id !== zone.id).map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}</select>
                <input name="title" className="input sm:col-span-2" placeholder="Title, e.g. Split AC" required maxLength={60} aria-label="Hotspot title" />
                <textarea name="body" className="input sm:col-span-2" placeholder="Details (optional)" maxLength={500} aria-label="Hotspot details" />
                <div className="flex gap-2"><button className="btn-primary" type="submit">Add hotspot</button><button type="button" className="btn-ghost" onClick={() => setPick(null)}>Cancel</button></div>
              </form>
            )}
            <ul className="mt-3 space-y-1 text-sm">
              {zone.hotspots.map((h) => (
                <li key={h.id} className="flex justify-between gap-2">
                  <span><span className="text-slate-400">{HOTSPOT_TYPES[h.type]}:</span> {h.title}</span>
                  <button className="text-xs text-rose-600 underline" onClick={async () => report(await deleteHotspotAction(listingId, h.id))}>remove</button>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-3 text-sm">
            <div className="rounded-xl bg-slate-50 p-3">
              <p className="font-semibold">Capture</p>
              <p className="text-xs text-slate-500">Photos: each corner + window. 360°: stand in the centre at chest height. Video: walk slowly for 30–90 s with lights on.</p>
              <div className="mt-2 grid gap-2">
                <label className="btn-secondary cursor-pointer">{uploading === "pano" ? "Uploading…" : "Upload 360° capture"}<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => upload("pano", e.target.files)} data-testid="upload-pano" /></label>
                <label className="btn-secondary cursor-pointer">{uploading === "photo" ? "Uploading…" : "Add photos"}<input type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" onChange={(e) => upload("photo", e.target.files)} data-testid="upload-photo" /></label>
                <label className="btn-secondary cursor-pointer">{uploading === "video" ? "Uploading…" : "Upload walkthrough video"}<input type="file" accept="video/mp4,video/quicktime,video/webm" className="sr-only" onChange={(e) => upload("video", e.target.files)} data-testid="upload-video" /></label>
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <p className="font-semibold">3D walkthrough</p>
              <p className="text-xs text-slate-500">Status: <b data-testid="splat-status">{zone.splatStatus.replace(/_/g, " ")}</b>{zone.splatNote ? ` · ${zone.splatNote}` : ""}</p>
              <form
                className="mt-2 grid grid-cols-4 gap-1"
                action={async (fd) => void report(await updateZoneAction(listingId, zone.id, { roomDims: { w: Number(fd.get("w")), d: Number(fd.get("d")), h: Number(fd.get("h")), camH: Number(fd.get("camH")) } }), "Room shape saved")}
              >
                {(["w", "d", "h", "camH"] as const).map((k) => (
                  <input key={k} name={k} type="number" step="0.1" defaultValue={zone.roomDims[k]} className="input px-2" aria-label={k} title={{ w: "approx. width (m)", d: "approx. depth (m)", h: "ceiling height (m)", camH: "camera height (m)" }[k]} />
                ))}
                <button className="btn-ghost col-span-4 text-xs" type="submit">Save approximate room shape</button>
              </form>
              <button className="btn-primary mt-2 w-full" disabled={!zone.pano?.url || ["queued", "processing"].includes(zone.splatStatus)} onClick={async () => report(await buildSplatAction(listingId, zone.id), "3D build queued: the worker will process it shortly")} data-testid="build-3d">
                {zone.splatStatus === "ready" ? "Rebuild 3D" : "Build 3D from 360°"}
              </button>
              <p className="mt-1 text-[11px] text-slate-500">Approximate shape only gives depth to the view. It is never shown as a measurement.</p>
            </div>
            <button className="text-xs text-rose-600 underline" onClick={async () => { if (report(await deleteZoneAction(listingId, zone.id))) setSel(null); }}>Delete this room</button>
          </div>
        </div>
      )}
      <div>
        <p className="label">Uploads</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" data-testid="media-list">
          {media.filter((m) => m.kind !== "splat").slice(0, 36).map((m) => (
            <div key={m.id} className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100 text-[10px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {m.thumb ? <img src={m.thumb} alt="" className="aspect-[4/3] w-full object-cover" /> : <div className="grid aspect-[4/3] place-items-center">{m.kind}</div>}
              <div className={`px-1 py-0.5 ${m.status === "rejected" ? "bg-rose-50 text-rose-700" : m.status === "ready" ? "bg-white" : "bg-amber-50"}`} title={m.rejectReason ?? ""}>
                {m.kind} · {m.status}{m.rejectReason ? `: ${m.rejectReason}` : ""}
              </div>
              {m.status !== "rejected" && <button className="absolute right-1 top-1 rounded bg-white/90 px-1" aria-label="Remove" onClick={async () => report(await deleteMediaAction(listingId, m.id))}>✕</button>}
            </div>
          ))}
        </div>
      </div>
      {msg && <p className="text-sm text-nazar" role="status" data-testid="tour-msg">{msg}</p>}
    </section>
  );
}
