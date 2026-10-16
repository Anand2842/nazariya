"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  askOwnerAction,
  bedStatusAction,
  nightlyAction,
  publishAction,
  reconfirmAction,
  retirePlanAction,
  setPlanAction,
  setStatusAction,
  unitAvailabilityAction,
  updateDetailsAction,
  uploadAuthDocAction,
} from "@/app/actions/lister";
import { sharingLabel } from "@/lib/availability";
import { CHARGE_LABELS, computeCostSummary, type ChargeInput } from "@/lib/pricing";
import { formatINR } from "@/lib/money";
import { PriceBlock } from "../PriceBlock";

type R = { ok: boolean; error?: string; details?: string[] };
function useRun() {
  const router = useRouter();
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<R>, okMsg?: string) => {
    setBusy(true);
    setErr(null);
    const r = await f();
    setBusy(false);
    if (r.ok) {
      router.refresh();
      if (okMsg) setErr([okMsg]);
    } else setErr([r.error ?? "Failed", ...(r.details ?? [])]);
    return r.ok;
  };
  return { err, busy, run, setErr };
}

function Msgs({ err }: { err: string[] | null }) {
  if (!err) return null;
  return (
    <div className="mt-2 rounded-xl bg-amber-50 p-2 text-sm text-amber-900" role="alert" data-testid="panel-msg">
      {err.map((e) => <p key={e}>{e}</p>)}
    </div>
  );
}

// ---------- status & publish ----------
export function StatusPanel({ listingId, status, slug, checklist }: { listingId: string; status: string; slug: string; checklist: { errors: string[]; warnings: string[] } }) {
  const { err, busy, run } = useRun();
  return (
    <section className="card p-4" data-testid="status-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="section-title">Status: <span className="capitalize" data-testid="editor-status">{status}</span></p>
        <div className="flex flex-wrap gap-2">
          {["draft", "expired", "closed"].includes(status) && <button className="btn-primary" disabled={busy} onClick={() => run(() => publishAction(listingId))} data-testid="publish">Publish</button>}
          {["published", "stale", "paused"].includes(status) && <button className="btn-secondary" disabled={busy} onClick={() => run(() => reconfirmAction(listingId), "Availability confirmed")} data-testid="reconfirm-editor">Confirm still available</button>}
          {status === "published" && <button className="btn-ghost" disabled={busy} onClick={() => run(() => setStatusAction(listingId, "paused"))}>Pause</button>}
          {["published", "stale", "paused"].includes(status) && <button className="btn-ghost" disabled={busy} onClick={() => run(() => setStatusAction(listingId, "closed"))}>Mark rented / close</button>}
          {["published", "stale"].includes(status) && <a className="btn-ghost" href={`/l/${slug}`}>View public page</a>}
          {!["published", "stale"].includes(status) && <a className="btn-ghost" href={`/l/${slug}`}>Preview</a>}
        </div>
      </div>
      {checklist.errors.length > 0 && ["draft", "expired", "closed"].includes(status) && (
        <ul className="mt-3 space-y-1 text-sm text-rose-700" data-testid="publish-blockers">
          {checklist.errors.map((e) => <li key={e}>✗ {e}</li>)}
        </ul>
      )}
      {checklist.warnings.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-amber-700">
          {checklist.warnings.map((e) => <li key={e}>• {e}</li>)}
        </ul>
      )}
      <Msgs err={err} />
    </section>
  );
}

// ---------- details ----------
export function DetailsPanel({ listingId, title, description }: { listingId: string; title: string; description: string }) {
  const { err, busy, run } = useRun();
  return (
    <form className="card space-y-3 p-4" action={(fd) => void run(() => updateDetailsAction(listingId, { title: String(fd.get("title")), description: String(fd.get("description")) }), "Saved")}>
      <p className="section-title">Details</p>
      <input name="title" className="input" defaultValue={title} aria-label="Title" />
      <textarea name="description" className="input min-h-28" defaultValue={description} aria-label="Description" />
      <button className="btn-secondary" disabled={busy} type="submit">Save details</button>
      <Msgs err={err} />
    </form>
  );
}

