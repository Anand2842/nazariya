"use client";
// Depth-mode capture (WebXR AR): the 360° guide with real phone position, room measurement from depth, and a
// house walk-through — capture a room, walk through the door, capture the next — so rooms land on the floor
// plan with doors between them automatically.
import { useEffect, useMemo, useRef, useState } from "react";
import { RING_ORDER, RING_TEXT } from "@/lib/capture-guides";
import { ROOM_TYPES } from "@/lib/catalog";
import { angleBetween, nextTarget, panoTargets, targetDir, type Target } from "@/lib/orientation";
import type { Vec3 } from "@/lib/pano-geometry";
import { intrinsicsFromProjection, poseFromMatrix, rotY, yawOfDir } from "@/lib/xr-pose";
import { uploadForm } from "./capture-utils";
import { imageDataToJpeg, startArSession, type ArFrame, type ArSession } from "./xr";

interface Room {
  id: string;
  label: string;
  roomType: string;
}

const R2D = 180 / Math.PI;
const AIM_DEG = 2.5;
const STILL_DEG = 0.6;
const HOLD_MS = 350;
const MAX_ROLL_DEG = 6;
const PIVOT_M = 0.08; // the lens may wander this far from the capture point
const MAX_POINTS = 300_000;

interface Shot {
  target: number;
  blob: Blob;
  m: number[];
  w: number;
  h: number;
  projection: number[];
}

