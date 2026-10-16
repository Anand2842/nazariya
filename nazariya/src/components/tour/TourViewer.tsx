"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ROOM_TYPES } from "@/lib/catalog";
import { arrivalYaw } from "@/lib/floorplan";
import { FloorPlanMap, placedRooms, type PlanRoom } from "./FloorPlanMap";
import { availableTiers, bestTier, probeCapabilities, track, type Capabilities, type Tier, type ViewerHotspot, type ViewerZone } from "./types";

const PanoView = dynamic(() => import("./PanoView"), { ssr: false });
const SplatView = dynamic(() => import("./SplatView"), { ssr: false });

const TIER_LABEL: Record<Tier, string> = { "3d": "3D", "360": "360°", photos: "Photos" };

export interface ViewerBranding {
  primaryColor: string;
  logoUrl: string | null;
  showPoweredBy: boolean;
  orgName: string;
}

export interface ViewerSettings {
  defaultTier: string;
  showRoomList: boolean;
  autoRotate: boolean;
  showFloorPlan?: boolean;
}

type Surface = "embed" | "share" | "studio_preview";

/** Messages to the host page (when embedded in an iframe). */
function emit(type: string, data: Record<string, unknown> = {}) {
  try {
    if (window.parent !== window) window.parent.postMessage({ source: "nazariya", type, ...data }, "*");
  } catch {}
}