// ---------- pricing ----------
interface ChargeRow { code: string; mode: ChargeInput["mode"]; value: string; recurrence: ChargeInput["recurrence"]; refundable: boolean; mandatory: boolean; note: string }
interface PlanView { planKey: string; label: string; appliesTo: string; basePaise: number; period: "month" | "night"; unitId: string | null; mealPlan: string | null; charges: ChargeInput[]; version: number }

const defaultCharges = (period: "month" | "night"): ChargeRow[] =>
  period === "month"
    ? [
        { code: "security_deposit", mode: "months_of_rent", value: "2", recurrence: "one_time", refundable: true, mandatory: true, note: "" },
        { code: "brokerage", mode: "none", value: "", recurrence: "one_time", refundable: false, mandatory: true, note: "" },
      ]
    : [{ code: "tax", mode: "percent", value: "5", recurrence: "nightly", refundable: false, mandatory: true, note: "GST as applicable" }];

function toRows(cs: ChargeInput[]): ChargeRow[] {
  return cs.map((c) => ({
    code: c.code,
    mode: c.mode,
    value: c.mode === "fixed" ? String((c.amountPaise ?? 0) / 100) : c.mode === "months_of_rent" ? String(c.months ?? "") : c.mode === "percent" ? String(c.percent ?? "") : "",
    recurrence: c.recurrence,
    refundable: !!c.refundable,
    mandatory: c.mandatory !== false,
    note: c.note ?? "",
  }));
}

function toCharges(rows: ChargeRow[]): ChargeInput[] {
  return rows.map((r) => ({
    code: r.code,
    mode: r.mode,
    amountPaise: r.mode === "fixed" ? Math.round(Number(r.value) * 100) : null,
    months: r.mode === "months_of_rent" ? Number(r.value) : null,
    percent: r.mode === "percent" ? Number(r.value) : null,
    recurrence: r.recurrence,
    refundable: r.refundable,
    mandatory: r.mandatory,
    note: r.note || null,
  }));
}

