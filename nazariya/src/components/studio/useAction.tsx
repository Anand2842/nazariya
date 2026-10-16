"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

type R = { ok: boolean; error?: string; details?: string[]; data?: unknown };

export function useAction() {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; lines: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async <T extends R>(f: () => Promise<T>, okMsg?: string): Promise<T> => {
    setBusy(true);
    setMsg(null);
    const r = await f();
    setBusy(false);
    if (r.ok) {
      router.refresh();
      if (okMsg) setMsg({ tone: "ok", lines: [okMsg] });
    } else setMsg({ tone: "err", lines: [r.error ?? "Failed", ...(r.details ?? [])] });
    return r;
  };
  return { msg, busy, run, setMsg };
}

export function Msg({ msg }: { msg: { tone: "ok" | "err"; lines: string[] } | null }) {
  if (!msg) return null;
  return (
    <div className={`mt-2 rounded-xl p-2 text-sm ${msg.tone === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`} role={msg.tone === "err" ? "alert" : "status"} data-testid="action-msg">
      {msg.lines.map((l) => <p key={l}>{l}</p>)}
    </div>
  );
}
