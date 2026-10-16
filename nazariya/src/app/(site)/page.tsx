import Link from "next/link";
import { SPACE_KINDS } from "@/lib/catalog";
import { demoSpaces } from "@/server/demo";

export const dynamic = "force-dynamic";

export default async function Landing() {
  const demos = await demoSpaces();
  const featured = demos[0];
  return (
    <div>
      <section className="bg-gradient-to-b from-nazar-light/60 to-paper">
        <div className="mx-auto grid max-w-6xl items-center gap-8 px-4 py-12 lg:grid-cols-[1fr_1.2fr] lg:py-16">
          <div>
            <p className="chip bg-white text-nazar">For real-estate developers, brokers & hotels</p>
            <h1 className="mt-3 text-3xl font-extrabold leading-tight text-ink sm:text-5xl">Turn property images into 3D tours buyers can walk through.</h1>
            <p className="mt-3 text-lg text-ink-soft">Upload 360° images, photos, a walkthrough video or a 3D scan. Nazariya builds an interactive 3D/360° tour you embed on your website or app with one line of code.</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link className="btn-primary px-5 py-3" href="/login?next=/studio" data-testid="cta-start">Create your first tour</Link>
              <a className="btn-secondary px-5 py-3" href="#demo">See a live demo</a>
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-ink shadow-xl" id="demo">
            {featured ? (
              <iframe src={`/embed/${featured.publicId}`} title={`${featured.name}: 3D tour`} className="block h-[420px] w-full border-0" allow="fullscreen; gyroscope; accelerometer" data-testid="landing-embed" />
            ) : (
              <div className="grid h-[420px] place-items-center text-white/70">Run the seed to load demo tours</div>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-10">
        <h2 className="text-2xl font-bold">How it works</h2>
        <ol className="mt-4 grid gap-4 sm:grid-cols-3">
          {[
            ["1. Upload", "Add rooms and upload a 360° image per room (any 360° camera or phone 360° mode), photos, a walkthrough video or a 3D scan export."],
            ["2. We build the tour", "Images are optimised automatically; every 360° image becomes a 3D walkthrough. Add hotspots for features and doors between rooms."],
            ["3. Embed anywhere", "Copy the iframe or SDK snippet into your website, CMS (oEmbed) or app WebView. Restrict it to your domains and track views."],
          ].map(([t, d]) => (
            <li key={t} className="card p-5"><p className="font-bold text-ink">{t}</p><p className="mt-1 text-sm text-slate-600">{d}</p></li>
          ))}
        </ol>
      </section>

      {demos.length > 1 && (
        <section className="mx-auto max-w-6xl px-4 pb-6">
          <h2 className="mb-3 text-2xl font-bold">More demo tours</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {demos.map((d) => (
              <div key={d.publicId} className="card overflow-hidden">
                <iframe src={`/embed/${d.publicId}?rooms=0`} title={d.name} loading="lazy" className="block h-56 w-full border-0" />
                <div className="flex items-center justify-between p-3 text-sm">
                  <span><b>{d.name}</b><span className="block text-xs text-slate-500">{SPACE_KINDS[d.kind]}</span></span>
                  <a className="text-nazar underline" href={`/t/${d.publicId}`} target="_blank">Open ↗</a>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mx-auto max-w-6xl px-4 py-6">
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            ["Works on every phone", "3D where the device supports it, automatic fallback to 360° or photos where it doesn't. Optimised, progressively loaded scenes."],
            ["Your brand, your domains", "Brand colour and logo in the viewer, white-label on Pro, and a per-tour allow-list of websites that may embed it."],
            ["Built for developers", "JavaScript SDK with room/view control and events, REST API with API keys, oEmbed for WordPress and other CMSs."],
          ].map(([t, d]) => (
            <div key={t} className="card p-5"><p className="font-bold text-ink">{t}</p><p className="mt-1 text-sm text-slate-600">{d}</p></div>
          ))}
        </div>
      </section>
    </div>
  );
}
