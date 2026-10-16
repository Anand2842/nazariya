import type { Metadata } from "next";
import { PhoneCapture } from "./PhoneCapture";
import { captureTarget, resolveCaptureToken } from "@/server/capture";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Capture", robots: { index: false } };

export default async function CapturePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ room?: string }> }) {
  const { token } = await params;
  const { room } = await searchParams;
  const ctx = await resolveCaptureToken(token);
  if (!ctx) {
    return (
      <div className="grid h-dvh place-items-center bg-slate-900 p-6 text-center text-slate-200" data-testid="capture-link-invalid">
        <div>
          <p className="text-lg font-semibold">This capture link has expired</p>
          <p className="mt-1 text-sm text-slate-400">Open the room in Nazariya Studio on your computer and tap &ldquo;Show QR code&rdquo; again.</p>
        </div>
      </div>
    );
  }
  const t = await captureTarget(ctx);
  return <PhoneCapture token={token} spaceId={t.space.id} spaceName={t.space.name} rooms={t.rooms} initialRoomId={room ?? t.zoneId} />;
}
