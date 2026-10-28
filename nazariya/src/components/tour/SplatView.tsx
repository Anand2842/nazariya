"use client";
import { useEffect, useRef, useState } from "react";
import type { ViewerHotspot, ViewerZone } from "./types";

/**
 * 3D Gaussian-splat room view (three.js + Spark). The camera starts at the capture point; renters can look
 * around (drag), zoom (wheel/pinch) and step a little (WASD/arrow keys or the on-screen pad) to feel depth.
 * Movement is clamped to a small radius so the camera never leaves the reconstructed volume.
 */
export default function SplatView({
  zone,
  mobile,
  onHotspot,
  onProgress,
  onReady,
  onError,
  autoRotate = false,
  initialYaw,
  onView,
}: {
  zone: ViewerZone;
  mobile: boolean;
  autoRotate?: boolean;
  onHotspot: (h: ViewerHotspot) => void;
  onProgress?: (pct: number) => void;
  onReady?: (stats: { ms: number; splats: number | null }) => void;
  onError?: (reason: string) => void;
  initialYaw?: number | null;
  onView?: (yaw: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hsRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const move = useRef({ f: 0, r: 0 });
  const [loaded, setLoaded] = useState(false);
  const cb = useRef({ onHotspot, onProgress, onReady, onError, onView });
  cb.current = { onHotspot, onProgress, onReady, onError, onView };
  const startYaw = useRef(initialYaw ?? zone.startYaw);

  useEffect(() => {
    let disposed = false;
    const t0 = performance.now();
    let cleanup = () => {};
    let loadedRef = false;
    const timeout = setTimeout(() => {
      if (!disposed && !loadedRef) cb.current.onError?.("timeout");
    }, 30_000);
    (async () => {
      try {
        const url = (mobile ? zone.splat?.mobileUrl : zone.splat?.url) ?? zone.splat?.url;
        if (!url) throw new Error("no 3D scene");
        const [THREE, spark] = await Promise.all([import("three"), import("@sparkjsdev/spark")]);
        if (disposed || !canvasRef.current || !host.current) return;
        // Fetch with progress so slow connections see real feedback.
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`scene fetch failed (${res.status})`);
        const total = Number(res.headers.get("content-length")) || zone.splat?.bytes || 0;
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          if (total) cb.current.onProgress?.(Math.min(99, Math.round((received / total) * 100)));
          if (disposed) return;
        }
        const bytes = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) {
          bytes.set(c, off);
          off += c.byteLength;
        }
        const canvas = canvasRef.current;
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.25 : 1.75));
        const scene = new THREE.Scene();
        scene.background = new THREE.Color("#0b1220");
        const camera = new THREE.PerspectiveCamera(72, 1, 0.03, 60);
        camera.rotation.order = "YXZ";
        const sparkRenderer = new spark.SparkRenderer({ renderer });
        scene.add(sparkRenderer);
        const mesh = new spark.SplatMesh({ fileBytes: bytes, fileType: spark.SplatFileType.SPZ });
        scene.add(mesh);
        await mesh.initialized;
        const tf = zone.splatTransform ?? { flip: false, yawDeg: 0, scale: 1 };
        if (tf.flip) mesh.rotateX(Math.PI);
        if (tf.yawDeg) mesh.rotateY((tf.yawDeg * Math.PI) / 180);
        // Reconstructed scans: first made upright (align), then the editor's flip/rotate.
        if (tf.align) mesh.quaternion.multiply(new THREE.Quaternion(...tf.align));
        if (tf.scale && tf.scale !== 1) mesh.scale.setScalar(tf.scale);
        // Whole-home scans: start the camera at a chosen point of the scene (e.g. where the walkthrough began).
        if (tf.offset) {
          const o = new THREE.Vector3(...tf.offset).multiplyScalar(tf.scale || 1).applyQuaternion(mesh.quaternion);
          mesh.position.copy(o.negate());
        }
        // Reconstructed scans are only sharp near where the phone was: the walked path in viewer coordinates (x, z).
        mesh.updateMatrixWorld(true);
        const walk = (tf.path ?? []).map((p) => {
          const v = new THREE.Vector3(...p).applyMatrix4(mesh.matrixWorld);
          return [v.x, v.z] as const;
        });
        const PATH_R = 0.5;
        if (disposed) {
          renderer.dispose();
          return;
        }
        let yaw = startYaw.current;
        let lastReported = Infinity, lastReportAt = 0;
        let pitch = -0.05;
        // Portrait phones need a taller vertical FOV to keep a natural horizontal field of view.
        const portrait = host.current.clientHeight > host.current.clientWidth;
        let fov = portrait ? 95 : 72;
        const pos = new THREE.Vector3(0, 0, 0);
        // Panorama-derived scenes only look right near the capture point; real scans can be explored.
        const MAX_R = zone.splatSource === "generated_from_pano" || !zone.splatSource ? 0.6 : zone.roomType === "walkthrough" ? 30 : 8;
        let idle = 0;
        const resize = () => {
          const w = host.current!.clientWidth;
          const h = host.current!.clientHeight;
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(host.current);
        // Pointer look-around + pinch zoom.
        const pointers = new Map<number, { x: number; y: number }>();
        let pinchDist = 0;
        const onDown = (e: PointerEvent) => {
          canvas.setPointerCapture(e.pointerId);
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        };
        const onMove = (e: PointerEvent) => {
          const prev = pointers.get(e.pointerId);
          if (!prev) return;
          if (pointers.size === 1) {
            const k = (fov / 72) * (pointers.size === 1 && e.pointerType === "touch" ? 0.007 : 0.005);
            yaw -= (e.clientX - prev.x) * k;
            pitch = Math.max(-1.3, Math.min(1.3, pitch + (e.clientY - prev.y) * k));
          }
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            if (pinchDist) fov = Math.max(35, Math.min(110, fov * (pinchDist / d)));
            pinchDist = d;
          }
        };
        const onUp = (e: PointerEvent) => {
          pointers.delete(e.pointerId);
          if (pointers.size < 2) pinchDist = 0;
        };
        const onWheel = (e: WheelEvent) => {
          e.preventDefault();
          fov = Math.max(35, Math.min(110, fov + e.deltaY * 0.03));
        };
        const keys = new Set<string>();
        const onKey = (e: KeyboardEvent) => {
          if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
            if (e.type === "keydown") keys.add(e.code);
            else keys.delete(e.code);
          }
        };
        canvas.addEventListener("pointerdown", onDown);
        canvas.addEventListener("pointermove", onMove);
        canvas.addEventListener("pointerup", onUp);
        canvas.addEventListener("pointercancel", onUp);
        canvas.addEventListener("wheel", onWheel, { passive: false });
        window.addEventListener("keydown", onKey);
        window.addEventListener("keyup", onKey);
        const onLost = (e: Event) => {
          e.preventDefault();
          cb.current.onError?.("webgl_context_lost");
        };
        canvas.addEventListener("webglcontextlost", onLost);
        const v = new THREE.Vector3();
        const fwd = new THREE.Vector3();
        let last = performance.now();
        let firstFrame = true;
        renderer.setAnimationLoop(() => {
          const now = performance.now();
          const dt = Math.min(0.05, (now - last) / 1000);
          last = now;
          idle = pointers.size || keys.size || move.current.f || move.current.r ? 0 : idle + dt;
          if (autoRotate && idle > 3) yaw += dt * 0.12;
          const f = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) + move.current.f;
          const r = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0) + move.current.r;
          if (f || r) {
            pos.x += (Math.sin(yaw) * f + Math.cos(yaw) * r) * dt * 0.8;
            pos.z += (-Math.cos(yaw) * f + Math.sin(yaw) * r) * dt * 0.8;
            if (walk.length) {
              // Stay within PATH_R of the nearest point of the walk.
              let best = Infinity, bx = 0, bz = 0;
              for (const [x, z] of walk) {
                const d = (pos.x - x) ** 2 + (pos.z - z) ** 2;
                if (d < best) [best, bx, bz] = [d, x, z];
              }
              const d = Math.sqrt(best);
              if (d > PATH_R) {
                pos.x = bx + ((pos.x - bx) * PATH_R) / d;
                pos.z = bz + ((pos.z - bz) * PATH_R) / d;
              }
            } else {
              const len = Math.hypot(pos.x, pos.z);
              if (len > MAX_R) pos.multiplyScalar(MAX_R / len);
            }
          }
          camera.position.copy(pos);
          camera.rotation.set(pitch, -yaw, 0);
          if (now - lastReportAt > 120 && Math.abs(yaw - lastReported) > 0.01) {
            lastReportAt = now;
            lastReported = yaw;
            cb.current.onView?.(yaw);
          }
          camera.fov = fov;
          camera.updateProjectionMatrix();
          renderer.render(scene, camera);
          // Project hotspot anchors to screen space; hide those behind the camera.
          camera.getWorldDirection(fwd);
          const w = host.current?.clientWidth ?? 0;
          const h = host.current?.clientHeight ?? 0;
          for (const hs of zone.hotspots) {
            const node = hsRefs.current.get(hs.id);
            if (!node || !hs.position) continue;
            v.set(hs.position[0], hs.position[1], hs.position[2]);
            const toP = v.clone().sub(camera.position);
            if (toP.dot(fwd) <= 0.05) {
              node.style.display = "none";
              continue;
            }
            v.project(camera);
            node.style.display = "flex";
            node.style.transform = `translate(-50%,-50%) translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
          }
          if (firstFrame) {
            firstFrame = false;
            loadedRef = true;
            setLoaded(true);
            cb.current.onProgress?.(100);
            cb.current.onReady?.({ ms: Math.round(performance.now() - t0), splats: zone.splat?.splats ?? null });
          }
        });
        cleanup = () => {
          renderer.setAnimationLoop(null);
          ro.disconnect();
          canvas.removeEventListener("pointerdown", onDown);
          canvas.removeEventListener("pointermove", onMove);
          canvas.removeEventListener("pointerup", onUp);
          canvas.removeEventListener("pointercancel", onUp);
          canvas.removeEventListener("wheel", onWheel);
          canvas.removeEventListener("webglcontextlost", onLost);
          window.removeEventListener("keydown", onKey);
          window.removeEventListener("keyup", onKey);
          scene.remove(mesh);
          mesh.dispose();
          renderer.dispose();
        };
      } catch (err) {
        if (!disposed) cb.current.onError?.((err as Error).message);
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(timeout);
      cleanup();
    };
  }, [zone, mobile, autoRotate]);

  const hold = (f: number, r: number) => ({
    onPointerDown: () => (move.current = { f, r }),
    onPointerUp: () => (move.current = { f: 0, r: 0 }),
    onPointerLeave: () => (move.current = { f: 0, r: 0 }),
  });

  return (
    <div ref={host} className="relative h-full w-full touch-none select-none overflow-hidden" data-testid="splat-view" data-loaded={loaded ? "true" : "false"}>
      <canvas ref={canvasRef} className="h-full w-full" aria-label={`3D view of ${zone.label}`} />
      <div className="pointer-events-none absolute inset-0">
        {zone.hotspots
          .filter((h) => h.position)
          .map((h) => (
            <button
              key={h.id}
              ref={(n) => {
                if (n) hsRefs.current.set(h.id, n);
                else hsRefs.current.delete(h.id);
              }}
              type="button"
              onClick={() => cb.current.onHotspot(h)}
              className={`pointer-events-auto absolute left-0 top-0 hidden items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold text-white shadow-lg ${
                h.type === "door_to_zone" ? "bg-[var(--brand)]" : "bg-ink/90"
              }`}
            >
              {h.type === "door_to_zone" ? "➜" : h.type === "link" ? "↗" : "i"} {h.title}
            </button>
          ))}
      </div>
      {loaded && (
        <div className="absolute bottom-10 right-3 grid grid-cols-3 gap-1 opacity-80" aria-label="Step controls">
          <span />
          <button type="button" className="rounded-lg bg-white/85 px-2 py-1 text-sm" aria-label="Step forward" {...hold(1, 0)}>▲</button>
          <span />
          <button type="button" className="rounded-lg bg-white/85 px-2 py-1 text-sm" aria-label="Step left" {...hold(0, -1)}>◀</button>
          <button type="button" className="rounded-lg bg-white/85 px-2 py-1 text-sm" aria-label="Step back" {...hold(-1, 0)}>▼</button>
          <button type="button" className="rounded-lg bg-white/85 px-2 py-1 text-sm" aria-label="Step right" {...hold(0, 1)}>▶</button>
        </div>
      )}
    </div>
  );
}
