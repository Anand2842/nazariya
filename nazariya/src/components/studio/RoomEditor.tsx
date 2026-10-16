"use client";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  addHotspotAction,
  buildSplatAction,
  createZoneAction,
  deleteHotspotAction,
  deleteMediaAction,
  deleteZoneAction,
  moveZoneAction,
  setPosterAction,
  setScanTransformAction,
  updateZoneAction,
} from "@/app/actions/studio";
import { HOTSPOT_TYPES, ROOM_TYPES } from "@/lib/catalog";
import { CaptureStudio } from "../capture/CaptureStudio";
import { PhoneCapturePanel } from "../capture/PhoneCapturePanel";
import type { ViewerZone } from "../tour/types";

const PanoView = dynamic(() => import("../tour/PanoView"), { ssr: false });
const SplatView = dynamic(() => import("../tour/SplatView"), { ssr: false });

interface RoomRow extends ViewerZone {
  roomDims: { w: number; d: number; h: number; camH: number };
}
interface Media { id: string; kind: string; status: string; rejectReason: string | null; originalName: string | null; thumb: string | null; inApp?: boolean; warning?: string | null }

const STATUS_TEXT: Record<string, string> = {
  none: "not built",
  queued: "queued",
  processing: "building…",
  ready: "ready",
  failed: "failed",
  qa_failed: "quality check failed",
  needs_gpu_worker: "needs GPU worker",
};