export function PricingEditor({ listingId, category, plans, roomTypes }: { listingId: string; category: string; plans: PlanView[]; roomTypes: { id: string; label: string }[] }) {
  const { err, busy, run } = useRun();
  const period: "month" | "night" = category === "short_stay" ? "night" : "month";
  const keyOptions =
    category === "pg"
      ? [1, 2, 3, 4].map((n) => ({ key: `bed_${["", "single", "double", "triple", "quad"][n]}`, appliesTo: `bed_${["", "single", "double", "triple", "quad"][n]}`, label: `${sharingLabel(n)} sharing`, unitId: null as string | null }))
      : category === "short_stay"
        ? roomTypes.map((u) => ({ key: `rt:${u.id}`, appliesTo: "room_type_nightly", label: u.label, unitId: u.id as string | null }))
        : [{ key: "unit_monthly", appliesTo: "unit_monthly", label: "Whole unit", unitId: null as string | null }];
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [rent, setRent] = useState("");
  const [rows, setRows] = useState<ChargeRow[]>(defaultCharges(period));
  const [keyIdx, setKeyIdx] = useState(0);
  const open = (p?: PlanView) => {
    if (p) {
      setEditing(p.planKey);
      setLabel(p.label);
      setRent(String(p.basePaise / 100));
      setRows(toRows(p.charges));
      setKeyIdx(Math.max(0, keyOptions.findIndex((k) => k.key === p.planKey)));
    } else {
      setEditing("new");
      setLabel(keyOptions[0]?.label ?? "");
      setRent("");
      setRows(defaultCharges(period));
      setKeyIdx(0);
    }
  };
  const ko = keyOptions[keyIdx];
  const previewOk = Number(rent) > 0;
  const preview = previewOk ? computeCostSummary({ planKey: ko?.key ?? "x", appliesTo: ko?.appliesTo ?? "", label: label || ko?.label || "Plan", basePaise: Math.round(Number(rent) * 100), period, charges: toCharges(rows) }) : null;
  return (
    <section className="card space-y-3 p-4" data-testid="pricing-editor">
      <div className="flex items-center justify-between">
        <p className="section-title">Pricing</p>
        <button className="btn-secondary px-3 py-1.5 text-xs" onClick={() => open()} data-testid="add-plan">+ Add plan</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {plans.map((p) => (
          <div key={p.planKey} className="rounded-xl border border-slate-200 p-3">
            <PriceBlock summary={computeCostSummary({ ...p })} />
            <div className="mt-2 flex gap-2 text-xs">
              <span className="text-slate-400">v{p.version}</span>
              <button className="text-nazar underline" onClick={() => open(p)}>Edit (new version)</button>
              <button className="text-rose-600 underline" onClick={() => run(() => retirePlanAction(listingId, p.planKey))}>Remove</button>
            </div>
          </div>
        ))}
        {!plans.length && <p className="muted">No pricing yet.</p>}
      </div>
      {editing && (
        <form
          className="space-y-2 rounded-xl bg-slate-50 p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(() =>
              setPlanAction(listingId, { planKey: ko.key, unitId: ko.unitId, appliesTo: ko.appliesTo as "unit_monthly", label: label || ko.label, basePaise: Math.round(Number(rent) * 100), period, charges: toCharges(rows) }),
            );
            if (ok) setEditing(null);
          }}
          data-testid="plan-form"
        >
          <div className="grid gap-2 sm:grid-cols-3">
            <select className="input" value={keyIdx} onChange={(e) => { setKeyIdx(Number(e.target.value)); setLabel(keyOptions[Number(e.target.value)].label); }} disabled={editing !== "new"} aria-label="Plan type">
              {keyOptions.map((k, i) => <option key={k.key} value={i}>{k.label}</option>)}
            </select>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Plan label" />
            <input className="input" type="number" min={1} value={rent} onChange={(e) => setRent(e.target.value)} placeholder={period === "month" ? "Rent ₹/month" : "Rate ₹/night"} aria-label="Base price" required data-testid="plan-rent" />
          </div>
          <p className="label mt-2">Charges</p>
          {rows.map((r, i) => (
            <div key={i} className="grid gap-1 sm:grid-cols-[1.4fr_1.2fr_0.8fr_1fr_auto_auto]" data-testid="charge-row">
              <select className="input" value={r.code} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} aria-label="Charge">
                {Object.entries(CHARGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select className="input" value={r.mode} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, mode: e.target.value as ChargeRow["mode"] } : x)))} aria-label="Mode" data-testid="charge-mode">
                <option value="fixed">Fixed ₹</option>
                <option value="months_of_rent">Months of rent</option>
                <option value="percent">Percent</option>
                <option value="metered">Metered</option>
                <option value="included">Included</option>
                <option value="none">None</option>
              </select>
              <input className="input" value={r.mode === "metered" ? r.note : r.value} disabled={["included", "none"].includes(r.mode)} onChange={(e) => setRows(rows.map((x, j) => (j === i ? (r.mode === "metered" ? { ...x, note: e.target.value } : { ...x, value: e.target.value }) : x)))} placeholder={r.mode === "metered" ? "₹/unit note" : "value"} aria-label="Value" data-testid="charge-value" />
              <select className="input" value={r.recurrence} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, recurrence: e.target.value as ChargeRow["recurrence"] } : x)))} aria-label="Recurrence">
                <option value="one_time">One-time</option>
                <option value="monthly">Monthly</option>
                <option value="nightly">Nightly</option>
              </select>
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={r.refundable} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, refundable: e.target.checked } : x)))} /> refundable</label>
              <button type="button" className="text-rose-600" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove charge">✕</button>
            </div>
          ))}
          <button type="button" className="btn-ghost text-xs" onClick={() => setRows([...rows, { code: "maintenance", mode: "fixed", value: "", recurrence: period === "month" ? "monthly" : "nightly", refundable: false, mandatory: true, note: "" }])}>+ charge</button>
          {preview && <div className="rounded-xl bg-white p-3"><p className="label">Renters will see</p><PriceBlock summary={preview} /></div>}
          <div className="flex gap-2">
            <button className="btn-primary" type="submit" disabled={busy} data-testid="plan-save">Save plan</button>
            <button className="btn-ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}
      <Msgs err={err} />
    </section>
  );
}

