import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-20 text-center">
      <h1 className="text-3xl font-extrabold">Page not found</h1>
      <p className="muted mt-2">The page may have moved, or the listing may no longer be available.</p>
      <Link className="btn-primary mt-6" href="/search">Explore listings</Link>
    </div>
  );
}
