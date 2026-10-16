"use client";
// Top-down floor plan of a space: rooms (measured or approximate boxes), doorways, the current room and the
// viewer's heading. Used as the minimap in the tour viewer and as the canvas of the studio plan editor.
import { localToPlan, planBounds, roomOutlinePlan, wallPointAtYaw, type PlanPlacement } from "@/lib/floorplan";
import type { RoomDims } from "@/lib/pano-geometry";

export interface PlanRoom {
  id: string;
  label: string;
  dims: RoomDims;
  plan: PlanPlacement | null;
  doors: { targetZoneId: string | null; yaw: number }[];
}

export function placedRooms(rooms: PlanRoom[]) {
  return rooms.filter((r): r is PlanRoom & { plan: PlanPlacement } => !!r.plan);
}

/** Plan coordinates → SVG coordinates (metres scaled, z down the page). */
export function planViewBox(rooms: PlanRoom[], pad = 0.6) {
  const placed = placedRooms(rooms);
  const b = planBounds(placed.map((r) => roomOutlinePlan(r.dims, r.plan)));
  if (!Number.isFinite(b.minX)) return { minX: -3, minZ: -3, w: 6, h: 6 };
  return { minX: b.minX - pad, minZ: b.minZ - pad, w: b.maxX - b.minX + 2 * pad, h: b.maxZ - b.minZ + 2 * pad };
}

export function FloorPlanMap({
  rooms,
  currentId,
  headingYaw,
  selectedId,
  onRoomClick,
  onRoomPointerDown,
  className = "",
  showDims = false,
  testId = "floor-plan",
  viewBox,
  svgRef,
}: {
  rooms: PlanRoom[];
  currentId?: string | null;
  headingYaw?: number | null; // radians, in the current room's panorama frame
  selectedId?: string | null;
  onRoomClick?: (id: string) => void;
  onRoomPointerDown?: (id: string, e: React.PointerEvent<SVGGElement>) => void;
  className?: string;
  showDims?: boolean;
  testId?: string;
  viewBox?: { minX: number; minZ: number; w: number; h: number };
  svgRef?: React.Ref<SVGSVGElement>;
}) {
  const placed = placedRooms(rooms);
  const vb = viewBox ?? planViewBox(rooms);
  const unit = Math.max(vb.w, vb.h) / 28; // stroke/text scale relative to the plan size
  const byId = new Map(placed.map((r) => [r.id, r]));
  return (
    <svg ref={svgRef} viewBox={`${vb.minX} ${vb.minZ} ${vb.w} ${vb.h}`} className={className} data-testid={testId} role="img" aria-label="Floor plan">
      {placed.map((r) => {
        const poly = roomOutlinePlan(r.dims, r.plan);
        const cx = poly.reduce((a, p) => a + p[0], 0) / 4, cz = poly.reduce((a, p) => a + p[1], 0) / 4;
        const current = r.id === currentId, selected = r.id === selectedId;
        // Text fits inside the room: sized by the room, never by the whole plan.
        const side = Math.min(r.dims.w, r.dims.d);
        const fs = Math.min(unit * 1.1, side * 0.13);
        const label = r.label.length > 16 ? `${r.label.slice(0, 15)}…` : r.label;
        return (
          <g
            key={r.id}
            data-testid={`plan-room-${r.id}`}
            data-label={r.label}
            onClick={onRoomClick ? () => onRoomClick(r.id) : undefined}
            onPointerDown={onRoomPointerDown ? (e) => onRoomPointerDown(r.id, e) : undefined}
            style={{ cursor: onRoomClick || onRoomPointerDown ? "pointer" : undefined }}
          >
            <polygon
              points={poly.map((p) => p.join(",")).join(" ")}
              fill={current ? "rgba(245,158,11,.35)" : selected ? "rgba(15,118,110,.25)" : "rgba(255,255,255,.12)"}
              stroke={current ? "#f59e0b" : selected ? "#0f766e" : "rgba(148,163,184,.9)"}
              strokeWidth={unit * (current || selected ? 0.35 : 0.22)}
              strokeLinejoin="round"
            />
            <text x={cx} y={cz} textAnchor="middle" dominantBaseline="middle" fontSize={fs} fontWeight={600} fill="currentColor" style={{ pointerEvents: "none" }}>
              <title>{r.label}</title>
              {label}
            </text>
            {showDims && (
              <text x={cx} y={cz + fs * 1.4} textAnchor="middle" dominantBaseline="middle" fontSize={fs * 0.75} fill="currentColor" opacity={0.75} style={{ pointerEvents: "none" }}>
                {r.dims.w.toFixed(1)} × {r.dims.d.toFixed(1)} m{r.dims.measured ? " · measured" : ""}
              </text>
            )}
            {/* Capture point */}
            <circle cx={r.plan.x} cy={r.plan.z} r={unit * 0.35} fill={current ? "#f59e0b" : "rgba(148,163,184,.9)"} style={{ pointerEvents: "none" }} />
          </g>
        );
      })}
      {/* Doorways */}
      {placed.flatMap((r) =>
        r.doors
          .filter((d) => d.targetZoneId && byId.has(d.targetZoneId))
          .map((d, i) => {
            const p = wallPointAtYaw(r.dims, r.plan, d.yaw);
            return <circle key={`${r.id}-door-${i}`} cx={p[0]} cy={p[1]} r={unit * 0.45} fill="#0f766e" stroke="white" strokeWidth={unit * 0.12} data-testid="plan-door" style={{ pointerEvents: "none" }} />;
          }),
      )}
      {/* Viewer's heading in the current room */}
      {currentId && headingYaw != null && byId.has(currentId) && (() => {
        const r = byId.get(currentId)!;
        const fov = 0.6;
        const L = Math.max(1.2, Math.min(r.dims.w, r.dims.d) * 0.45);
        const pts = [[0, 0], [Math.sin(headingYaw - fov) * L, -Math.cos(headingYaw - fov) * L], [Math.sin(headingYaw + fov) * L, -Math.cos(headingYaw + fov) * L]].map((p) => localToPlan(p as [number, number], r.plan));
        return <polygon points={pts.map((p) => p.join(",")).join(" ")} fill="rgba(245,158,11,.55)" data-testid="plan-heading" style={{ pointerEvents: "none" }} />;
      })()}
    </svg>
  );
}
