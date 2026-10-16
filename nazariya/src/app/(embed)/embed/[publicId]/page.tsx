import type { Metadata } from "next";
import { headers } from "next/headers";
import { NotAvailable, TourPage } from "@/components/TourPage";
import { getCurrentUser } from "@/server/session";
import { getPublicTour, hostMatches } from "@/server/studio";

type Props = { params: Promise<{ publicId: string }>; searchParams: Promise<Record<string, string | undefined>> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { publicId } = await params;
  const t = await getPublicTour(publicId);
  return { title: t ? `${t.space.name}: 3D tour` : "Tour", robots: { index: false } };
}

export default async function EmbedPage({ params, searchParams }: Props) {
  const { publicId } = await params;
  const sp = await searchParams;
  const user = await getCurrentUser();
  const tour = await getPublicTour(publicId, user);
  if (!tour) return <NotAvailable reason="This tour doesn't exist or isn't published." />;
  // Browsers enforce frame-ancestors (middleware); this server-side check covers the Referer as well.
  const h = await headers();
  const ref = h.get("referer");
  const self = h.get("host");
  if (ref && tour.space.allowedDomains.length) {
    try {
      const host = new URL(ref).host;
      if (host !== self && !hostMatches(host, tour.space.allowedDomains)) return <NotAvailable reason={`This tour can't be embedded on ${host}.`} />;
    } catch {}
  }
  return <TourPage tour={tour} surface={tour.preview ? "studio_preview" : "embed"} sp={sp} />;
}
