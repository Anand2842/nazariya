import { relativeAge, type FreshnessState } from "@/lib/freshness";

export function FreshnessPill({ state, lastConfirmedAt, by }: { state: FreshnessState; lastConfirmedAt: Date | string | null; by?: string | null }) {
  const tone =
    state === "fresh" ? "bg-emerald-50 text-emerald-800" : state === "due_soon" ? "bg-amber-50 text-amber-800" : "bg-rose-50 text-rose-800";
  const text = lastConfirmedAt ? `Availability confirmed ${relativeAge(lastConfirmedAt)}${by ? ` by ${by}` : ""}` : "Availability not confirmed";
  return (
    <span className={`chip ${tone}`} data-testid="freshness">
      <span className={`h-1.5 w-1.5 rounded-full ${state === "fresh" ? "bg-emerald-500" : state === "due_soon" ? "bg-amber-500" : "bg-rose-500"}`} />
      {text}
    </span>
  );
}
