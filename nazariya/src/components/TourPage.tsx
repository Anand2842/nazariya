import { TourViewer } from "@/components/tour/TourViewer";
import type { Tier } from "@/components/tour/types";
import type { PublicTour } from "@/server/studio";

export function TourPage({ tour, surface, sp }: { tour: PublicTour; surface: "embed" | "share" | "studio_preview"; sp: Record<string, string | undefined> }) {
  const view = (["3d", "360", "photos"].includes(sp.view ?? "") ? sp.view : null) as Tier | null;
  return (
    <div className="relative h-dvh w-full">
      {tour.preview && (
        <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-amber-400 px-3 py-1 text-xs font-bold text-ink" data-testid="preview-badge">
          Preview: not published
        </div>
      )}
      <TourViewer
        publicId={tour.space.publicId}
        title={tour.space.name}
        zones={tour.zones}
        posterUrl={tour.posterUrl}
        branding={tour.branding}
        settings={{ defaultTier: tour.space.settings.defaultTier ?? "auto", showRoomList: sp.rooms === "0" ? false : tour.space.settings.showRoomList !== false, autoRotate: !!tour.space.settings.autoRotate, showFloorPlan: sp.map === "0" ? false : tour.space.settings.showFloorPlan !== false }}
        surface={surface}
        initialZoneId={sp.room ?? null}
        forceTier={view}
        autoStart={sp.autostart === "1"}
        className="h-full"
      />
    </div>
  );
}

export function NotAvailable({ reason }: { reason: string }) {
  return (
    <div className="grid h-dvh place-items-center bg-slate-900 p-6 text-center text-slate-200" data-testid="tour-unavailable">
      <div>
        <p className="text-lg font-semibold">Tour unavailable</p>
        <p className="mt-1 text-sm text-slate-400">{reason}</p>
      </div>
    </div>
  );
}
