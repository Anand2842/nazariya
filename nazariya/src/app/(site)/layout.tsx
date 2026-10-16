import Link from "next/link";
import { Logo } from "@/components/Logo";
import { devToolsEnabled } from "@/server/notify";
import { getCurrentUser, hasWorkspace, isAdmin } from "@/server/session";

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const dev = devToolsEnabled();
  return (
    <>
      {dev && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
          Local demo · OTP codes appear in the <Link className="font-semibold underline" href="/dev/outbox">dev outbox</Link> · demo rooms use CC0 imagery
        </div>
      )}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="flex items-center gap-2" aria-label="Nazariya home">
            <Logo />
            <span className="text-lg font-extrabold tracking-tight text-ink">Nazariya</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link className="btn-ghost hidden sm:inline-flex" href="/#demo">Demo</Link>
            <Link className="btn-ghost hidden sm:inline-flex" href="/docs">Developers</Link>
            {hasWorkspace(user) && <Link className="btn-ghost" href="/studio" data-testid="nav-studio">Studio</Link>}
            {isAdmin(user) && <Link className="btn-ghost" href="/admin">Admin</Link>}
            {user ? (
              <form action="/api/auth/logout" method="post">
                <button className="btn-ghost" type="submit">Log out</button>
              </form>
            ) : (
              <Link className="btn-primary" href="/login?next=/studio" data-testid="nav-login">Start free</Link>
            )}
          </nav>
        </div>
      </header>
      <main>{children}</main>
      <footer className="mt-16 border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-4 px-4 py-8 text-sm text-slate-500">
          <div className="flex items-center gap-2 font-bold text-ink"><Logo className="h-6 w-6" /> Nazariya</div>
          <p className="max-w-xl">Nazariya (नज़रिया, &ldquo;perspective&rdquo;) turns your property images into interactive 360° and 3D tours you can embed anywhere. 3D scenes are visual aids, not measurements.</p>
        </div>
      </footer>
    </>
  );
}