// ---------- availability ----------
export function AvailabilityPanel(props: {
  listingId: string;
  category: string;
  units: { id: string; label: string; kind: string; inventoryCount: number | null }[];
  beds: { id: string; unitId: string; label: string; status: string; noticeUntil: string | null; reservedUntil: string | null }[];
  availability: { unitId: string; availableFrom: string; status: string; minLeaseMonths: number | null; createdAt: string }[];
  nightly: { unitId: string; date: string; availableCount: number; ratePaise: number }[];
  today: string;
}) {
  const { err, busy, run } = useRun();
  const { listingId } = props;
  return (
    <section className="card space-y-3 p-4" id="availability" data-testid="availability-panel">
      <p className="section-title">Availability</p>
      {props.category === "pg" &&
        props.units.map((u) => (
          <div key={u.id}>
            <p className="text-sm font-semibold">{u.label}</p>
            <div className="mt-1 grid gap-2 sm:grid-cols-3">
              {props.beds.filter((b) => b.unitId === u.id).map((b) => (
                <form
                  key={b.id}
                  className="rounded-xl bg-slate-50 p-2 text-sm"
                  data-testid="bed-form"
                  action={(fd) => {
                    const status = String(fd.get("status")) as "vacant" | "occupied" | "notice" | "reserved" | "blocked";
                    const date = String(fd.get("date") || "") || null;
                    void run(() => bedStatusAction(listingId, b.id, { status, noticeUntil: status === "notice" ? date : null, reservedUntil: status === "reserved" ? date : null }), "Bed updated");
                  }}
                >
                  <p className="font-medium">Bed {b.label}</p>
                  <select name="status" defaultValue={b.status} className="input mt-1" aria-label={`Bed ${b.label} status`}>
                    <option value="vacant">Vacant</option>
                    <option value="occupied">Occupied</option>
                    <option value="notice">On notice (leaving)</option>
                    <option value="reserved">Reserved</option>
                    <option value="blocked">Blocked</option>
                  </select>
                  <input name="date" type="date" defaultValue={b.noticeUntil ?? b.reservedUntil ?? ""} className="input mt-1" aria-label="Until" />
                  <button className="btn-secondary mt-1 w-full px-2 py-1 text-xs" disabled={busy} type="submit">Update</button>
                </form>
              ))}
            </div>
          </div>
        ))}
      {props.category === "rent" &&
        props.units.map((u) => {
          const latest = props.availability.find((a) => a.unitId === u.id);
          return (
            <form
              key={u.id}
              className="grid gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-4"
              data-testid="unit-availability-form"
              action={(fd) =>
                void run(
                  () => unitAvailabilityAction(listingId, u.id, { availableFrom: String(fd.get("from")), minLeaseMonths: Number(fd.get("minLease")) || null, status: String(fd.get("status")) as "available" }),
                  "Availability updated",
                )
              }
            >
              <p className="text-sm font-semibold sm:col-span-4">{u.label}</p>
              <input name="from" type="date" className="input" defaultValue={latest?.availableFrom ?? props.today} required aria-label="Available from" />
              <input name="minLease" type="number" min={1} className="input" defaultValue={latest?.minLeaseMonths ?? 11} aria-label="Min lease months" />
              <select name="status" className="input" defaultValue={latest?.status ?? "available"} aria-label="Status">
                <option value="available">Available</option>
                <option value="on_hold">On hold</option>
                <option value="let_out">Let out (closes listing)</option>
              </select>
              <button className="btn-secondary" disabled={busy} type="submit">Save</button>
            </form>
          );
        })}
      {props.category === "short_stay" &&
        props.units.map((u) => {
          const next = props.nightly.filter((n) => n.unitId === u.id).slice(0, 14);
          return (
            <div key={u.id} className="rounded-xl bg-slate-50 p-3">
              <p className="text-sm font-semibold">{u.label} ({u.inventoryCount} rooms)</p>
              <div className="mt-1 flex gap-1 overflow-x-auto text-[11px]">
                {next.map((n) => (
                  <span key={n.date} className={`shrink-0 rounded px-1.5 py-0.5 ${n.availableCount ? "bg-emerald-100" : "bg-rose-100"}`}>{n.date.slice(5)}: {n.availableCount} @ {formatINR(n.ratePaise)}</span>
                ))}
              </div>
              <form
                className="mt-2 grid gap-2 sm:grid-cols-5"
                data-testid="nightly-form"
                action={(fd) =>
                  void run(
                    () => nightlyAction(listingId, u.id, { from: String(fd.get("from")), to: String(fd.get("to")), availableCount: Number(fd.get("count")), ratePaise: Math.round(Number(fd.get("rate")) * 100) }),
                    "Inventory updated",
                  )
                }
              >
                <input name="from" type="date" className="input" defaultValue={props.today} required aria-label="From" />
                <input name="to" type="date" className="input" required aria-label="To" />
                <input name="count" type="number" min={0} max={u.inventoryCount ?? 99} className="input" placeholder="Rooms free" required aria-label="Rooms available" />
                <input name="rate" type="number" min={1} className="input" placeholder="₹/night" required aria-label="Rate" />
                <button className="btn-secondary" disabled={busy} type="submit">Set</button>
              </form>
            </div>
          );
        })}
      <p className="text-xs text-slate-500">Any availability update also counts as confirming the listing is current.</p>
      <Msgs err={err} />
    </section>
  );
}