export function ArCapture({
  spaceId,
  rooms: initialRooms,
  initialRoomId,
  token,
  onFallback,
  onFinished,
  done = null,
}: {
  spaceId: string;
  rooms: Room[];
  initialRoomId: string | null;
  token: string | null;
  onFallback: (reason: string) => void;
  onFinished: (msg: string) => void;
  done?: string | null;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const ar = useRef<ArSession | null>(null);
  const [phase, setPhase] = useState<"intro" | "starting" | "ready" | "capturing" | "uploading" | "walking">("intro");
  const [features, setFeatures] = useState<ArSession["features"] | null>(null);
  const [rooms, setRooms] = useState(initialRooms);
  const [roomId, setRoomId] = useState(initialRoomId ?? initialRooms[0]?.id ?? "");
  const [shots, setShots] = useState<Shot[]>([]);
  const shotsRef = useRef<Shot[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [captured, setCaptured] = useState<string[]>([]); // room labels done in this session
  const [newRoom, setNewRoom] = useState({ label: "", roomType: "bedroom" });
  const sessionId = useMemo(() => crypto.randomUUID(), []); // AR requires a secure context, where this exists
  const targets = useMemo(() => panoTargets(), []);
  const frameRef = useRef<ArFrame | null>(null);
  const history = useRef<{ t: number; f: Vec3; u: Vec3 }[]>([]);
  const capturePoint = useRef<Vec3 | null>(null);
  const headingRef = useRef(0);
  const lastYaw = useRef<number | null>(null);
  const holdSince = useRef<number | null>(null);
  const busy = useRef(false);
  const points = useRef<Float32Array[]>([]);
  const pointCount = useRef(0);
  const path = useRef<[number, number, number][]>([]);
  // Path 2: keyframes with poses while walking (for true 3D on a GPU worker).
  const [recordWalk, setRecordWalk] = useState(true);
  const recordRef = useRef(recordWalk);
  recordRef.current = recordWalk;
  const kf = useRef<{ queue: { blob: Blob; m: number[]; w: number; h: number; projection: number[] }[]; sent: number; last: { p: Vec3; f: Vec3 } | null; busy: boolean }>({ queue: [], sent: 0, last: null, busy: false });
  const [kfCount, setKfCount] = useState(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [hud, setHud] = useState<{ next: { x: number; y: number; on: boolean; aim: number } | null; nextId: number | null; arrow: number | null; drift: number; roll: number; hold: number; pts: number; limited: boolean }>({ next: null, nextId: null, arrow: null, drift: 0, roll: 0, hold: 0, pts: 0, limited: false });

  useEffect(() => () => void ar.current?.end(), []);

  const addPoints = (p: Float32Array | null) => {
    if (!p?.length || pointCount.current >= MAX_POINTS) return;
    points.current.push(p);
    pointCount.current += p.length / 3;
  };

  const doCapture = async (t: Target) => {
    const s = ar.current;
    if (!s || busy.current) return;
    busy.current = true;
    try {
      const [{ frame, image }, depth] = await Promise.all([s.captureImage(1600), s.features.depth ? s.sampleDepth(64, 48) : Promise.resolve(null)]);
      if (!image) throw new Error("This phone did not provide the camera image");
      addPoints(depth);
      const blob = await imageDataToJpeg(image);
      const shot: Shot = { target: t.id, blob, m: Array.from(frame.matrix), w: image.width, h: image.height, projection: Array.from(frame.projection) };
      shotsRef.current = [...shotsRef.current, shot];
      setShots(shotsRef.current);
      lastYaw.current = t.yaw;
      try {
        navigator.vibrate?.(30);
      } catch {}
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      holdSince.current = null;
      setTimeout(() => (busy.current = false), 350);
    }
  };

  const onFrame = (f: ArFrame) => {
    frameRef.current = f;
    const now = performance.now();
    const pose = poseFromMatrix(f.matrix);
    const h = history.current;
    h.push({ t: now, f: pose.basis.forward, u: pose.basis.up });
    while (h.length && h[0].t < now - 1000) h.shift();
    const ph = phaseRef.current;
    // Walking between rooms: record the path (for doors on the floor plan).
    if (ph === "walking" || ph === "ready") {
      const last = path.current[path.current.length - 1];
      const p = pose.position;
      if (!f.limited && (!last || Math.hypot(p[0] - last[0], p[2] - last[2]) > 0.05) && path.current.length < 5000) path.current.push([p[0], p[1], p[2]]);
    }
    if (ph === "walking" && recordRef.current && !f.limited) maybeKeyframe(pose, now);
    if (ph !== "capturing") return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const W = overlay.clientWidth, H = overlay.clientHeight, P = f.projection;
    const fwdRoom = rotY(pose.basis.forward, -headingRef.current);
    const done = new Set(shotsRef.current.map((s) => s.target));
    const nt = nextTarget(targets, done, lastYaw.current, yawOfDir(fwdRoom));
    const cp = capturePoint.current!;
    const drift = Math.hypot(pose.position[0] - cp[0], pose.position[1] - cp[1], pose.position[2] - cp[2]);
    // Roll: world-up projected into the image plane.
    const roll = Math.atan2(pose.basis.right[1], pose.basis.up[1]) * R2D;
    const recent = h.filter((x) => x.t >= now - 300);
    const latest = h[h.length - 1];
    const wander = recent.length < 3 ? Infinity : Math.max(...recent.map((x) => Math.max(angleBetween(x.f, latest.f), angleBetween(x.u, latest.u)))) * R2D;
    let next = null, arrow = null, hold = 0;
    if (nt) {
      const d = rotY(targetDir(nt), headingRef.current);
      const xc = d[0] * pose.basis.right[0] + d[1] * pose.basis.right[1] + d[2] * pose.basis.right[2];
      const yc = d[0] * pose.basis.up[0] + d[1] * pose.basis.up[1] + d[2] * pose.basis.up[2];
      const zc = d[0] * pose.basis.forward[0] + d[1] * pose.basis.forward[1] + d[2] * pose.basis.forward[2];
      const aim = angleBetween(d, pose.basis.forward) * R2D;
      let on = false, x = 0, y = 0;
      if (zc > 0.15) {
        const nx = (P[0] * xc) / zc - P[8], ny = (P[5] * yc) / zc - P[9];
        x = ((nx + 1) / 2) * W;
        y = ((1 - ny) / 2) * H;
        on = x > 0 && x < W && y > 0 && y < H;
      }
      next = { x, y, on, aim };
      if (!on) arrow = Math.atan2(-yc, xc) * R2D;
      const ok = aim <= AIM_DEG && Math.abs(roll) <= MAX_ROLL_DEG && wander <= STILL_DEG && drift <= PIVOT_M + 0.02 && !f.limited;
      if (ok) {
        holdSince.current ??= now;
        hold = Math.min(1, (now - holdSince.current) / HOLD_MS);
        if (hold >= 1 && !busy.current) void doCapture(nt);
      } else holdSince.current = null;
    }
    setHud({ next, nextId: nt?.id ?? null, arrow, drift, roll, hold, pts: pointCount.current, limited: f.limited });
  };

  const flushKeyframes = async () => {
    const q = kf.current.queue.splice(0);
    if (!q.length) return;
    const k = intrinsicsFromProjection(q[0].projection, q[0].w, q[0].h);
    const fd = new FormData();
    fd.set("spaceId", spaceId);
    fd.set("meta", JSON.stringify({ sessionId, intrinsics: { fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy, width: k.width, height: k.height }, frames: q.map((x) => ({ m: x.m })) }));
    q.forEach((x, i) => fd.set(`kf_${i}`, new File([x.blob], `kf_${i}.jpg`, { type: "image/jpeg" })));
    const r = await uploadForm("/api/captures/ar-walk", fd, token);
    if (r.ok) kf.current.sent += q.length;
  };

  const maybeKeyframe = (pose: ReturnType<typeof poseFromMatrix>, now: number) => {
    const k = kf.current;
    if (k.busy || !ar.current) return;
    const last = k.last;
    const moved = last ? Math.hypot(pose.position[0] - last.p[0], pose.position[1] - last.p[1], pose.position[2] - last.p[2]) : Infinity;
    const turned = last ? angleBetween(pose.basis.forward, last.f) * R2D : Infinity;
    if (moved < 0.3 && turned < 15) return;
    // Skip while turning fast (motion blur).
    const recent = history.current.filter((x) => x.t >= now - 150);
    if (recent.length >= 2 && angleBetween(recent[0].f, recent[recent.length - 1].f) * R2D > 3) return;
    k.busy = true;
    k.last = { p: pose.position, f: pose.basis.forward };
    void ar.current
      .captureImage(960)
      .then(async ({ frame, image }) => {
        if (!image) return;
        k.queue.push({ blob: await imageDataToJpeg(image, 0.85), m: Array.from(frame.matrix), w: image.width, h: image.height, projection: Array.from(frame.projection) });
        setKfCount((c) => c + 1);
        if (k.queue.length >= 8) await flushKeyframes();
      })
      .finally(() => (k.busy = false));
  };

  const start = async () => {
    setErr(null);
    setPhase("starting");
    try {
      const s = await startArSession(overlayRef.current!);
      if (!s.features.camera) {
        await s.end();
        onFallback("This phone supports AR tracking but not camera access in the browser, so the standard 360° capture is used.");
        return;
      }
      ar.current = s;
      setFeatures(s.features);
      s.onFrame(onFrame);
      s.onEnd(() => {
        ar.current = null;
        setPhase((p) => (p === "uploading" ? p : "intro"));
      });
      // Background depth sampling while capturing (denser samples are taken with each photo).
      const tick = async () => {
        if (!ar.current) return;
        if (phaseRef.current === "capturing" && s.features.depth) addPoints(await s.sampleDepth(32, 24));
        setTimeout(tick, 300);
      };
      void tick();
      setPhase("ready");
    } catch (e) {
      setPhase("intro");
      onFallback(`Depth mode could not start (${(e as Error).message}). Using the standard 360° capture.`);
    }
  };

  const beginRoom = () => {
    const f = frameRef.current;
    if (!f || !roomId) return;
    const pose = poseFromMatrix(f.matrix);
    capturePoint.current = pose.position;
    headingRef.current = yawOfDir(pose.basis.forward);
    lastYaw.current = null;
    shotsRef.current = [];
    setShots([]);
    points.current = [];
    pointCount.current = 0;
    setMsg(null);
    setPhase("capturing");
  };

  const finishRoom = async () => {
    const list = shotsRef.current;
    if (!list.length) return;
    setPhase("uploading");
    const first = list[0];
    const k = intrinsicsFromProjection(first.projection, first.w, first.h);
    const total = points.current.reduce((a, p) => a + p.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const p of points.current) {
      all.set(p, o);
      o += p.length;
    }
    const fd = new FormData();
    fd.set("spaceId", spaceId);
    fd.set("zoneId", roomId);
    fd.set(
      "meta",
      JSON.stringify({
        sessionId,
        device: navigator.userAgent.slice(0, 280),
        intrinsics: { fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy, width: k.width, height: k.height },
        frames: list.map((s) => ({ m: s.m, target: s.target })),
        path: path.current,
        depth: !!features?.depth && total > 0,
        diag: { depth: !!features?.depth, localFloor: !!features?.localFloor, points: total / 3 },
      }),
    );
    list.forEach((s, i) => fd.set(`frame_${i}`, new File([s.blob], `frame_${i}.jpg`, { type: "image/jpeg" })));
    if (total) fd.set("points", new File([all.buffer], "points.f32", { type: "application/octet-stream" }));
    const r = await uploadForm("/api/captures/ar-room", fd, token);
    if (!r.ok) {
      setErr(r.data.error ?? "Upload failed");
      setPhase("capturing");
      return;
    }
    const label = rooms.find((x) => x.id === roomId)?.label ?? "Room";
    setCaptured((c) => [...c, label]);
    path.current = [];
    setMsg(`${label} uploaded${features?.depth ? " and will be measured" : ""}. Walk through the door to the next room, stand in its middle, choose it below and tap “Start here”. Or finish.`);
    const nextRoom = rooms.find((x) => x.id !== roomId && !captured.includes(x.label));
    if (nextRoom) setRoomId(nextRoom.id);
    setPhase("walking");
  };

  const createRoom = async () => {
    if (!newRoom.label.trim()) return;
    const res = await fetch("/api/captures/rooms", { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-capture-token": token } : {}) }, body: JSON.stringify({ spaceId, ...newRoom }) });
    const d = (await res.json()) as { room?: Room; error?: string };
    if (!res.ok || !d.room) return setErr(d.error ?? "Could not add the room");
    setRooms((rs) => [...rs, d.room!]);
    setRoomId(d.room.id);
    setNewRoom({ label: "", roomType: newRoom.roomType });
  };

  const end = async () => {
    await ar.current?.end();
    await flushKeyframes();
    // Build the 3D walkthrough dataset from everything recorded in this session.
    if (kf.current.sent > 0 || captured.length > 0) {
      await fetch("/api/captures/ar-walk/finish", { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-capture-token": token } : {}) }, body: JSON.stringify({ spaceId, sessionId }) }).catch(() => {});
    }
    onFinished(captured.length ? `${captured.length} room${captured.length > 1 ? "s" : ""} captured in depth mode (${captured.join(", ")}). They are measured, placed on the floor plan and connected automatically.` : "Depth mode closed.");
  };

  const doneIds = new Set(shots.map((s) => s.target));
  const canFinish = targets.filter((t) => t.ring === "horizon").every((t) => doneIds.has(t.id)) && shots.length >= 20;
  const ring = RING_ORDER.find((r) => targets.some((t) => t.ring === r && !doneIds.has(t.id)));
  const aligned = !!hud.next && hud.next.aim <= AIM_DEG;
  const room = rooms.find((r) => r.id === roomId);

  return (
    <div ref={overlayRef} className="relative flex min-h-0 flex-1 flex-col text-white" data-testid="ar-capture">
      {phase === "intro" || phase === "starting" ? (
        <div className="flex-1 overflow-y-auto p-5" data-testid="ar-intro">
          {done && <div className="mb-4 rounded-xl bg-emerald-500/20 p-3 text-sm text-emerald-100" data-testid="capture-done">{done}</div>}
          <p className="text-xs uppercase tracking-wide text-emerald-300">📐 Depth mode available on this phone</p>
          <h2 className="mt-1 text-2xl font-extrabold">Measure and capture the whole home</h2>
          <ul className="mt-3 space-y-2 text-sm text-white/85">
            <li>• Uses the phone&apos;s AR tracking and depth: the room is <b>measured</b> (width, length, height) and the 3D uses its real shape.</li>
            <li>• Capture a room, walk through the door to the next one, capture it: rooms are <b>placed on the floor plan and connected by doors</b> automatically.</li>
            <li>• Same 30 dots as before. The app also tells you if the phone drifts away from the spot.</li>
          </ul>
          <button type="button" disabled={phase === "starting"} onClick={start} className="mt-6 w-full rounded-2xl bg-emerald-400 py-4 text-base font-bold text-ink disabled:opacity-50" data-testid="ar-start">
            {phase === "starting" ? "Starting…" : "Start depth mode"}
          </button>
          <button type="button" onClick={() => onFallback("")} className="mt-3 w-full rounded-2xl bg-white/10 py-3 text-sm" data-testid="ar-use-standard">
            Use the standard 360° capture instead
          </button>
          {err && <p className="mt-3 rounded bg-rose-600 p-2 text-sm">{err}</p>}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1" data-testid="ar-live">
          {/* The camera view is drawn by the browser behind this overlay. */}
          {phase === "capturing" && hud.next?.on && (
            <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: hud.next.x, top: hud.next.y, width: 34, height: 34, background: aligned ? "#34d399" : "#f59e0b", boxShadow: "0 0 0 4px rgba(0,0,0,.35)" }} data-testid="ar-next-dot" />
          )}
          {phase === "capturing" && (
            <svg className="pointer-events-none absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2" viewBox="0 0 96 96">
              <circle cx="48" cy="48" r="36" fill="none" stroke={aligned ? "#34d399" : "rgba(255,255,255,.85)"} strokeWidth="3" />
              <circle cx="48" cy="48" r="36" fill="none" stroke="#34d399" strokeWidth="7" strokeDasharray={`${hud.hold * 226.2} 226.2`} transform="rotate(-90 48 48)" />
            </svg>
          )}
          {phase === "capturing" && hud.arrow !== null && (
            <div className="pointer-events-none absolute left-1/2 top-1/2 h-0 w-0" style={{ transform: `rotate(${hud.arrow}deg)` }}>
              <div className="absolute left-16 -top-5 text-4xl text-amber-400">➤</div>
            </div>
          )}
          <div className="absolute inset-x-2 top-2 flex flex-wrap items-center gap-1 text-[11px] font-semibold">
            <span className={`rounded-full px-2.5 py-1 ${features?.depth ? "bg-emerald-500/90" : "bg-amber-500/90 text-ink"}`} data-testid="ar-depth-chip">
              {features?.depth ? `📐 Depth on · ${Math.round(hud.pts / 1000)}k points` : "Depth not available: positions only"}
            </span>
            {hud.limited && <span className="rounded-full bg-rose-600 px-2.5 py-1">Tracking lost: move slowly, point at textured areas</span>}
            {phase === "capturing" && <span className="ml-auto rounded-full bg-black/60 px-3 py-1 text-sm" data-testid="ar-progress">{shots.length}/{targets.length}</span>}
          </div>
          {phase === "capturing" && hud.drift > PIVOT_M && (
            <div className="absolute inset-x-0 top-12 mx-auto w-fit rounded-full bg-amber-500 px-3 py-1 text-sm font-bold text-ink" data-testid="ar-drift">
              Phone moved {Math.round(hud.drift * 100)} cm: bring it back to the spot
            </div>
          )}
          <div className="absolute inset-x-2 bottom-2 space-y-2 rounded-xl bg-black/65 p-3 text-sm backdrop-blur" data-testid="ar-guide" data-next-target={hud.nextId ?? ""} data-phase={phase}>
            {phase === "capturing" && (
              <>
                <p className="font-bold">{room?.label}: {ring ? RING_TEXT[ring] : "All done!"}</p>
                <p className="text-white/80">{aligned ? "Hold still…" : "Move the ring onto the orange dot. Keep the lens on the same spot."}</p>
                <div className="flex gap-2">
                  <button type="button" disabled={!canFinish} onClick={finishRoom} className="flex-1 rounded-xl bg-white py-2 font-bold text-ink disabled:opacity-40" data-testid="ar-finish-room">
                    Finish room
                  </button>
                </div>
              </>
            )}
            {phase === "uploading" && <p data-testid="ar-uploading">Uploading {room?.label}…</p>}
            {(phase === "ready" || phase === "walking") && (
              <>
                {msg && <p className="text-emerald-200" data-testid="ar-msg">{msg}</p>}
                {phase === "ready" && <p>Stand in the middle of the first room, choose it and tap “Start here”.</p>}
                <div className="flex gap-2">
                  <select className="min-w-0 flex-1 rounded-lg bg-white/15 px-2 py-2" value={roomId} onChange={(e) => setRoomId(e.target.value)} aria-label="Room" data-testid="ar-room">
                    {rooms.map((r) => (
                      <option key={r.id} value={r.id} className="text-ink">
                        {r.label}
                        {captured.includes(r.label) ? " ✓" : ""}
                      </option>
                    ))}
                  </select>
                  <button type="button" disabled={!roomId} onClick={beginRoom} className="rounded-xl bg-emerald-400 px-4 font-bold text-ink disabled:opacity-40" data-testid="ar-begin-room">
                    Start here
                  </button>
                </div>
                <div className="flex gap-2">
                  <input value={newRoom.label} onChange={(e) => setNewRoom({ ...newRoom, label: e.target.value })} placeholder="New room name" className="min-w-0 flex-1 rounded-lg bg-white/15 px-2 py-2" data-testid="ar-new-room" />
                  <select value={newRoom.roomType} onChange={(e) => setNewRoom({ ...newRoom, roomType: e.target.value })} className="rounded-lg bg-white/15 px-1" aria-label="Room type">
                    {Object.entries(ROOM_TYPES).map(([k, v]) => <option key={k} value={k} className="text-ink">{v}</option>)}
                  </select>
                  <button type="button" onClick={createRoom} className="rounded-lg bg-white/20 px-3" data-testid="ar-add-room">Add</button>
                </div>
                <label className="flex items-center gap-2 text-xs text-white/80">
                  <input type="checkbox" checked={recordWalk} onChange={(e) => setRecordWalk(e.target.checked)} data-testid="ar-record-walk" />
                  Record the walk for true 3D ({kfCount} photos). Processed on a GPU worker.
                </label>
                <button type="button" onClick={end} className="w-full rounded-xl bg-white/10 py-2" data-testid="ar-end">
                  {captured.length ? "Finish house capture" : "Exit depth mode"}
                </button>
              </>
            )}
            {err && <p className="rounded bg-rose-600 p-2" role="alert">{err}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
