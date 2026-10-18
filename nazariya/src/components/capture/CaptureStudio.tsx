"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { MODE_GUIDES, PREP_CHECKLIST, RING_ORDER, RING_TEXT, shotListFor, type Shot } from "@/lib/capture-guides";
import { angleBetween, angularSpreadDeg, basisAt, dot, headingOf, nearestSample, nextTarget, panoTargets, pitchOf, rollOf, targetDir, tourBasis, yawOf, type DeviceAngles, type Target } from "@/lib/orientation";
import { ArCapture } from "./ArCapture";
import { arSupported, isIos } from "./xr";
import {
  CAMERA_ERROR_TEXT,
  captureDebug,
  finiteIn,
  grabFrame,
  grabSyncedFrame,
  pickRecorderMime,
  sendCaptureDiag,
  sensorRate,
  requestOrientationPermission,
  uploadErrorText,
  uploadForm,
  useCamera,
  useFrameQuality,
  useOrientation,
  useVideoFrameClock,
  type FrameQuality,
} from "./capture-utils";

type Mode = "photos" | "pano" | "video";
interface Room {
  id: string;
  label: string;
  roomType: string;
}

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;
const ASSUMED_FOV_LONG = 65; // typical phone main camera (long side) for on-screen guides only

function deviceLabel() {
  return typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 280) : "";
}

export function CaptureStudio({
  spaceId,
  rooms,
  initialRoomId,
  token = null,
  standalone = false,
  onClose,
  onUploaded,
}: {
  spaceId: string;
  rooms: Room[];
  initialRoomId?: string | null;
  token?: string | null;
  standalone?: boolean;
  onClose?: () => void;
  onUploaded?: () => void;
}) {
  const [roomId, setRoomId] = useState(initialRoomId ?? rooms[0]?.id ?? "");
  const [mode, setMode] = useState<Mode>("pano");
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const room = rooms.find((r) => r.id === roomId);
  // Depth mode (WebXR AR) when the phone supports it; otherwise the standard gyroscope capture.
  const [arOk, setArOk] = useState<boolean | null>(null);
  const [useStandard, setUseStandard] = useState(false);
  useEffect(() => {
    void arSupported().then(setArOk);
  }, []);

  const begin = async () => {
    if (mode === "pano") await requestOrientationPermission();
    setDone(null);
    setStarted(true);
  };

  const finish = (msg: string) => {
    setStarted(false);
    setDone(msg);
    onUploaded?.();
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white" style={{ zIndex: 2147483000 }} data-testid="capture-studio" role="dialog" aria-label="Capture">
      <div className="flex items-center gap-2 border-b border-white/10 p-2">
        {!standalone && (
          <button type="button" className="rounded-lg px-2 py-1 text-lg" onClick={onClose} aria-label="Close capture" data-testid="capture-close">
            ✕
          </button>
        )}
        <select className="min-w-0 flex-1 rounded-lg bg-white/10 px-2 py-1.5 text-sm" value={roomId} onChange={(e) => { setRoomId(e.target.value); setStarted(false); }} aria-label="Room" disabled={started} data-testid="capture-room">
          {rooms.map((r) => <option key={r.id} value={r.id} className="text-ink">{r.label}</option>)}
        </select>
        <div className="flex rounded-lg bg-white/10 p-0.5 text-xs" role="tablist">
          {(["pano", "photos", "video"] as Mode[]).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} disabled={started} onClick={() => { setMode(m); setDone(null); }} className={`rounded-md px-2.5 py-1.5 font-semibold ${mode === m ? "bg-white text-ink" : ""}`} data-testid={`capture-mode-${m}`}>
              {m === "pano" ? "360°" : m === "photos" ? "Photos" : "Video"}
            </button>
          ))}
        </div>
      </div>

      {!room ? (
        <div className="grid flex-1 place-items-center p-6 text-center text-white/80">Add a room first, then capture it.</div>
      ) : mode === "pano" && arOk && !useStandard ? (
        <ArCapture
          spaceId={spaceId}
          rooms={rooms}
          initialRoomId={roomId}
          token={token}
          onFallback={(reason) => {
            setUseStandard(true);
            setDone(reason || null);
          }}
          onFinished={finish}
          done={done}
        />
      ) : !started ? (
        <Intro mode={mode} roomLabel={room.label} done={done} onStart={begin} />
      ) : mode === "photos" ? (
        <PhotoCapture key={roomId} spaceId={spaceId} room={room} token={token} onFinished={finish} onCancel={() => setStarted(false)} />
      ) : mode === "pano" ? (
        <PanoCapture key={roomId} spaceId={spaceId} room={room} token={token} onFinished={finish} onCancel={() => setStarted(false)} />
      ) : (
        <VideoCapture key={roomId} spaceId={spaceId} room={room} token={token} onFinished={finish} onCancel={() => setStarted(false)} />
      )}
    </div>
  );
}