export function RoomEditor({ spaceId, rooms, media, posterAssetId }: { spaceId: string; rooms: RoomRow[]; media: Media[]; posterAssetId: string | null }) {
  const router = useRouter();
  const [sel, setSel] = useState<string | null>(rooms[0]?.id ?? null);
  const [msg, setMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [pick, setPick] = useState<{ yaw: number; pitch: number } | null>(null);
  const [preview3d, setPreview3d] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const room = rooms.find((z) => z.id === sel) ?? null;

  const report = (r: { ok: boolean; error?: string; details?: string[] }, ok?: string) => {
    setMsg(r.ok ? ok ?? null : [r.error, ...(r.details ?? [])].join(" · "));
    if (r.ok) router.refresh();
    return r.ok;
  };

  async function upload(kind: "pano" | "photo" | "video" | "splat", files: FileList | null) {
    if (!files?.length || !room) return;
    setUploading(kind);
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.set("file", f);
      fd.set("kind", kind);
      fd.set("spaceId", spaceId);
      fd.set("zoneId", room.id);
      const res = await fetch("/api/uploads", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setMsg(`${f.name}: ${data.error}`);
        setUploading(null);
        return;
      }
      setMsg(`${f.name} uploaded: processing${kind === "pano" ? " (a 3D walkthrough is built automatically)" : ""}`);
    }
    setUploading(null);
    router.refresh();
  }

  return (
    <section className="card space-y-4 p-4" data-testid="room-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="section-title">Rooms</p>
        <form
          className="flex flex-wrap gap-2"
          action={async (fd) => {
            const r = await createZoneAction(spaceId, { label: String(fd.get("label")), roomType: String(fd.get("roomType")) });
            if (report(r) && r.ok) setSel((r.data as { id: string }).id);
          }}
        >
          <input name="label" className="input w-44" placeholder="Room name, e.g. Living room" required aria-label="Room name" data-testid="room-label" />
          <select name="roomType" className="input w-36" aria-label="Room type">{Object.entries(ROOM_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <button className="btn-secondary" type="submit" data-testid="room-add">+ Add room</button>
        </form>
      </div>
      {!rooms.length && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Start by adding a room, then upload a 360° image (best), a few photos, a walkthrough video or a 3D scan file.</p>}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {rooms.map((z, i) => (
          <div key={z.id} className={`flex shrink-0 items-stretch rounded-xl border ${z.id === sel ? "border-nazar bg-nazar-light/50" : "border-slate-200"}`}>
            <button type="button" onClick={() => { setSel(z.id); setPick(null); setPreview3d(false); }} className="px-3 py-1.5 text-left text-xs" data-testid="room-tab">
              <b>{z.label}</b>
              <span className="block text-slate-500">{z.pano?.url ? "360°" : "no 360°"} · {z.photos.length} photo{z.photos.length === 1 ? "" : "s"} · 3D {STATUS_TEXT[z.splatStatus] ?? z.splatStatus}</span>
            </button>
            <div className="flex flex-col justify-center border-l border-slate-200 text-[10px]">
              <button type="button" className="px-1 disabled:opacity-30" disabled={i === 0} onClick={async () => report(await moveZoneAction(spaceId, z.id, -1))} aria-label="Move left">◀</button>
              <button type="button" className="px-1 disabled:opacity-30" disabled={i === rooms.length - 1} onClick={async () => report(await moveZoneAction(spaceId, z.id, 1))} aria-label="Move right">▶</button>
            </div>
          </div>
        ))}
      </div>

      {room && (
        <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          <div>
            <div className="relative h-80 overflow-hidden rounded-xl bg-slate-900 sm:h-96">
              {preview3d && room.splat?.url ? (
                <SplatView key={`p3d-${room.id}-${JSON.stringify(room.splatTransform)}`} zone={room} mobile={false} onHotspot={() => {}} onError={(r) => setMsg(`3D preview failed: ${r}`)} />
              ) : room.pano?.url && !capturing ? (
                <PanoView key={`pano-${room.id}`} zone={room} mobile={false} pickMode onPick={(yaw, pitch) => setPick({ yaw, pitch })} onHotspot={() => {}} />
              ) : room.photos[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={room.photos[0].url} alt="" className="h-full w-full object-contain" />
              ) : (
                <div className="grid h-full place-items-center p-6 text-center text-sm text-white/70">Upload a 360° image, photos, a video or a 3D scan for this room</div>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {room.pano?.url && <button type="button" className={`btn px-2.5 py-1 text-xs ${!preview3d ? "bg-ink text-white" : "bg-slate-100"}`} onClick={() => setPreview3d(false)}>360° (place hotspots)</button>}
              {room.splat?.url && <button type="button" className={`btn px-2.5 py-1 text-xs ${preview3d ? "bg-ink text-white" : "bg-slate-100"}`} onClick={() => setPreview3d(true)} data-testid="preview-3d">Preview 3D</button>}
              {room.pano?.url && !preview3d && <span className="text-slate-500">Click inside the 360° view to add a hotspot.</span>}
            </div>
            {pick && !preview3d && (
              <form
                className="mt-2 grid gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-2"
                data-testid="hotspot-form"
                action={async (fd) => {
                  const type = String(fd.get("type")) as "info" | "amenity" | "door_to_zone" | "view" | "link";
                  const r = await addHotspotAction(spaceId, room.id, {
                    type,
                    yaw: pick.yaw,
                    pitch: pick.pitch,
                    title: String(fd.get("title")),
                    body: String(fd.get("body") ?? ""),
                    url: type === "link" ? String(fd.get("url") || "") || null : null,
                    targetZoneId: type === "door_to_zone" ? String(fd.get("target")) || null : null,
                  });
                  if (report(r, "Hotspot added")) setPick(null);
                }}
              >
                <select name="type" className="input" aria-label="Hotspot type" data-testid="hotspot-type">{Object.entries(HOTSPOT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <select name="target" className="input" aria-label="Leads to"><option value="">(for "Go to room")</option>{rooms.filter((z) => z.id !== room.id).map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}</select>
                <input name="title" className="input sm:col-span-2" placeholder="Label, e.g. Italian marble flooring" required maxLength={60} aria-label="Hotspot label" data-testid="hotspot-title" />
                <textarea name="body" className="input sm:col-span-2" placeholder="Details (optional)" maxLength={500} aria-label="Hotspot details" />
                <input name="url" className="input sm:col-span-2" placeholder="https:// link (for Link hotspots)" aria-label="Hotspot link" />
                <div className="flex gap-2"><button className="btn-primary" type="submit" data-testid="hotspot-save">Add hotspot</button><button type="button" className="btn-ghost" onClick={() => setPick(null)}>Cancel</button></div>
              </form>
            )}
            {room.hotspots.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm" data-testid="hotspot-list">
                {room.hotspots.map((h) => (
                  <li key={h.id} className="flex justify-between gap-2">
                    <span><span className="text-slate-400">{HOTSPOT_TYPES[h.type] ?? h.type}:</span> {h.title}</span>
                    <button className="text-xs text-rose-600 underline" onClick={async () => report(await deleteHotspotAction(spaceId, h.id))}>remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-3 text-sm">
            <div className="rounded-xl bg-ink p-3 text-white">
              <p className="font-semibold">Capture “{room.label}” with your camera</p>
              <p className="text-xs text-white/70">Guided 360°, photos or walkthrough video, with step-by-step instructions.</p>
              <button type="button" className="mt-2 w-full rounded-xl bg-white py-2.5 text-sm font-bold text-ink" onClick={() => setCapturing(true)} data-testid="open-capture">
                📷 Capture with camera
              </button>
            </div>
            <PhoneCapturePanel spaceId={spaceId} zoneId={room.id} />
            <div className="rounded-xl bg-slate-50 p-3">
              <p className="font-semibold">Or upload files</p>
              <div className="mt-2 grid gap-2">
                <label className="btn-primary cursor-pointer" data-testid="upload-pano-label">
                  {uploading === "pano" ? "Uploading…" : "360° image → 360° + 3D"}
                  <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => upload("pano", e.target.files)} data-testid="upload-pano" />
                </label>
                <label className="btn-secondary cursor-pointer">
                  {uploading === "photo" ? "Uploading…" : "Photos"}
                  <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" onChange={(e) => upload("photo", e.target.files)} data-testid="upload-photo" />
                </label>
                <label className="btn-secondary cursor-pointer">
                  {uploading === "video" ? "Uploading…" : "Walkthrough video"}
                  <input type="file" accept="video/mp4,video/quicktime,video/webm" className="sr-only" onChange={(e) => upload("video", e.target.files)} data-testid="upload-video" />
                </label>
                <label className="btn-secondary cursor-pointer">
                  {uploading === "splat" ? "Uploading…" : "3D scan (.ply / .spz / .splat)"}
                  <input type="file" accept=".ply,.spz,.splat,.ksplat" className="sr-only" onChange={(e) => upload("splat", e.target.files)} data-testid="upload-splat" />
                </label>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">360° images: 2:1 equirectangular from any 360° camera or phone 360° mode. 3D scans: exports from Polycam, Scaniverse, Luma, KIRI or XGRIDS.</p>
            </div>

            <div className="rounded-xl bg-slate-50 p-3">
              <p className="font-semibold">3D walkthrough</p>
              <p className="text-xs text-slate-600">
                Status: <b data-testid="splat-status">{STATUS_TEXT[room.splatStatus] ?? room.splatStatus}</b>
                {room.splatSource ? ` · ${room.splatSource.replace(/_/g, " ")}` : ""}
                {room.splatNote ? ` · ${room.splatNote}` : ""}
              </p>
              {room.splatSource !== "imported" && room.splatSource !== "reconstructed" && (
                <>
                  <form
                    className="mt-2 grid grid-cols-4 gap-1"
                    action={async (fd) => void report(await updateZoneAction(spaceId, room.id, { roomDims: { w: Number(fd.get("w")), d: Number(fd.get("d")), h: Number(fd.get("h")), camH: Number(fd.get("camH")) } }), "Room shape saved. Rebuild 3D to apply.")}
                  >
                    {(["w", "d", "h", "camH"] as const).map((k) => (
                      <label key={k} className="text-[10px] text-slate-500">
                        {{ w: "Width m", d: "Depth m", h: "Height m", camH: "Camera m" }[k]}
                        <input name={k} type="number" step="0.1" defaultValue={room.roomDims[k]} className="input px-2 py-1.5" />
                      </label>
                    ))}
                    <button className="btn-ghost col-span-4 text-xs" type="submit">Save approximate room shape</button>
                  </form>
                  <button className="btn-secondary mt-1 w-full" disabled={!room.pano?.url || ["queued", "processing"].includes(room.splatStatus)} onClick={async () => report(await buildSplatAction(spaceId, room.id), "3D build queued")} data-testid="build-3d">
                    {room.splatStatus === "ready" ? "Rebuild 3D" : "Build 3D from 360°"}
                  </button>
                  <p className="mt-1 text-[11px] text-slate-500">Approximate shape gives depth to the view; 3D scenes are visual aids, not measurements.</p>
                </>
              )}
              {(room.splatSource === "imported" || room.splatSource === "reconstructed") && room.splatTransform && (
                <form
                  className="mt-2 grid grid-cols-3 gap-1 text-[10px] text-slate-500"
                  action={async (fd) => void report(await setScanTransformAction(spaceId, room.id, { flip: fd.get("flip") === "on", yawDeg: Number(fd.get("yawDeg")), scale: Number(fd.get("scale")) }), "Orientation saved")}
                >
                  <label className="flex items-center gap-1"><input type="checkbox" name="flip" defaultChecked={room.splatTransform.flip} /> Flip upright</label>
                  <label>Rotate °<input name="yawDeg" type="number" step="15" defaultValue={room.splatTransform.yawDeg} className="input px-2 py-1" /></label>
                  <label>Scale<input name="scale" type="number" step="0.1" defaultValue={room.splatTransform.scale} className="input px-2 py-1" /></label>
                  <button className="btn-ghost col-span-3 text-xs" type="submit">Save scan orientation</button>
                </form>
              )}
            </div>

            <div className="rounded-xl bg-slate-50 p-3">
              <p className="font-semibold">Room</p>
              <form className="mt-1 flex gap-1" action={async (fd) => void report(await updateZoneAction(spaceId, room.id, { label: String(fd.get("label")), roomType: String(fd.get("roomType")) }), "Saved")}>
                <input name="label" className="input" defaultValue={room.label} aria-label="Rename room" />
                <select name="roomType" className="input w-32" defaultValue={room.roomType} aria-label="Room type">{Object.entries(ROOM_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <button className="btn-ghost text-xs" type="submit">Save</button>
              </form>
              <button className="mt-2 text-xs text-rose-600 underline" onClick={async () => { if (confirm(`Delete ${room.label}?`) && report(await deleteZoneAction(spaceId, room.id))) setSel(null); }}>Delete room</button>
            </div>
          </div>
        </div>
      )}

      <div>
        <p className="label">Uploads</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" data-testid="media-list">
          {media.filter((m) => m.kind !== "logo").slice(0, 48).map((m) => (
            <div key={m.id} className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100 text-[10px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {m.thumb ? <img src={m.thumb} alt="" className="aspect-[4/3] w-full object-cover" /> : <div className="grid aspect-[4/3] place-items-center uppercase text-slate-400">{m.kind}</div>}
              <div className={`px-1 py-0.5 ${m.status === "rejected" ? "bg-rose-50 text-rose-700" : m.status === "ready" ? "bg-white" : "bg-amber-50"}`} title={m.rejectReason ?? m.originalName ?? ""}>
                {m.inApp ? "📷 " : ""}{m.kind} · {m.status}{m.rejectReason ? `: ${m.rejectReason}` : ""}
                {m.warning && <span className="block text-amber-700" data-testid="media-warning">⚠ {m.warning}</span>}
              </div>
              {m.status === "ready" && (m.kind === "pano" || m.kind === "photo") && (
                <button className={`absolute left-1 top-1 rounded px-1 ${posterAssetId === m.id ? "bg-saffron text-white" : "bg-white/90"}`} onClick={async () => report(await setPosterAction(spaceId, m.id), "Cover image set")} aria-label="Use as cover">★</button>
              )}
              {m.status !== "rejected" && <button className="absolute right-1 top-1 rounded bg-white/90 px-1" aria-label="Remove" onClick={async () => report(await deleteMediaAction(spaceId, m.id))}>✕</button>}
            </div>
          ))}
        </div>
      </div>
      {msg && <p className="text-sm text-nazar" role="status" data-testid="editor-msg">{msg}</p>}
      {capturing && (
        <CaptureStudio
          spaceId={spaceId}
          rooms={rooms.map((r) => ({ id: r.id, label: r.label, roomType: r.roomType }))}
          initialRoomId={room?.id ?? null}
          onClose={() => {
            setCapturing(false);
            router.refresh();
          }}
          onUploaded={() => router.refresh()}
        />
      )}
    </section>
  );
}
