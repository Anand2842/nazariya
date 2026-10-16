"use client";
import { useState } from "react";

export function OtpLogin({ onDone, compact = false }: { onDone: () => void; compact?: boolean }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);

  async function post(url: string, body: unknown) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed");
    return data;
  }

  return (
    <form
      className={compact ? "space-y-2" : "space-y-3"}
      data-testid="otp-login"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          if (step === "phone") {
            const r = await post("/api/auth/otp/request", { phone });
            setDevCode(r.devCode ?? null);
            setStep("code");
          } else {
            await post("/api/auth/otp/verify", { phone, code });
            onDone();
          }
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {step === "phone" ? (
        <div>
          <label className="label" htmlFor="phone">Mobile number</label>
          <div className="flex gap-2">
            <span className="input w-16 shrink-0 text-center text-slate-500">+91</span>
            <input id="phone" name="phone" className="input" inputMode="tel" autoComplete="tel" placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </div>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="code">6-digit code sent to +91 {phone}</label>
          <input id="code" name="code" className="input tracking-[0.4em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />
          {devCode && (
            <p className="mt-1 text-xs text-amber-700" data-testid="dev-otp">
              Dev mode code: <b>{devCode}</b>
            </p>
          )}
          <button type="button" className="mt-1 text-xs text-nazar underline" onClick={() => { setStep("phone"); setCode(""); }}>Change number</button>
        </div>
      )}
      {error && <p className="text-sm text-rose-600" role="alert">{error}</p>}
      <button className="btn-primary w-full" disabled={busy} type="submit" data-testid="otp-submit">
        {busy ? "Please wait…" : step === "phone" ? "Send code" : "Verify & continue"}
      </button>
      <p className="text-xs text-slate-500">We use your number to verify you and to let listers reply. It is shared with a lister only when you enquire.</p>
    </form>
  );
}