function Intro({ mode, roomLabel, done, onStart }: { mode: Mode; roomLabel: string; done: string | null; onStart: () => void }) {
  const g = MODE_GUIDES[mode];
  return (
    <div className="flex-1 overflow-y-auto p-5" data-testid="capture-intro">
      {done && <div className="mb-4 rounded-xl bg-emerald-500/20 p-3 text-sm text-emerald-100" data-testid="capture-done">{done}</div>}
      <p className="text-xs uppercase tracking-wide text-white/50">{roomLabel}</p>
      <h2 className="mt-1 text-2xl font-extrabold">{g.title}</h2>
      {mode === "pano" && <p className="mt-1 text-sm text-white/70">Takes about 2 minutes. Your phone becomes a 360° camera, and a 3D walkthrough is built automatically.</p>}
      <ol className="mt-4 space-y-2 text-sm">
        {g.steps.map((s, i) => (
          <li key={s} className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/15 text-xs font-bold">{i + 1}</span><span className="text-white/90">{s}</span></li>
        ))}
      </ol>
      <div className="mt-5 rounded-xl bg-white/5 p-3">
        <p className="text-xs font-semibold uppercase text-white/50">Before you start</p>
        <ul className="mt-2 space-y-1 text-sm text-white/80">{PREP_CHECKLIST.map((p) => <li key={p}>☐ {p}</li>)}</ul>
      </div>
      {mode === "pano" && <PanoDiagram />}
      {mode === "pano" && isIos() && (
        <p className="mt-4 rounded-xl bg-white/10 p-3 text-xs text-white/80" data-testid="ios-lidar-note">
          iPhone Pro with LiDAR? Websites can&apos;t use the LiDAR scanner, so this capture uses the motion sensors. For a measured 3D scan, use a free LiDAR app (Polycam, Scaniverse or 3d Scanner App), export a <b>.ply</b> and upload it in Studio → Upload files → 3D scan.
        </p>
      )}
      <button type="button" className="mt-6 w-full rounded-2xl bg-white py-4 text-base font-bold text-ink" onClick={onStart} data-testid="capture-start">
        Start {mode === "pano" ? "360° capture" : mode === "photos" ? "photos" : "recording"}
      </button>
    </div>
  );
}

/** Top-down view: the camera lens must stay in one spot (the user walks around the phone). */
function PanoDiagram() {
  const person = (x: number, y: number) => <circle cx={x} cy={y} r="9" fill="rgba(255,255,255,.85)" />;
  const phone = (x: number, y: number, rot: number) => <rect x={x - 3} y={y - 7} width="6" height="14" rx="1.5" fill="#f59e0b" transform={`rotate(${rot} ${x} ${y})`} />;
  return (
    <div className="mt-5 grid grid-cols-2 gap-3 text-center text-xs" aria-label="Keep the camera in one spot and walk around the phone">
      <div className="rounded-xl bg-rose-500/15 p-2">
        <svg viewBox="0 0 100 90" className="mx-auto h-24">
          <circle cx="50" cy="45" r="30" fill="none" stroke="rgba(244,63,94,.6)" strokeDasharray="3 3" />
          {person(50, 45)}
          {phone(50, 15, 0)}
          {phone(80, 45, 90)}
          {phone(29, 66, 225)}
        </svg>
        <p className="font-semibold text-rose-200">✗ Phone swings around you</p>
        <p className="text-white/60">Seams and a jumping dot</p>
      </div>
      <div className="rounded-xl bg-emerald-500/15 p-2">
        <svg viewBox="0 0 100 90" className="mx-auto h-24">
          <circle cx="50" cy="45" r="24" fill="none" stroke="rgba(52,211,153,.6)" strokeDasharray="3 3" />
          {phone(50, 45, 30)}
          {person(50, 69)}
          {person(29, 33)}
          {person(71, 33)}
        </svg>
        <p className="font-semibold text-emerald-200">✓ Lens stays put, you step around it</p>
        <p className="text-white/60">Or turn the phone on a tripod</p>
      </div>
    </div>
  );
}

