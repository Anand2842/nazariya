// Structured pricing. One source of truth for every place a price is shown
// (search cards, listing page, viewer sheet, compare table, enquiry snapshot).
import { formatINR } from "./money";

export type ChargeMode = "fixed" | "months_of_rent" | "percent" | "metered" | "included" | "none";
export type Recurrence = "one_time" | "monthly" | "nightly";

export interface ChargeInput {
  code: string;
  mode: ChargeMode;
  amountPaise?: number | null;
  months?: number | null;
  percent?: number | null;
  recurrence: Recurrence;
  refundable?: boolean;
  mandatory?: boolean;
  note?: string | null;
}

export interface PlanInput {
  planKey: string;
  appliesTo: string;
  label: string;
  basePaise: number;
  period: "month" | "night";
  mealPlan?: string | null;
  charges: ChargeInput[];
}

export const CHARGE_LABELS: Record<string, string> = {
  security_deposit: "Security deposit",
  brokerage: "Brokerage",
  maintenance: "Maintenance",
  electricity: "Electricity",
  water: "Water",
  food: "Food",
  admission_fee: "One-time admission fee",
  parking: "Parking",
  tax: "Taxes",
  extra_bed: "Extra bed",
  lock_in_penalty: "Lock-in penalty",
  laundry: "Laundry",
};

export interface ChargeLine {
  code: string;
  label: string;
  recurrence: Recurrence;
  refundable: boolean;
  mandatory: boolean;
  /** Resolved amount in paise when it is a known number, otherwise null. */
  amountPaise: number | null;
  /** Human text, always present: "₹25,000", "Included", "None", "As per meter (₹9/unit)". */
  text: string;
}

export interface CostSummary {
  planKey: string;
  label: string;
  period: "month" | "night";
  basePaise: number;
  lines: ChargeLine[];
  /** Rent + known mandatory recurring monthly charges. */
  monthlyRecurringPaise: number;
  /** Known mandatory one-time charges (deposit, brokerage, admission...). */
  oneTimePaise: number;
  /** What a renter pays to move in: first month's recurring + one-time charges. */
  moveInPaise: number;
  depositPaise: number | null;
  brokeragePaise: number | null;
  brokerageDisclosed: boolean;
  depositDisclosed: boolean;
  hasVariableCharges: boolean;
}

export function resolveCharge(c: ChargeInput, basePaise: number): ChargeLine {
  const label = CHARGE_LABELS[c.code] ?? c.code.replace(/_/g, " ");
  const base = {
    code: c.code,
    label,
    recurrence: c.recurrence,
    refundable: !!c.refundable,
    mandatory: c.mandatory !== false,
  };
  switch (c.mode) {
    case "fixed": {
      const amt = c.amountPaise ?? 0;
      return { ...base, amountPaise: amt, text: formatINR(amt) + suffix(c.recurrence) };
    }
    case "months_of_rent": {
      const months = c.months ?? 0;
      const amt = Math.round(basePaise * months);
      return { ...base, amountPaise: amt, text: `${formatINR(amt)} (${trimNum(months)} month${months === 1 ? "" : "s"}' rent)` };
    }
    case "percent": {
      const pct = c.percent ?? 0;
      const amt = Math.round((basePaise * pct) / 100);
      return { ...base, amountPaise: amt, text: `${trimNum(pct)}% (${formatINR(amt)}${suffix(c.recurrence)})` };
    }
    case "metered":
      return { ...base, amountPaise: null, text: c.note ? `As per meter (${c.note})` : "As per meter" };
    case "included":
      return { ...base, amountPaise: 0, text: "Included" };
    case "none":
      return { ...base, amountPaise: 0, text: c.code === "brokerage" ? "No brokerage" : "None" };
  }
}

