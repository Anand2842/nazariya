import { NextResponse } from "next/server";
import { baseUrl } from "@/server/api-v1";
import { embedSnippet, getPublicTour } from "@/server/studio";

// oEmbed (https://oembed.com) so CMSs such as WordPress can embed a tour from its share link.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const url = u.searchParams.get("url") ?? "";
  const m = url.match(/\/(?:t|embed)\/([a-z0-9]{6,20})(?:[/?#]|$)/);
  if (!m) return NextResponse.json({ error: "Unsupported URL" }, { status: 404 });
  const tour = await getPublicTour(m[1]);
  if (!tour) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const base = baseUrl(req);
  const width = Math.min(Number(u.searchParams.get("maxwidth")) || 960, 1920);
  const height = Math.min(Number(u.searchParams.get("maxheight")) || 560, 1200);
  return NextResponse.json(
    {
      version: "1.0",
      type: "rich",
      title: tour.space.name,
      provider_name: "Nazariya",
      provider_url: base,
      author_name: tour.branding.orgName,
      thumbnail_url: tour.posterUrl ? base + tour.posterUrl : undefined,
      width,
      height,
      html: embedSnippet(base, tour.space.publicId, height),
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