export function TourViewer({
  publicId,
  title,
  zones,
  posterUrl,
  branding,
  settings,
  surface,
  initialZoneId,
  forceTier,
  autoStart = false,
  className = "",
}: {
  publicId: string;
  title: string;
  zones: ViewerZone[];
  posterUrl: string | null;
  branding: ViewerBranding;
  settings: ViewerSettings;
  surface: Surface;
  initialZoneId?: string | null;
  forceTier?: Tier | null;
  autoStart?: boolean;
  className?: string;
}) {
  const [started, setStarted] = useState(false);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [zoneIdx, setZoneIdx] = useState(() => Math.max(0, zones.findIndex((z) => z.id === initialZoneId)));
  const [tier, setTier] = useState<Tier>("photos");
  const [progress, setProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hotspot, setHotspot] = useState<ViewerHotspot | null>(null);
  const [photoIdx, setPhotoIdx] = useState(0);
  const openedAt = useRef(0);
  const zone = zones[zoneIdx];
  // House tour: floor plan, heading continuity between rooms, short fade on room change.
  const [viewYaw, setViewYaw] = useState<number | null>(null);
  const [arrival, setArrival] = useState<number | null>(null);
  const [fading, setFading] = useState(false);
  const planRooms: PlanRoom[] = useMemo(
    () => zones.map((z) => ({ id: z.id, label: z.label, dims: z.roomDims ?? { w: 4, d: 4.5, h: 2.9, camH: 1.5 }, plan: z.plan ?? null, doors: z.hotspots.filter((h) => h.type === "door_to_zone").map((h) => ({ targetZoneId: h.targetZoneId, yaw: h.yaw })) })),
    [zones],
  );
  const hasPlan = settings.showFloorPlan !== false && placedRooms(planRooms).length >= 2;
  const [showMap, setShowMap] = useState(true);
  const t = useCallback((name: string, props: Record<string, unknown> = {}, zoneId?: string) => surface !== "studio_preview" && track(name, publicId, props, surface, zoneId), [publicId, surface]);

  const tiers = useMemo(() => (zone && caps ? availableTiers(zone, caps) : []), [zone, caps]);

  const pickTier = useCallback(
    (z: ViewerZone, c: Capabilities): Tier => {
      const wanted = forceTier ?? (settings.defaultTier !== "auto" ? (settings.defaultTier as Tier) : null);
      if (wanted && availableTiers(z, c).includes(wanted)) return wanted;
      return bestTier(z, c);
    },
    [forceTier, settings.defaultTier],
  );

  const start = useCallback(
    (idx = zoneIdx) => {
      const c = probeCapabilities();
      if (forceTier === "photos") c.webgl = c.webgl2 = false; // test hook: simulate a device without WebGL
      setCaps(c);
      setStarted(true);
      openedAt.current = performance.now();
      const tr = pickTier(zones[idx], c);
      setTier(tr);
      t("tour_open", { tier: tr, webgl2: c.webgl2, mobile: c.mobile, saveData: c.saveData }, zones[idx].id);
      emit("start", { room: zones[idx].label, tier: tr });
    },
    [forceTier, pickTier, t, zoneIdx, zones],
  );

  useEffect(() => {
    emit("ready", { space: publicId, title, rooms: zones.map((z) => ({ id: z.id, label: z.label })) });
    if (autoStart || (initialZoneId && zones.some((z) => z.id === initialZoneId))) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goZone = useCallback(
    (idx: number, opts: { arrivalYaw?: number | null } = {}) => {
      if (idx < 0 || idx >= zones.length || idx === zoneIdx) return;
      setArrival(opts.arrivalYaw ?? null);
      setViewYaw(opts.arrivalYaw ?? zones[idx].startYaw);
      setFading(true);
      setTimeout(() => setFading(false), 350);
      if (!started || !caps) {
        setZoneIdx(idx);
        start(idx);
        emit("roomchange", { id: zones[idx].id, label: zones[idx].label, index: idx });
        return;
      }
      setZoneIdx(idx);
      setPhotoIdx(0);
      setHotspot(null);
      setProgress(null);
      setNotice(null);
      const z = zones[idx];
      const next = availableTiers(z, caps).includes(tier) ? tier : pickTier(z, caps);
      setTier(next);
      t("zone_view", { tier: next }, z.id);
      emit("roomchange", { id: z.id, label: z.label, index: idx });
    },
    [caps, pickTier, start, started, t, tier, zoneIdx, zones],
  );

  // Commands from the host page (SDK): goToRoom, setView, start.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { target?: string; command?: string; room?: string | number; view?: Tier };
      if (!d || d.target !== "nazariya") return;
      if (d.command === "start") start();
      if (d.command === "goToRoom" && d.room !== undefined) {
        const idx = typeof d.room === "number" ? d.room : zones.findIndex((z) => z.id === d.room || z.label.toLowerCase() === String(d.room).toLowerCase());
        if (idx >= 0) goZone(idx);
      }
      if (d.command === "setView" && d.view && tiers.includes(d.view)) setTier(d.view);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [goZone, start, tiers, zones]);

  const fallback = useCallback(
    (reason: string) => {
      if (!caps || !zone) return;
      const order: Tier[] = tier === "3d" ? ["360", "photos"] : ["photos"];
      const next = order.find((x) => availableTiers(zone, caps).includes(x)) ?? "photos";
      t("tour_fallback", { from: tier, to: next, reason }, zone.id);
      emit("error", { reason, fallback: next });
      setNotice(tier === "3d" ? "3D view isn't supported on this device, showing the 360° view." : "Showing photos instead.");
      setProgress(null);
      setTier(next);
    },
    [caps, t, tier, zone],
  );

  const onHotspot = useCallback(
    (h: ViewerHotspot) => {
      t("hotspot_open", { type: h.type, title: h.title }, zone?.id);
      emit("hotspotclick", { id: h.id, type: h.type, title: h.title, url: h.url ?? null });
      if (h.type === "door_to_zone" && h.targetZoneId) {
        const idx = zones.findIndex((z) => z.id === h.targetZoneId);
        // Walking through a door keeps facing the same real-world direction (when both rooms are on the plan).
        const a = zone?.plan, b = zones[idx]?.plan;
        if (idx >= 0) return goZone(idx, { arrivalYaw: a && b ? arrivalYaw(h.yaw, a, b) : null });
      }
      if (h.type === "link" && h.url) {
        window.open(h.url, "_blank", "noopener,noreferrer");
        return;
      }
      setHotspot(h);
    },
    [goZone, t, zone, zones],
  );

  const style = { "--brand": branding.primaryColor } as React.CSSProperties;

  if (!zones.length) {
    return (
      <div className={`grid h-full min-h-[320px] place-items-center bg-slate-900 text-slate-300 ${className}`} style={style} data-testid="tour-empty">
        This tour has no rooms yet
      </div>
    );
  }

  const photos = zone.photos.length ? zone.photos : zone.pano?.poster ? [{ id: "poster", url: zone.pano.poster, thumb: zone.pano.poster }] : [];

  return (
    <div className={`relative flex h-full min-h-[320px] w-full flex-col overflow-hidden bg-ink text-white ${className}`} style={style} data-testid="tour-viewer">
      <div className="relative min-h-0 flex-1">
        {!started ? (
          <button type="button" onClick={() => start()} className="group absolute inset-0 h-full w-full" data-testid="tour-start" aria-label={`Start the tour of ${title}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {posterUrl && <img src={posterUrl} alt="" className="h-full w-full object-cover" fetchPriority="high" />}
            <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/20" />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full px-6 py-3 text-sm font-bold text-white shadow-xl transition group-hover:scale-105" style={{ background: "var(--brand)" }}>
              ▶ Explore in 3D
            </span>
            <span className="absolute bottom-4 left-4 text-left">
              <span className="block text-lg font-bold drop-shadow">{title}</span>
              <span className="text-sm text-white/85">
                {zones.length} room{zones.length > 1 ? "s" : ""} · {zones.some((z) => z.splat?.url) ? "3D + 360°" : zones.some((z) => z.pano?.url) ? "360°" : "photos"}
              </span>
            </span>
          </button>
        ) : tier === "3d" ? (
          <SplatView
            key={`3d-${zone.id}`}
            zone={zone}
            initialYaw={arrival}
            onView={setViewYaw}
            mobile={!!caps?.mobile}
            autoRotate={settings.autoRotate}
            onHotspot={onHotspot}
            onProgress={setProgress}
            onReady={(s) => {
              setProgress(null);
              t("tour_first_render", { tier: "3d", ms: Math.round(performance.now() - openedAt.current), splats: s.splats }, zone.id);
            }}
            onError={fallback}
          />
        ) : tier === "360" ? (
          <PanoView
            key={`360-${zone.id}`}
            zone={zone}
            initialYaw={arrival}
            onView={setViewYaw}
            mobile={!!caps?.mobile}
            onHotspot={onHotspot}
            onReady={() => t("tour_first_render", { tier: "360", ms: Math.round(performance.now() - openedAt.current) }, zone.id)}
            onError={fallback}
          />
        ) : (
          <div className="flex h-full flex-col bg-black" data-testid="photo-view">
            <div className="relative min-h-0 flex-1">
              {photos[photoIdx] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photos[photoIdx].url} alt={`${zone.label}, photo ${photoIdx + 1}`} className="h-full w-full object-contain" />
              ) : (
                <div className="grid h-full place-items-center text-white/70">No photos for this room</div>
              )}
            </div>
            {photos.length > 1 && (
              <div className="flex gap-1 overflow-x-auto bg-black/80 p-1.5">
                {photos.map((p, i) => (
                  <button key={p.id} type="button" onClick={() => setPhotoIdx(i)} className={`h-11 w-16 shrink-0 overflow-hidden rounded ${i === photoIdx ? "ring-2 ring-white" : "opacity-60"}`} aria-label={`Photo ${i + 1}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.thumb} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Top bar: branding + view switch */}
        {started && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2">
            <div className="pointer-events-auto flex items-center gap-2 rounded-xl bg-black/45 px-2.5 py-1.5 backdrop-blur">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {branding.logoUrl && <img src={branding.logoUrl} alt={branding.orgName} className="h-5 max-w-[120px] object-contain" />}
              <span className="max-w-[45vw] truncate text-xs font-semibold" data-testid="current-room">{zone.label}</span>
            </div>
            <div className="pointer-events-auto flex gap-1 rounded-xl bg-black/45 p-1 backdrop-blur" role="tablist" aria-label="View mode">
              {(["3d", "360", "photos"] as Tier[]).map((x) => (
                <button
                  key={x}
                  type="button"
                  role="tab"
                  aria-selected={tier === x}
                  disabled={!tiers.includes(x)}
                  onClick={() => {
                    setNotice(null);
                    setTier(x);
                    t("tier_switch", { to: x }, zone.id);
                    emit("viewchange", { view: x });
                  }}
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${tier === x ? "bg-white text-ink" : "text-white disabled:opacity-30"}`}
                  data-testid={`tier-${x}`}
                >
                  {TIER_LABEL[x]}
                </button>
              ))}
            </div>
          </div>
        )}
        {started && hasPlan && (
          <div className="absolute right-2 top-12 flex flex-col items-end gap-1" data-testid="minimap" data-heading={viewYaw ?? ""}>
            <button type="button" onClick={() => setShowMap((v) => !v)} className="rounded-lg bg-black/45 px-2 py-1 text-[11px] font-semibold backdrop-blur" aria-expanded={showMap} data-testid="minimap-toggle">
              {showMap ? "Hide plan" : "Floor plan"}
            </button>
            {showMap && (
              <FloorPlanMap
                rooms={planRooms}
                currentId={zone.id}
                headingYaw={viewYaw}
                className="h-32 w-32 rounded-xl bg-black/55 p-1 text-white backdrop-blur sm:h-44 sm:w-44"
                testId="minimap-plan"
                onRoomClick={(id) => {
                  const idx = zones.findIndex((z) => z.id === id);
                  const a = zone.plan, b = zones[idx]?.plan;
                  goZone(idx, { arrivalYaw: a && b && viewYaw != null ? arrivalYaw(viewYaw, a, b) : null });
                }}
              />
            )}
          </div>
        )}
        <div className={`pointer-events-none absolute inset-0 bg-black transition-opacity duration-300 ${fading ? "opacity-100" : "opacity-0"}`} aria-hidden />
        {progress !== null && progress < 100 && started && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/40" data-testid="tour-loading">
            <div className="rounded-xl bg-white/95 px-4 py-3 text-sm font-semibold text-ink shadow">Loading 3D room… {progress}%</div>
          </div>
        )}
        {notice && started && (
          <div className="absolute left-2 top-12 max-w-[70%] rounded-lg bg-amber-100 px-3 py-1.5 text-xs text-amber-900" data-testid="tour-notice">{notice}</div>
        )}
        {hotspot && (
          <div className="absolute inset-x-2 bottom-2 rounded-xl bg-white p-3 text-sm text-ink shadow-xl sm:left-auto sm:w-80" role="dialog" aria-label={hotspot.title} data-testid="hotspot-card">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold">{hotspot.title}</p>
              <button type="button" className="text-slate-400" onClick={() => setHotspot(null)} aria-label="Close">✕</button>
            </div>
            {hotspot.body && <p className="mt-1 text-slate-600">{hotspot.body}</p>}
          </div>
        )}
        {started && tier === "3d" && (
          <p className="pointer-events-none absolute bottom-2 right-2 hidden rounded bg-black/40 px-2 py-0.5 text-[10px] text-white/80 sm:block">
            Drag to look · scroll to zoom · WASD to move
          </p>
        )}
        {branding.showPoweredBy && (
          <a href="https://nazariya.app" target="_blank" rel="noreferrer" className="absolute bottom-2 left-2 rounded bg-black/45 px-2 py-0.5 text-[10px] font-medium text-white/85 backdrop-blur" data-testid="powered-by" style={{ bottom: started && settings.showRoomList ? undefined : "0.5rem" }}>
            Powered by Nazariya
          </a>
        )}
      </div>
      {settings.showRoomList && zones.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto bg-black/85 p-1.5" role="tablist" aria-label="Rooms" data-testid="room-list">
          {zones.map((z, i) => (
            <button
              key={z.id}
              type="button"
              role="tab"
              aria-selected={i === zoneIdx}
              onClick={() => (!started ? (setZoneIdx(i), start(i), emit("roomchange", { id: z.id, label: z.label, index: i })) : goZone(i))}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-xs ${i === zoneIdx ? "bg-white/20 ring-1 ring-white/60" : "hover:bg-white/10"}`}
            >
              {z.pano?.thumb || z.photos[0]?.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={(z.pano?.thumb ?? z.photos[0]?.thumb)!} alt="" className="h-7 w-11 rounded object-cover" />
              ) : null}
              <span>
                <span className="block font-semibold">{z.label}</span>
                <span className="text-white/60">{ROOM_TYPES[z.roomType] ?? z.roomType}{z.splat?.url ? " · 3D" : z.pano?.url ? " · 360°" : ""}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