function QualityChips({ q, level }: { q: FrameQuality | null; level?: number | null }) {
  const light = !q ? null : q.brightness < 55 ? "Too dark" : q.brightness > 215 ? "Too bright" : "Light OK";
  const steady = !q ? null : q.motion > 14 || q.sharpness < 25 ? "Hold steady" : "Steady";
  const lvl = level == null ? null : Math.abs(level) > 6 ? `Tilted ${Math.round(level)}°` : "Level";
  const chip = (text: string | null, ok: boolean) =>
    text && <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${ok ? "bg-emerald-500/80" : "bg-amber-500/90 text-ink"}`}>{text}</span>;
  return (
    <div className="flex flex-wrap gap-1" data-testid="quality-chips">
      {chip(light, light === "Light OK")}
      {chip(steady, steady === "Steady")}
      {chip(lvl, lvl === "Level")}
    </div>
  );
}

function CameraError({ error, onCancel }: { error: keyof typeof CAMERA_ERROR_TEXT; onCancel: () => void }) {
  return (
    <div className="grid flex-1 place-items-center p-6 text-center" data-testid="camera-error">
      <div>
        <p className="text-lg font-semibold">Camera unavailable</p>
        <p className="mt-2 text-sm text-white/75">{CAMERA_ERROR_TEXT[error]}</p>
        <button type="button" className="mt-5 rounded-xl bg-white/15 px-4 py-2 text-sm" onClick={onCancel}>Back</button>
      </div>
    </div>
  );
}

// ---------------- Guided photos ----------------

function PhotoCapture({ spaceId, room, token, onFinished, onCancel }: { spaceId: string; room: Room; token: string | null; onFinished: (m: string) => void; onCancel: () => void }) {
  const shots = useMemo(() => shotListFor(room.roomType), [room.roomType]);
  const { videoRef, ready, error } = useCamera(true);
  const q = useFrameQuality(videoRef, ready);
  const { angles } = useOrientation(true);
  const [taken, setTaken] = useState<Record<string, { blob: Blob; url: string }>>({});
  const [extra, setExtra] = useState<{ blob: Blob; url: string }[]>([]);
  const [current, setCurrent] = useState(0);
  const [flash, setFlash] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [roll, setRoll] = useState<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const a = angles.current;
      if (a) setRoll(rollOf(tourBasis(a, 0)) * R2D);
    }, 200);
    return () => clearInterval(id);
  }, [angles]);
  useEffect(() => () => Object.values(taken).forEach((t) => URL.revokeObjectURL(t.url)), [taken]);

  if (error) return <CameraError error={error} onCancel={onCancel} />;
  const shot: Shot | undefined = shots[current];
  const allTaken = Object.keys(taken).length;

  const snap = async () => {
    if (!videoRef.current) return;
    const blob = await grabFrame(videoRef.current, 2560, 0.92);
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
    const url = URL.createObjectURL(blob);
    if (shot && !taken[shot.id]) {
      setTaken((t) => ({ ...t, [shot.id]: { blob, url } }));
      const next = shots.findIndex((s, i) => i > current && !taken[s.id]);
      setCurrent(next >= 0 ? next : shots.length);
    } else setExtra((x) => [...x, { blob, url }]);
  };

  const upload = async () => {
    const items = [...shots.filter((s) => taken[s.id]).map((s) => ({ shot: s.title, blob: taken[s.id].blob })), ...extra.map((x, i) => ({ shot: `Extra ${i + 1}`, blob: x.blob }))];
    if (!items.length) return;
    setErr(null);
    for (let i = 0; i < items.length; i++) {
      setUploading(i);
      const fd = new FormData();
      fd.set("file", new File([items[i].blob], `${room.label}-${i + 1}.jpg`, { type: "image/jpeg" }));
      fd.set("kind", "photo");
      fd.set("spaceId", spaceId);
      fd.set("zoneId", room.id);
      fd.set("capture", JSON.stringify({ source: "in_app_camera", device: deviceLabel(), shot: items[i].shot }));
      const r = await uploadForm("/api/uploads", fd, token);
      if (!r.ok) {
        setErr(r.data.error ?? "Upload failed");
        setUploading(null);
        return;
      }
    }
    setUploading(null);
    onFinished(`${items.length} photo${items.length > 1 ? "s" : ""} of ${room.label} uploaded. They'll appear in the room after a quick quality check.`);
  };

  const ok = q && q.brightness >= 55 && q.motion <= 14 && q.sharpness >= 25;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <video ref={videoRef} playsInline muted autoPlay className="absolute inset-0 h-full w-full object-cover" data-testid="camera-video" />
        {/* Rule-of-thirds grid + horizon guide */}
        <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">{Array.from({ length: 9 }, (_, i) => <div key={i} className="border border-white/15" />)}</div>
        {roll != null && <div className="pointer-events-none absolute left-1/2 top-1/2 h-0.5 w-40 -translate-x-1/2" style={{ background: Math.abs(roll) < 3 ? "#34d399" : "#fbbf24", transform: `translateX(-50%) rotate(${-roll}deg)` }} />}
        {flash && <div className="absolute inset-0 bg-white/70" />}
        <div className="absolute inset-x-2 top-2"><QualityChips q={q} level={roll} /></div>
        {shot && (
          <div className="absolute inset-x-2 bottom-2 rounded-xl bg-black/60 p-3 backdrop-blur" data-testid="shot-guide">
            <p className="text-xs text-white/60">Shot {current + 1} of {shots.length}</p>
            <p className="font-bold">{shot.title}</p>
            <p className="text-sm text-white/80">{shot.how}</p>
          </div>
        )}
        {!shot && <div className="absolute inset-x-2 bottom-2 rounded-xl bg-emerald-600/80 p-3 text-sm font-semibold">Shot list complete. Add extra photos or upload.</div>}
      </div>
      <div className="flex items-center gap-2 overflow-x-auto bg-black p-2" data-testid="shot-strip">
        {shots.map((s, i) => (
          <button key={s.id} type="button" onClick={() => setCurrent(i)} className={`relative h-12 w-16 shrink-0 overflow-hidden rounded border text-[9px] ${i === current ? "border-white" : "border-white/20"}`} title={s.title}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {taken[s.id] ? <img src={taken[s.id].url} alt="" className="h-full w-full object-cover" /> : <span className="p-1 text-white/60">{s.title}</span>}
            {taken[s.id] && <span className="absolute right-0.5 top-0.5 rounded-full bg-emerald-500 px-1 text-[9px]">✓</span>}
          </button>
        ))}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {extra.map((x, i) => <img key={i} src={x.url} alt="" className="h-12 w-16 shrink-0 rounded object-cover" />)}
      </div>
      <div className="flex items-center justify-between gap-3 bg-black px-4 pb-6 pt-2">
        <button type="button" className="rounded-xl bg-white/10 px-3 py-2 text-sm" onClick={onCancel}>Cancel</button>
        <button type="button" disabled={!ready} onClick={snap} className={`h-16 w-16 rounded-full border-4 ${ok ? "border-emerald-400" : "border-white"} bg-white/90 disabled:opacity-40`} aria-label="Take photo" data-testid="shutter" />
        <button type="button" disabled={!allTaken && !extra.length || uploading !== null} onClick={upload} className="rounded-xl bg-white px-3 py-2 text-sm font-bold text-ink disabled:opacity-40" data-testid="photos-upload">
          {uploading !== null ? `Uploading ${uploading + 1}…` : `Upload ${allTaken + extra.length}`}
        </button>
      </div>
      {err && <p className="bg-rose-600 p-2 text-center text-sm" role="alert">{err}</p>}
    </div>
  );
}

