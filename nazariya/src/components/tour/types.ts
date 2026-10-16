import type { PlanPlacement } from "@/lib/floorplan";
import type { RoomDims } from "@/lib/pano-geometry";

export interface ViewerHotspot {
  id: string;
  type: string;
  yaw: number;
  pitch: number;
  position: [number, number, number] | null;
  title: string;
  body: string;
  targetZoneId: string | null;
  url?: string | null;
}

export interface ViewerZone {
  id: string;
  label: string;
  roomType: string;
  startYaw: number;
  splatStatus: string;
  splatNote: string | null;
  splatSource?: string | null;
  splatTransform?: { flip: boolean; yawDeg: number; scale: number; offset?: [number, number, number] } | null;
  pano: { url: string | null; mobileUrl: string | null; thumb: string | null; poster: string | null } | null;
  splat: { url: string | null; mobileUrl: string | null; splats: number | null; bytes: number | null } | null;
  photos: { id: string; url: string; thumb: string }[];
  hotspots: ViewerHotspot[];
  roomDims?: RoomDims;
  plan?: PlanPlacement | null;
}

export type Tier = "3d" | "360" | "photos";

export interface Capabilities {
  webgl: boolean;
  webgl2: boolean;
  lowMemory: boolean;
  saveData: boolean;
  mobile: boolean;
}

export function probeCapabilities(): Capabilities {
  let webgl = false;
  let webgl2 = false;
  try {
    const c = document.createElement("canvas");
    webgl2 = !!c.getContext("webgl2");
    webgl = webgl2 || !!c.getContext("webgl");
  } catch {}
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean; effectiveType?: string } };
  const mem = nav.deviceMemory;
  const conn = nav.connection;
  return {
    webgl,
    webgl2,
    lowMemory: typeof mem === "number" && mem < 3,
    saveData: !!conn?.saveData || ["slow-2g", "2g", "3g"].includes(conn?.effectiveType ?? ""),
    mobile: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || window.innerWidth < 640,
  };
}

export function bestTier(z: ViewerZone, caps: Capabilities): Tier {
  if (z.splat?.url && caps.webgl2 && !caps.saveData && !caps.lowMemory) return "3d";
  if (z.pano?.url && caps.webgl) return "360";
  return "photos";
}

export function availableTiers(z: ViewerZone, caps: Capabilities): Tier[] {
  const t: Tier[] = [];
  if (z.splat?.url && caps.webgl2) t.push("3d");
  if (z.pano?.url && caps.webgl) t.push("360");
  if (z.photos.length || z.pano?.poster) t.push("photos");
  return t;
}

let sessionId = "";
export function track(name: string, publicId: string, props: Record<string, unknown> = {}, surface = "share", zoneId?: string) {
  try {
    if (!sessionId) sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let referrer = "";
    try {
      referrer = window.top === window ? document.referrer : (document.referrer || (window.location.ancestorOrigins?.[0] ?? ""));
    } catch {}
    const body = JSON.stringify({ name, publicId, props, surface, zoneId, sessionId, referrer });
    if (!navigator.sendBeacon?.("/api/events", new Blob([body], { type: "application/json" }))) {
      void fetch("/api/events", { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true });
    }
  } catch {}
}
