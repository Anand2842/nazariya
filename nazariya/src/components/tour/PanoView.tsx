"use client";
import { useEffect, useRef } from "react";
import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/markers-plugin/index.css";
import type { ViewerHotspot, ViewerZone } from "./types";

const HOTSPOT_COLOR: Record<string, string> = {
  door_to_zone: "var(--brand, #0f766e)",
  amenity: "#14213d",
  view: "#0369a1",
  info: "#14213d",
  link: "#14213d",
};

export function hotspotHtml(h: ViewerHotspot) {
  const icon = h.type === "door_to_zone" ? "➜" : h.type === "link" ? "↗" : h.type === "view" ? "◉" : "i";
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<div class="nz-hs" style="display:flex;align-items:center;gap:6px;background:${HOTSPOT_COLOR[h.type] ?? "#14213d"};color:#fff;border-radius:999px;padding:5px 10px 5px 6px;font:600 12px/1.2 system-ui;box-shadow:0 2px 8px rgba(0,0,0,.35);white-space:nowrap;cursor:pointer"><span style="display:inline-grid;place-items:center;width:18px;height:18px;border-radius:999px;background:rgba(255,255,255,.25)">${icon}</span>${esc(h.title)}</div>`;
}

export default function PanoView({
  zone,
  mobile,
  onHotspot,
  onReady,
  onError,
  pickMode,
  onPick,
  initialYaw,
  onView,
}: {
  zone: ViewerZone;
  mobile: boolean;
  onHotspot: (h: ViewerHotspot) => void;
  onReady?: () => void;
  onError?: (reason: string) => void;
  pickMode?: boolean;
  onPick?: (yaw: number, pitch: number) => void;
  initialYaw?: number | null;
  onView?: (yaw: number) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<unknown>(null);
  const cb = useRef({ onHotspot, onReady, onError, onPick, pickMode, onView });
  cb.current = { onHotspot, onReady, onError, onPick, pickMode, onView };
  // The arrival direction is only used when the room opens.
  const startYaw = useRef(initialYaw ?? zone.startYaw);

  useEffect(() => {
    let disposed = false;
    let viewer: { destroy(): void; addEventListener(t: string, f: (e: unknown) => void): void; getPlugin(p: unknown): unknown } | null = null;
    (async () => {
      try {
        const [{ Viewer }, { MarkersPlugin }] = await Promise.all([import("@photo-sphere-viewer/core"), import("@photo-sphere-viewer/markers-plugin")]);
        if (disposed || !el.current) return;
        const url = (mobile ? zone.pano?.mobileUrl : zone.pano?.url) ?? zone.pano?.url;
        if (!url) throw new Error("no panorama");
        viewer = new Viewer({
          container: el.current,
          panorama: url,
          defaultYaw: startYaw.current,
          defaultPitch: -0.05,
          defaultZoomLvl: 30,
          navbar: ["zoom", "fullscreen"],
          loadingTxt: "Loading 360° room…",
          mousewheelCtrlKey: false,
          touchmoveTwoFingers: false,
          plugins: [
            [
              MarkersPlugin,
              {
                markers: zone.hotspots.map((h) => ({
                  id: h.id,
                  position: { yaw: h.yaw, pitch: h.pitch },
                  html: hotspotHtml(h),
                  anchor: "center center",
                  data: h,
                })),
              },
            ],
          ],
        }) as unknown as typeof viewer;
        viewerRef.current = viewer;
        const markers = viewer!.getPlugin(MarkersPlugin) as { addEventListener(t: string, f: (e: { marker: { data: ViewerHotspot } }) => void): void };
        markers.addEventListener("select-marker", (e) => cb.current.onHotspot(e.marker.data));
        viewer!.addEventListener("ready", () => {
          cb.current.onReady?.();
          cb.current.onView?.(startYaw.current);
        });
        viewer!.addEventListener("position-updated", (e) => cb.current.onView?.((e as { position: { yaw: number } }).position.yaw));
        viewer!.addEventListener("click", (e) => {
          const d = (e as { data: { yaw: number; pitch: number; rightclick: boolean } }).data;
          if (cb.current.pickMode && !d.rightclick) cb.current.onPick?.(d.yaw, d.pitch);
        });
      } catch (err) {
        cb.current.onError?.((err as Error).message);
      }
    })();
    return () => {
      disposed = true;
      try {
        viewer?.destroy();
      } catch {}
    };
  }, [zone, mobile]);

  return <div ref={el} className="h-full w-full" data-testid="pano-view" />;
}
