"use client";
import { updateSpaceAction } from "@/app/actions/studio";
import { SPACE_KINDS } from "@/lib/catalog";
import { Msg, useAction } from "./useAction";

export function SpaceSettingsForm({ space }: { space: { id: string; name: string; kind: string; address: string | null; description: string; externalRef: string | null; settings: { defaultTier?: string; showRoomList?: boolean; autoRotate?: boolean; showFloorPlan?: boolean } } }) {
  const { msg, busy, run } = useAction();
  return (
    <form
      className="card space-y-3 p-4"
      data-testid="space-settings"
      action={(fd) =>
        void run(
          () =>
            updateSpaceAction(space.id, {
              name: String(fd.get("name")),
              kind: String(fd.get("kind")) as "apartment",
              address: String(fd.get("address") || "") || null,
              description: String(fd.get("description") || ""),
              externalRef: String(fd.get("externalRef") || "") || null,
              settings: { defaultTier: String(fd.get("defaultTier")) as "auto", showRoomList: fd.get("showRoomList") === "on", autoRotate: fd.get("autoRotate") === "on", showFloorPlan: fd.get("showFloorPlan") === "on" },
            }),
          "Saved",
        )
      }
    >
      <p className="section-title">Space details</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input name="name" className="input" defaultValue={space.name} aria-label="Name" required />
        <select name="kind" className="input" defaultValue={space.kind} aria-label="Type">{Object.entries(SPACE_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <input name="address" className="input" defaultValue={space.address ?? ""} placeholder="Address / project (optional)" aria-label="Address" />
        <input name="externalRef" className="input" defaultValue={space.externalRef ?? ""} placeholder="Your listing ID (for the API)" aria-label="Your listing ID" />
      </div>
      <textarea name="description" className="input min-h-20" defaultValue={space.description} placeholder="Short description shown on the share page" aria-label="Description" />
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">Default view
          <select name="defaultTier" className="rounded-lg border border-slate-300 px-2 py-1" defaultValue={space.settings.defaultTier ?? "auto"}>
            <option value="auto">Best for device</option><option value="3d">3D</option><option value="360">360°</option><option value="photos">Photos</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5"><input type="checkbox" name="showRoomList" defaultChecked={space.settings.showRoomList !== false} /> Show room list</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" name="showFloorPlan" defaultChecked={space.settings.showFloorPlan !== false} /> Show floor plan</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" name="autoRotate" defaultChecked={!!space.settings.autoRotate} /> Auto-rotate when idle (3D)</label>
      </div>
      <button className="btn-secondary" disabled={busy} type="submit">Save</button>
      <Msg msg={msg} />
    </form>
  );
}