function suffix(r: Recurrence): string {
  return r === "monthly" ? "/month" : r === "nightly" ? "/night" : "";
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function computeCostSummary(plan: PlanInput): CostSummary {
  const lines = plan.charges.map((c) => resolveCharge(c, plan.basePaise));
  let monthlyRecurringPaise = plan.period === "month" ? plan.basePaise : 0;
  let oneTimePaise = 0;
  let hasVariableCharges = false;
  for (const l of lines) {
    if (l.amountPaise === null) {
      hasVariableCharges = true;
      continue;
    }
    if (!l.mandatory) continue;
    if (l.recurrence === "monthly") monthlyRecurringPaise += l.amountPaise;
    if (l.recurrence === "one_time") oneTimePaise += l.amountPaise;
  }
  const dep = lines.find((l) => l.code === "security_deposit");
  const brk = lines.find((l) => l.code === "brokerage");
  return {
    planKey: plan.planKey,
    label: plan.label,
    period: plan.period,
    basePaise: plan.basePaise,
    lines,
    monthlyRecurringPaise,
    oneTimePaise,
    moveInPaise: monthlyRecurringPaise + oneTimePaise,
    depositPaise: dep ? dep.amountPaise : null,
    brokeragePaise: brk ? brk.amountPaise : null,
    brokerageDisclosed: !!brk,
    depositDisclosed: !!dep,
    hasVariableCharges,
  };
}

/** Publishing rule: monthly plans must declare deposit and brokerage (brokerage may be "none"). */
export function disclosureErrors(plan: PlanInput): string[] {
  const errs: string[] = [];
  if (!(plan.basePaise > 0)) errs.push(`${plan.label}: rent must be greater than zero`);
  if (plan.period === "month") {
    if (!plan.charges.some((c) => c.code === "brokerage")) errs.push(`${plan.label}: brokerage must be declared (choose "No brokerage" if none)`);
    if (!plan.charges.some((c) => c.code === "security_deposit")) errs.push(`${plan.label}: security deposit must be declared`);
  }
  for (const c of plan.charges) {
    if (c.mode === "fixed" && !(Number(c.amountPaise) >= 0)) errs.push(`${plan.label}: ${c.code} needs an amount`);
    if (c.mode === "months_of_rent" && !(Number(c.months) > 0)) errs.push(`${plan.label}: ${c.code} needs number of months`);
    if (c.mode === "percent" && !(Number(c.percent) > 0)) errs.push(`${plan.label}: ${c.code} needs a percentage`);
  }
  return errs;
}

export interface NightRate {
  date: string; // YYYY-MM-DD
  ratePaise: number;
  availableCount: number;
  closedToArrival?: boolean;
  minStay?: number;
}

export interface StayQuote {
  nights: number;
  available: boolean;
  unavailableDates: string[];
  roomSubtotalPaise: number;
  taxPaise: number;
  otherPaise: number;
  totalPaise: number;
  perNight: { date: string; ratePaise: number }[];
  reason?: string;
}

/** Quote a hotel stay [from, to) for a room type using nightly inventory and the plan's charges. */
export function quoteStay(rates: NightRate[], from: string, to: string, charges: ChargeInput[], rooms = 1): StayQuote {
  const nightsList = eachNight(from, to);
  const byDate = new Map(rates.map((r) => [r.date, r]));
  const perNight: { date: string; ratePaise: number }[] = [];
  const unavailableDates: string[] = [];
  for (const d of nightsList) {
    const r = byDate.get(d);
    if (!r || r.availableCount < rooms) unavailableDates.push(d);
    else perNight.push({ date: d, ratePaise: r.ratePaise });
  }
  const first = byDate.get(nightsList[0] ?? "");
  let reason: string | undefined;
  if (nightsList.length === 0) reason = "Check-out must be after check-in";
  else if (unavailableDates.length) reason = "Sold out on some nights";
  else if (first?.closedToArrival) reason = "Arrival not allowed on this date";
  else if (first?.minStay && nightsList.length < first.minStay) reason = `Minimum stay is ${first.minStay} nights`;
  const roomSubtotalPaise = perNight.reduce((s, n) => s + n.ratePaise, 0) * rooms;
  let taxPaise = 0;
  let otherPaise = 0;
  for (const c of charges) {
    if (c.mandatory === false) continue;
    if (c.code === "tax" && c.mode === "percent") {
      taxPaise += perNight.reduce((s, n) => s + Math.round((n.ratePaise * (c.percent ?? 0)) / 100), 0) * rooms;
    } else if (c.mode === "fixed" && c.recurrence === "nightly") otherPaise += (c.amountPaise ?? 0) * perNight.length * rooms;
    else if (c.mode === "fixed" && c.recurrence === "one_time") otherPaise += c.amountPaise ?? 0;
  }
  const available = !reason;
  return {
    nights: nightsList.length,
    available,
    unavailableDates,
    roomSubtotalPaise,
    taxPaise,
    otherPaise,
    totalPaise: roomSubtotalPaise + taxPaise + otherPaise,
    perNight,
    reason,
  };
}

export function eachNight(from: string, to: string): string[] {
  const out: string[] = [];
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end) return out;
  for (let d = start; d < end; d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10));
  return out.slice(0, 60);
}

function parseDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}
