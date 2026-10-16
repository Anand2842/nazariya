import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { isPublicKey, openStream, sizeOf } from "@/server/storage";

const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", spz: "application/octet-stream", mp4: "video/mp4" };

// Serves PUBLIC derived media only. Keys are content-addressed, so responses are immutable.
export async function GET(_req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  const { key: parts } = await ctx.params;
  const key = parts.join("/");
  if (!isPublicKey(key)) return new NextResponse("Not found", { status: 404 });
  try {
    const size = await sizeOf(key);
    const ext = key.split(".").pop() ?? "";
    const stream = Readable.toWeb(openStream(key)) as ReadableStream;
    return new NextResponse(stream, {
      headers: {
        "Content-Type": TYPES[ext] ?? "application/octet-stream",
        "Content-Length": String(size),
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
