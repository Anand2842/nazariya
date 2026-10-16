import type { Metadata } from "next";
import { NotAvailable, TourPage } from "@/components/TourPage";
import { getCurrentUser } from "@/server/session";
import { getPublicTour } from "@/server/studio";

type Props = { params: Promise<{ publicId: string }>; searchParams: Promise<Record<string, string | undefined>> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { publicId } = await params;
  const t = await getPublicTour(publicId);
  if (!t) return { title: "Tour" };
  const desc = t.space.description || `${t.zones.length}-room interactive tour by ${t.branding.orgName}`;
  return {
    title: `${t.space.name} · ${t.branding.orgName}`,
    description: desc,
    openGraph: { title: t.space.name, description: desc, images: t.posterUrl ? [{ url: t.posterUrl }] : [] },
    alternates: { types: { "application/json+oembed": `/api/oembed?url=${encodeURIComponent(`${process.env.APP_URL ?? ""}/t/${publicId}`)}` } },
  };
}

export default async function SharePage({ params, searchParams }: Props) {
  const { publicId } = await params;
  const tour = await getPublicTour(publicId, await getCurrentUser());
  if (!tour) return <NotAvailable reason="This tour doesn't exist or isn't published." />;
  return <TourPage tour={tour} surface={tour.preview ? "studio_preview" : "share"} sp={await searchParams} />;
}
