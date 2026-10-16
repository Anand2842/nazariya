import { NextResponse, type NextRequest } from "next/server";

// Per-tour embed policy: only domains the customer allowed may frame /embed/<id>.
const cache = new Map<string, { value: string | null; at: number }>();
const TTL_MS = 30_000;

async function policy(req: NextRequest, publicId: string): Promise<string | null> {
  const hit = cache.get(publicId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const r = await fetch(new URL(`/api/embed-policy/${publicId}`, req.nextUrl.origin), { cache: "no-store" });
    const { frameAncestors } = (await r.json()) as { frameAncestors: string | null };
    cache.set(publicId, { value: frameAncestors, at: Date.now() });
    return frameAncestors;
  } catch {
    return "'self'"; // fail closed
  }
}

export async function middleware(req: NextRequest) {
  const m = req.nextUrl.pathname.match(/^\/embed\/([a-z0-9]{6,20})$/);
  if (!m) return NextResponse.next();
  const fa = await policy(req, m[1]);
  const res = NextResponse.next();
  res.headers.set("Content-Security-Policy", `frame-ancestors ${fa ?? "'self'"}`);
  return res;
}

export const config = { matcher: ["/embed/:path*"] };