// ---------- authorisation ----------
export function AuthorizationPanel({
  listingId,
  authorization,
  owner,
  checks,
  category,
}: {
  listingId: string;
  authorization: { id: string; status: string; basis: string; exclusive: boolean } | null;
  owner: { name: string; phoneMasked: string } | null;
  checks: { id: string; checkType: string; status: string; reason: string | null; createdAt: string }[];
  category: string;
}) {
  const { err, busy, run } = useRun();
  if (!authorization) return null;
  const docType = category === "short_stay" ? "hotel_registration" : authorization.basis === "operator_lease" ? "operator_lease" : "ownership_document";
  return (
    <section className="card space-y-3 p-4" data-testid="authorization-panel">
      <p className="section-title">Owner authorisation</p>
      <p className="text-sm">
        Status: <b className="capitalize" data-testid="auth-status">{authorization.status}</b> · basis {authorization.basis.replace(/_/g, " ")}
        {authorization.exclusive ? " · exclusive" : ""}
      </p>
      {owner && <p className="text-sm text-slate-600">Owner: {owner.name} ({owner.phoneMasked})</p>}
      {authorization.status !== "active" && (
        <button className="btn-primary" disabled={busy} onClick={() => run(() => askOwnerAction(listingId, authorization.id), "Confirmation request sent to the owner on WhatsApp")} data-testid="ask-owner">
          Ask owner to confirm
        </button>
      )}
      <form
        className="space-y-2 rounded-xl bg-slate-50 p-3"
        action={(fd) => void run(() => uploadAuthDocAction(listingId, authorization.id, docType, fd), "Document submitted for review")}
      >
        <p className="text-sm font-medium">Upload {docType.replace(/_/g, " ")} (private, reviewed by Nazariya only)</p>
        <input type="file" name="file" accept="image/jpeg,image/png,application/pdf" required className="text-sm" />
        <button className="btn-secondary px-3 py-1.5 text-xs" disabled={busy} type="submit">Submit document</button>
      </form>
      <ul className="space-y-1 text-sm">
        {checks.map((c) => (
          <li key={c.id} className="flex justify-between gap-2">
            <span>{c.checkType.replace(/_/g, " ")}</span>
            <span className={c.status === "passed" ? "text-emerald-700" : c.status === "needs_review" ? "text-amber-700" : "text-rose-700"}>{c.status.replace("_", " ")}{c.reason ? ` (${c.reason})` : ""}</span>
          </li>
        ))}
      </ul>
      <Msgs err={err} />
    </section>
  );
}
