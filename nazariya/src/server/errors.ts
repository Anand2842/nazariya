export class DomainError extends Error {
  constructor(
    message: string,
    public code: "not_found" | "forbidden" | "invalid" | "conflict" | "blocked" = "invalid",
    public details: string[] = [],
  ) {
    super(message);
  }
}

/** Drizzle wraps driver errors ("Failed query: ...") and keeps the Postgres error in `cause`. */
export function rootMessage(e: unknown): string {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const c = (cur as { cause?: unknown }).cause;
    if (!c) break;
    cur = c;
  }
  return (cur as { message?: string })?.message ?? String(e);
}

export function errorMessage(e: unknown): string {
  if (e instanceof DomainError && e.details.length) return `${e.message}: ${e.details.join("; ")}`;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function shortId(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
