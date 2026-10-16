"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { autoArrangeAction, setZonePlanAction } from "@/app/actions/studio";
import { polygonArea, roomOutlinePlan, type PlanPlacement } from "@/lib/floorplan";
import { FloorPlanMap, placedRooms, planViewBox, type PlanRoom } from "../tour/FloorPlanMap";

const SQFT_PER_M2 = 10.7639;

/**
 * Studio floor plan: drag rooms into place, rotate them, see doorways. Rooms captured in depth mode arrive
 * already measured and placed; others are approximate boxes the user arranges by hand.
 */
export function FloorPlanEditor({ spaceId, rooms }: { spaceId: string; rooms: PlanRoom[] }) {
  const router = useRouter();
  const [local, setLocal] = useState(rooms);
  useEffect(() => setLocal(rooms), [rooms]);
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // Freeze the view box while dragging so the plan doesn't rescale under the pointer.
  const [frozenVb, setFrozenVb] = useState<ReturnType<typeof planViewBox> | null>(null);
  const drag = useRef<{ id: string; start: { x: number; z: number }; plan: PlanPlacement; moved: boolean } | null>(null);
  const placed = placedRooms(local);
  const unplaced = local.filter((r) => !r.plan);
  const sel = local.find((r) => r.id === selected) ?? null;
  const measured = placed.filter((r) => r.dims.measured);
  const area = useMemo(() => measured.reduce((a, r) => a + polygonArea(roomOutlinePlan(r.dims, r.plan)), 0), [measured]);

  const toPlan = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, z: p.y };
  };

  const save = async (id: string, plan: { x: number; z: number; rotDeg: number } | null) => {
    const r = await setZonePlanAction(spaceId, id, plan);
    setMsg(r.ok ? "Saved" : r.error);
    router.refresh();
  };

  const update = (id: string, plan: PlanPlacement | null) => setLocal((rs) => rs.map((r) => (r.id === id ? { ...r, plan } : r)));

  return (
    <section className="card p-4" data-testid="floor-plan-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="section-title">Floor plan</p>
          <p className="muted text-sm">Drag rooms into place. Doors you add between placed rooms get a matching door back automatically. Rooms captured in depth mode are measured and placed for you.</p>
        </div>
        {unplaced.length > 0 && (
          <button
            type="button"
            className="btn-secondary"
            data-testid="plan-auto-arrange"
            onClick={async () => {
              const r = await autoArrangeAction(spaceId);
              setMsg(r.ok ? `Placed ${(r.data as { placed: number }).placed} room(s): drag them into position` : r.error);
              router.refresh();
            }}
          >
            Place {unplaced.length} room{unplaced.length > 1 ? "s" : ""} on the plan
          </button>
        )}
      </div>
      {placed.length ? (
        <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_260px]">
          <div
            className="touch-none rounded-xl border border-slate-200 bg-slate-900 text-white"
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const p = toPlan(e);
              const nx = d.plan.x + (p.x - d.start.x), nz = d.plan.z + (p.z - d.start.z);
              d.moved = true;
              update(d.id, { ...d.plan, x: Math.round(nx * 20) / 20, z: Math.round(nz * 20) / 20, source: "manual" });
            }}
            onPointerUp={async () => {
              const d = drag.current;
              drag.current = null;
              setFrozenVb(null);
              if (d?.moved) {
                const r = local.find((x) => x.id === d.id);
                if (r?.plan) await save(d.id, { x: r.plan.x, z: r.plan.z, rotDeg: r.plan.rotDeg });
              }
            }}
          >
            <FloorPlanMap
              rooms={local}
              selectedId={selected}
              showDims
              className="aspect-[4/3] w-full"
              testId="studio-plan"
              svgRef={svgRef}
              viewBox={frozenVb ?? undefined}
              onRoomPointerDown={(id, e) => {
                const r = local.find((x) => x.id === id);
                if (!r?.plan) return;
                setSelected(id);
                setFrozenVb(planViewBox(local, 3));
                (e.currentTarget.ownerSVGElement as SVGSVGElement | null)?.parentElement?.setPointerCapture?.(e.pointerId);
                drag.current = { id, start: toPlan(e), plan: r.plan, moved: false };
              }}
            />
          </div>
          <div className="space-y-2 text-sm">
            {sel?.plan ? (
              <div className="rounded-xl bg-slate-50 p-3" data-testid="plan-selected">
                <p className="font-semibold">{sel.label}</p>
                <p className="text-xs text-slate-500">
                  {sel.dims.w.toFixed(2)} × {sel.dims.d.toFixed(2)} m{sel.dims.measured ? " · 📐 measured with phone depth" : " · approximate (set in the room's 3D settings)"}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {[-90, -15, 15, 90].map((d) => (
                    <button
                      key={d}
                      type="button"
                      className="rounded-lg bg-white px-2 py-1 text-xs ring-1 ring-slate-200"
                      data-testid={`plan-rotate-${d}`}
                      onClick={async () => {
                        const p = { ...sel.plan!, rotDeg: (((sel.plan!.rotDeg + d) % 360) + 360) % 360, source: "manual" as const };
                        update(sel.id, p);
                        await save(sel.id, { x: p.x, z: p.z, rotDeg: p.rotDeg });
                      }}
                    >
                      {d > 0 ? `↻ ${d}°` : `↺ ${-d}°`}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-xs text-rose-600"
                    onClick={async () => {
                      update(sel.id, null);
                      setSelected(null);
                      await save(sel.id, null);
                    }}
                  >
                    Remove from plan
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted">Tap a room to rotate it or remove it from the plan.</p>
            )}
            {measured.length > 0 && (
              <div className="rounded-xl bg-emerald-50 p-3 text-emerald-900" data-testid="plan-area">
                <p className="font-semibold">Measured area: {area.toFixed(1)} m² ({Math.round(area * SQFT_PER_M2)} sq ft)</p>
                <p className="text-xs">
                  {measured.length} of {placed.length} rooms measured with phone depth. Wall-to-wall estimate (±2–3%), not a certified carpet area.
                </p>
              </div>
            )}
            {unplaced.length > 0 && <p className="text-xs text-slate-500">Not on the plan: {unplaced.map((r) => r.label).join(", ")}</p>}
            {msg && <p className="text-xs text-nazar" role="status">{msg}</p>}
          </div>
        </div>
      ) : (
        <p className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
          No rooms on the plan yet. Capture rooms in <b>depth mode</b> on a supported phone (they are measured and placed automatically), or place them by hand.
        </p>
      )}
    </section>
  );
}
