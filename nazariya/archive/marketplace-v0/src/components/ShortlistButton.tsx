"use client";
import { useEffect, useState } from "react";

const KEY = "nz_shortlist";
export function readShortlist(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function ShortlistButton({ id }: { id: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => setOn(readShortlist().includes(id)), [id]);
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? "Remove from shortlist" : "Add to shortlist"}
      data-testid="shortlist-toggle"
      className={`rounded-full border px-2 py-1 text-sm ${on ? "border-saffron bg-amber-50" : "border-slate-200 bg-white"}`}
      onClick={() => {
        let list = readShortlist();
        list = list.includes(id) ? list.filter((x) => x !== id) : [...list, id].slice(-4);
        try {
          localStorage.setItem(KEY, JSON.stringify(list));
        } catch {}
        setOn(list.includes(id));
      }}
    >
      {on ? "★" : "☆"}
    </button>
  );
}