// ---------------- Guided 360° ----------------

interface Captured {
  target: number;
  blob: Blob;
  angles: DeviceAngles;
}

// Capture tolerances. Precision comes from holding still (the photo is tagged with the orientation at the
// exact frame time); the aim tolerance only needs to keep neighbouring photos overlapping.
const AIM_DEG = 2.5;
const STILL_DEG = 0.6; // max wander during the last 300 ms
const HOLD_MS = 350;
const MAX_ROLL_DEG = 12; // each photo keeps its full orientation (roll included), so the stitcher handles tilt; this only keeps rows overlapping

interface Hud {
  next: { x: number; y: number; onScreen: boolean; aimDeg: number } | null;
  nextId: number | null;
  path: { id: number; x: number; y: number }[];
  done: { id: number; x: number; y: number }[];
  arrow: number | null;
  pitch: number;
  roll: number;
  hold: number; // 0..1
  tooFast: boolean;
  debug: string;
}

function PanoCapture({ spaceId, room, token, onFinished, onCancel }: { spaceId: string; room: Room; token: string | null; onFinished: (m: string) => void; onCancel: () => void }) {
  const { videoRef, ready, error } = useCamera(true);
  const { samples, supported } = useOrientation(true);
  const { clock, frameTime } = useVideoFrameClock(videoRef, ready);
  const q = useFrameQuality(videoRef, ready);
  const targets = useMemo(() => panoTargets(), []);
  const [captured, setCaptured] = useState<Captured[]>([]);
  const capturedRef = useRef<Captured[]>([]);
  const [started, setStarted] = useState(false);
  const refHeading = useRef<number | null>(null);
  const lastYaw = useRef<number | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [hud, setHud] = useState<Hud>({ next: null, nextId: null, path: [], done: [], arrow: null, pitch: 0, roll: 0, hold: 0, tooFast: false, debug: "" });
  const [flash, setFlash] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const holdSince = useRef<number | null>(null);
  const busy = useRef(false);
  const busySince = useRef(0);
  const debug = useMemo(() => captureDebug(), []);
  const sessionId = useMemo(() => Math.random().toString(36).slice(2, 10), []);
  const lastShotAt = useRef(0);
  const failures = useRef(0);
  const lastFailure = useRef<string | null>(null);
  const gate = useRef<Record<string, unknown>>({});
  const diag = (event: string, extra: Record<string, unknown> = {}) =>
    sendCaptureDiag({ mode: "standard", event, sessionId, spaceId, room: room.label, shots: capturedRef.current.length, busyMs: busy.current ? Math.round(performance.now() - busySince.current) : 0, failures: failures.current, lastFailure: lastFailure.current, secondsSinceShot: Math.round((performance.now() - lastShotAt.current) / 1000), ...gate.current, ...extra }, token);

  const doCapture = async (t: Target) => {
    const v = videoRef.current;
    if (!v || busy.current) return;
    busy.current = true;
    busySince.current = performance.now();
    try {
      // A camera that stops delivering frames must not leave the capture waiting forever.
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("camera frame timeout")), 4000));
      const { blob, captureTime } = await Promise.race([grabSyncedFrame(v, 1600, 0.88), timeout]);
      // Tag the photo with the reading taken closest to the moment the frame was captured.
      const i = nearestSample(samples.current, captureTime);
      if (i < 0) throw new Error("no orientation reading");
      const entry = { target: t.id, blob, angles: { ...samples.current[i].a } };
      capturedRef.current = [...capturedRef.current, entry];
      setCaptured(capturedRef.current);
      lastYaw.current = t.yaw;
      lastShotAt.current = performance.now();
      if (debug) diag("shot", { target: t.id });
      setFlash(true);
      setTimeout(() => setFlash(false), 100);
      try {
        navigator.vibrate?.(30);
      } catch {}
    } catch (e) {
      failures.current += 1;
      lastFailure.current = (e as Error).message;
      diag("shot_failed", { target: t.id });
    } finally {
      holdSince.current = null;
      setTimeout(() => (busy.current = false), 400);
    }
  };

  // Live diagnostics: every second in debug mode; otherwise only when no photo was taken for 8 s.
  useEffect(() => {
    if (!started) return;
    lastShotAt.current = performance.now();
    const id = setInterval(() => {
      if (debug) diag("live");
      else if (performance.now() - lastShotAt.current > 8000) diag("stall");
    }, debug ? 1000 : 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, debug]);

  const start = () => {
    const s = samples.current;
    if (!s.length) return;
    refHeading.current = headingOf(s[s.length - 1].a);
    setStarted(true);
  };

  // Guidance loop. Everything is drawn for the orientation at the moment the on-screen frame was captured,
  // so the dots stay glued to the room instead of running ahead of the (delayed) camera picture.
  useEffect(() => {
    let raf = 0;
    let lastHud = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      const host = hostRef.current;
      const buf = samples.current;
      if (!v || !host || !v.videoWidth || !buf.length) return;
      const ft = frameTime();
      const ref = refHeading.current ?? headingOf(buf[buf.length - 1].a);
      const basis = basisAt(buf, ft, ref);
      if (!basis) return;
      const fwd = basis.forward;
      const roll = rollOf(basis) * R2D;
      const pitch = pitchOf(fwd) * R2D;
      const wander = angularSpreadDeg(buf, ft, 300);
      const done = new Set(capturedRef.current.map((c) => c.target));
      const vw = v.videoWidth, vh = v.videoHeight;
      const cw = host.clientWidth, ch = host.clientHeight;
      const s = Math.max(cw / vw, ch / vh);
      const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
      const f = Math.max(vw, vh) / 2 / Math.tan((ASSUMED_FOV_LONG * D2R) / 2);
      const project = (d: [number, number, number]) => {
        const z = dot(d, fwd);
        if (z <= 0.15) return null;
        return { x: ox + ((f * dot(d, basis.right)) / z + vw / 2) * s, y: oy + (vh / 2 - (f * dot(d, basis.up)) / z) * s };
      };
      const inView = (p: { x: number; y: number } | null) => !!p && p.x > -20 && p.x < cw + 20 && p.y > -20 && p.y < ch + 20;
      const isStarted = refHeading.current !== null;
      const nt = isStarted ? nextTarget(targets, done, lastYaw.current, yawOf(fwd)) : null;
      let next: Hud["next"] = null;
      let arrow: number | null = null;
      let hold = 0;
      if (nt) {
        const d = targetDir(nt);
        const aim = angleBetween(d, fwd) * R2D;
        const p = project(d);
        const onScreen = !!p && p.x > 0 && p.x < cw && p.y > 0 && p.y < ch;
        next = p ? { ...p, onScreen, aimDeg: aim } : { x: 0, y: 0, onScreen: false, aimDeg: aim };
        if (!onScreen) arrow = Math.atan2(-dot(d, basis.up), dot(d, basis.right)) * R2D;
        // Roll is undefined when looking straight up or down, so it is only checked for the other rows.
        const rollOk = nt.ring === "zenith" || nt.ring === "nadir" || Math.abs(roll) <= MAX_ROLL_DEG;
        const ok = aim <= AIM_DEG && rollOk && wander <= STILL_DEG;
        gate.current = { nextTarget: nt.id, ring: nt.ring, aimDeg: +aim.toFixed(2), rollDeg: +roll.toFixed(1), pitchDeg: +pitch.toFixed(1), wanderDeg: +wander.toFixed(2), blocked: aim > AIM_DEG ? "aim" : !rollOk ? "roll" : wander > STILL_DEG ? "still" : null, sensorHz: Math.round(sensorRate(buf)), frameSync: clock.current.sync, latencyMs: Math.round(clock.current.latencyMs), onScreen };
        if (ok) {
          holdSince.current ??= now;
          hold = Math.min(1, (now - holdSince.current) / HOLD_MS);
          if (hold >= 1 && !busy.current) void doCapture(nt);
        } else holdSince.current = null;
      }
      if (now - lastHud > 50) {
        lastHud = now;
        const ring = nt?.ring;
        const path: Hud["path"] = [];
        const doneDots: Hud["done"] = [];
        for (const t of targets) {
          if (t.id === nt?.id) continue;
          const p = project(targetDir(t));
          if (!inView(p)) continue;
          if (done.has(t.id)) doneDots.push({ id: t.id, ...p! });
          else if (t.ring === ring) path.push({ id: t.id, ...p! });
        }
        const c = clock.current;
        setHud({
          next,
          nextId: nt?.id ?? null,
          path,
          done: doneDots,
          arrow,
          pitch,
          roll,
          hold,
          tooFast: wander > 15,
          debug: debug ? `sensor ${sensorRate(buf).toFixed(0)} Hz · frame sync ${c.sync} · lag ${c.latencyMs.toFixed(0)} ms · wander ${wander.toFixed(2)}° · aim ${next ? next.aimDeg.toFixed(1) : "-"}° · roll ${roll.toFixed(1)}°` : "",
        });
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets]);

  if (error) return <CameraError error={error} onCancel={onCancel} />;
  if (supported === false) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center" data-testid="no-sensors">
        <div>
          <p className="text-lg font-semibold">This device has no motion sensors</p>
          <p className="mt-2 text-sm text-white/75">360° capture needs a phone or tablet. Open the capture link on your phone (Studio → &ldquo;Capture on phone&rdquo;), or use Photos / Video mode here.</p>
          <button type="button" className="mt-5 rounded-xl bg-white/15 px-4 py-2 text-sm" onClick={onCancel}>Back</button>
        </div>
      </div>
    );
  }

  const doneIds = new Set(captured.map((c) => c.target));
  const horizonDone = targets.filter((t) => t.ring === "horizon").every((t) => doneIds.has(t.id));
  const canFinish = horizonDone && captured.length >= 20;
  const remainingRing = RING_ORDER.find((r) => targets.some((t) => t.ring === r && !doneIds.has(t.id)));
  const levelOk = Math.abs(hud.pitch) < 3 && Math.abs(hud.roll) < 3;
  const aligned = !!hud.next && hud.next.aimDeg <= AIM_DEG;
  const near = !!hud.next && hud.next.aimDeg <= 8;

  const upload = async () => {
    setErr(null);
    setUploading(0);
    const c = clock.current;
    const fd = new FormData();
    fd.set("spaceId", spaceId);
    fd.set("zoneId", room.id);
    fd.set(
      "meta",
      JSON.stringify({
        device: deviceLabel(),
        diag: { sensorHz: finiteIn(sensorRate(samples.current), 0, 1000), frameSync: c.sync, latencyMs: finiteIn(c.latencyMs, 0, 2000) },
        frames: captured.map((c) => ({ ...c.angles, target: c.target })),
      }),
    );
    captured.forEach((c, i) => fd.set(`frame_${i}`, new File([c.blob], `frame_${i}.jpg`, { type: "image/jpeg" })));
    const r = await uploadForm("/api/captures/pano", fd, token, (p) => setUploading(Math.round(p * 100)));
    setUploading(null);
    if (!r.ok) {
      diag("upload_failed", { error: uploadErrorText(r.data) });
      return setErr(uploadErrorText(r.data));
    }
    if (debug) diag("uploaded");
    onFinished(`360° capture of ${room.label} uploaded (${captured.length} photos). Stitching takes about a minute; the 3D walkthrough is built right after.`);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden" data-testid="pano-capture">
        <video ref={videoRef} playsInline muted autoPlay className="absolute inset-0 h-full w-full object-cover" data-testid="camera-video" />
        {flash && <div className="absolute inset-0 bg-white/60" />}
        {started && (
          <>
            {hud.done.map((d) => (
              <div key={`d${d.id}`} className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400/80" style={{ left: d.x, top: d.y }} />
            ))}
            {hud.path.map((d) => (
              <div key={`p${d.id}`} className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/50" style={{ left: d.x, top: d.y }} />
            ))}
            {hud.next?.onScreen && near && (
              <svg className="pointer-events-none absolute inset-0 h-full w-full">
                <line x1="50%" y1="50%" x2={hud.next.x} y2={hud.next.y} stroke={aligned ? "#34d399" : "rgba(245,158,11,.8)"} strokeWidth="3" strokeDasharray="6 6" />
              </svg>
            )}
            {hud.next?.onScreen && (
              <div
                className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full ${aligned ? "" : "animate-pulse"}`}
                style={{ left: hud.next.x, top: hud.next.y, width: 34, height: 34, background: aligned ? "#34d399" : "#f59e0b", boxShadow: "0 0 0 4px rgba(0,0,0,.35)" }}
                data-testid="pano-next-dot"
              />
            )}
          </>
        )}
        {/* Centre ring: fills while you hold still on the dot */}
        <svg className="pointer-events-none absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2" viewBox="0 0 96 96">
          <circle cx="48" cy="48" r="36" fill="none" stroke={aligned ? "#34d399" : "rgba(255,255,255,.85)"} strokeWidth="3" />
          <circle cx="48" cy="48" r="36" fill="none" stroke="#34d399" strokeWidth="7" strokeDasharray={`${hud.hold * 226.2} 226.2`} transform="rotate(-90 48 48)" />
          <circle cx="48" cy="48" r="3" fill="white" />
        </svg>
        {hud.arrow !== null && started && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-0 w-0" style={{ transform: `rotate(${hud.arrow}deg)` }} data-testid="pano-arrow">
            <div className="absolute left-16 -top-5 text-4xl text-amber-400 drop-shadow">➤</div>
          </div>
        )}
        <div className="absolute inset-x-2 top-2 flex items-start justify-between gap-2">
          <QualityChips q={q} level={hud.roll} />
          <span className="rounded-full bg-black/60 px-3 py-1 text-sm font-bold" data-testid="pano-progress">{captured.length}/{targets.length}</span>
        </div>
        {hud.tooFast && started && <div className="absolute inset-x-0 top-14 mx-auto w-fit rounded-full bg-amber-500 px-3 py-1 text-sm font-bold text-ink">Slow down</div>}
        {debug && <div className="absolute inset-x-2 top-24 rounded bg-black/70 p-1 font-mono text-[10px]" data-testid="pano-debug">{hud.debug}</div>}
        <div className="absolute inset-x-2 bottom-2 rounded-xl bg-black/60 p-3 text-sm backdrop-blur" data-testid="pano-guide" data-next-target={hud.nextId ?? ""}>
          {!started ? (
            <>
              <p className="font-bold">Face a wall from the middle of the room</p>
              <p className="text-white/80">Hold the phone upright at chest height, then tap Start. The first photo is taken when the phone is level and still. {levelOk ? "" : "Level the phone first."}</p>
            </>
          ) : remainingRing ? (
            <>
              <p className="font-bold">{RING_TEXT[remainingRing]}</p>
              <p className="text-white/80">
                {aligned ? "Hold still…" : "Move the ring onto the orange dot."} Keep the camera lens in one spot and step around the phone; don&apos;t swing it around your body.
              </p>
            </>
          ) : (
            <p className="font-bold">All done! Upload to build your 360° and 3D room.</p>
          )}
          <div className="mt-2 flex gap-1">
            {RING_ORDER.map((r) => {
              const all = targets.filter((t) => t.ring === r);
              const n = all.filter((t) => doneIds.has(t.id)).length;
              return <div key={r} className="h-1.5 flex-1 overflow-hidden rounded bg-white/15" title={r}><div className="h-full bg-emerald-400" style={{ width: `${(n / all.length) * 100}%` }} /></div>;
            })}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 bg-black px-4 pb-6 pt-3">
        <button type="button" className="rounded-xl bg-white/10 px-3 py-2 text-sm" onClick={onCancel}>Cancel</button>
        {!started ? (
          <button type="button" disabled={!ready || supported !== true} onClick={start} className="rounded-full bg-white px-6 py-3 text-sm font-bold text-ink disabled:opacity-40" data-testid="pano-begin">
            Start
          </button>
        ) : (
          <span className="text-xs text-white/60">{canFinish ? "You can finish now or complete the rest" : "Auto-capturing…"}</span>
        )}
        <button type="button" disabled={!canFinish || uploading !== null} onClick={upload} className="rounded-xl bg-white px-3 py-2 text-sm font-bold text-ink disabled:opacity-40" data-testid="pano-upload">
          {uploading !== null ? `Uploading ${uploading}%` : "Finish & upload"}
        </button>
      </div>
      {err && <p className="bg-rose-600 p-2 text-center text-sm" role="alert">{err}</p>}
    </div>
  );
}

// ---------------- Guided video ----------------

const VIDEO_TIPS: [number, string][] = [
  [0, "Start at the door. Walk in slowly"],
  [8, "Pan slowly across the first wall"],
  [20, "Keep going around the room, corner by corner"],
  [40, "Show windows, storage and fittings"],
  [60, "Finish where you started"],
  [90, "Great, you can stop now"],
];

function VideoCapture({ spaceId, room, token, onFinished, onCancel }: { spaceId: string; room: Room; token: string | null; onFinished: (m: string) => void; onCancel: () => void }) {
  const { videoRef, ready, error, stream } = useCamera(true);
  const q = useFrameQuality(videoRef, ready);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<{ blob: Blob; url: string; type: string } | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const s = (Date.now() - startedAt.current) / 1000;
      setElapsed(s);
      if (s >= 120) rec.current?.stop();
    }, 250);
    return () => clearInterval(id);
  }, [recording]);

  if (error) return <CameraError error={error} onCancel={onCancel} />;

  const start = () => {
    if (!stream) return;
    const mimeType = pickRecorderMime();
    const r = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      setRecording(false);
      const type = r.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunks.current, { type });
      setResult({ blob, url: URL.createObjectURL(blob), type });
    };
    r.start(1000);
    rec.current = r;
    startedAt.current = Date.now();
    setElapsed(0);
    setRecording(true);
  };

  const upload = async () => {
    if (!result) return;
    setErr(null);
    const ext = result.type.includes("mp4") ? "mp4" : "webm";
    const fd = new FormData();
    fd.set("file", new File([result.blob], `${room.label}-walkthrough.${ext}`, { type: result.type.split(";")[0] }));
    fd.set("kind", "video");
    fd.set("spaceId", spaceId);
    fd.set("zoneId", room.id);
    fd.set("capture", JSON.stringify({ source: "in_app_camera", device: deviceLabel() }));
    setUploading(0);
    const r = await uploadForm("/api/uploads", fd, token, (p) => setUploading(Math.round(p * 100)));
    setUploading(null);
    if (!r.ok) return setErr(r.data.error ?? "Upload failed");
    onFinished(`Walkthrough of ${room.label} uploaded. Still photos are extracted automatically.`);
  };

  const tip = [...VIDEO_TIPS].reverse().find(([t]) => elapsed >= t)?.[1] ?? VIDEO_TIPS[0][1];
  const mm = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {result ? (
          <video src={result.url} controls playsInline className="absolute inset-0 h-full w-full object-contain" data-testid="video-preview" />
        ) : (
          <video ref={videoRef} playsInline muted autoPlay className="absolute inset-0 h-full w-full object-cover" data-testid="camera-video" />
        )}
        {!result && <div className="absolute inset-x-2 top-2 flex justify-between"><QualityChips q={q} /><span className={`rounded-full px-3 py-1 text-sm font-bold ${recording ? "bg-rose-600" : "bg-black/60"}`} data-testid="video-timer">{recording ? "● " : ""}{mm}</span></div>}
        {!result && <div className="absolute inset-x-2 bottom-2 rounded-xl bg-black/60 p-3 text-sm font-semibold backdrop-blur" data-testid="video-tip">{recording ? tip : "Tap record when you're at the door"}</div>}
      </div>
      <div className="flex items-center justify-between gap-3 bg-black px-4 pb-6 pt-3">
        <button type="button" className="rounded-xl bg-white/10 px-3 py-2 text-sm" onClick={() => (result ? (URL.revokeObjectURL(result.url), setResult(null)) : onCancel())}>{result ? "Retake" : "Cancel"}</button>
        {!result && (
          <button type="button" disabled={!ready} onClick={() => (recording ? rec.current?.stop() : start())} className={`grid h-16 w-16 place-items-center rounded-full border-4 border-white disabled:opacity-40 ${recording ? "bg-white" : "bg-rose-600"}`} aria-label={recording ? "Stop recording" : "Start recording"} data-testid="record">
            {recording && <span className="h-6 w-6 rounded bg-rose-600" />}
          </button>
        )}
        <button type="button" disabled={!result || uploading !== null} onClick={upload} className="rounded-xl bg-white px-3 py-2 text-sm font-bold text-ink disabled:opacity-40" data-testid="video-upload">
          {uploading !== null ? `Uploading ${uploading}%` : "Upload"}
        </button>
      </div>
      {result && elapsed < 15 && <p className="bg-amber-500 p-2 text-center text-sm text-ink">Short clip: at least 15 seconds works best.</p>}
      {err && <p className="bg-rose-600 p-2 text-center text-sm" role="alert">{err}</p>}
    </div>
  );
}
