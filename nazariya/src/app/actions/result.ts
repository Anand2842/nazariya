import { ZodError } from "zod";
import { AuthError } from "@/server/auth";
import { DomainError, rootMessage } from "@/server/errors";

export type ActionResult<T = unknown> = { ok: true; data?: T } | { ok: false; error: string; details?: string[] };

export async function act<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, error: e.message, details: e.details };
    if (e instanceof AuthError) return { ok: false, error: e.message };
    if (e instanceof ZodError) return { ok: false, error: "Please check the form", details: e.issues.map((i) => `${i.path.join(".") || "field"}: ${i.message}`) };
    // Postgres trust-rule triggers surface as errors with a message we can show.
    const msg = rootMessage(e);
    if (/append-only|insert-only|cannot be published|immutable/.test(msg)) return { ok: false, error: msg };
    console.error(e);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
