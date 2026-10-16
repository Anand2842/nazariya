import { describe, expect, it } from "vitest";
import { formatINR, rupeesToPaise } from "@/lib/money";
import { computeCostSummary, disclosureErrors, eachNight, quoteStay, type PlanInput } from "@/lib/pricing";

const pg: PlanInput = {
  planKey: "bed_double",
  appliesTo: "bed_double",
  label: "Double sharing",
  basePaise: rupeesToPaise(10500),
  period: "month",
  charges: [
    { code: "security_deposit", mode: "months_of_rent", months: 1, recurrence: "one_time", refundable: true },
    { code: "brokerage", mode: "none", recurrence: "one_time" },
    { code: "admission_fee", mode: "fixed", amountPaise: rupeesToPaise(2000), recurrence: "one_time" },
    { code: "electricity", mode: "metered", recurrence: "monthly", note: "₹9/unit" },
    { code: "food", mode: "included", recurrence: "monthly" },
  ],
};

describe("money", () => {
  it("formats rupees with Indian grouping", () => {
    expect(formatINR(rupeesToPaise(125000))).toBe("₹1,25,000");
    expect(formatINR(0)).toBe("₹0");
  });
  it("rejects negative amounts", () => {
    expect(() => rupeesToPaise(-1)).toThrow();
  });
});

describe("computeCostSummary", () => {
  it("computes move-in and monthly totals for a PG plan with metered electricity", () => {
    const s = computeCostSummary(pg);
    expect(s.depositPaise).toBe(rupeesToPaise(10500));
    expect(s.brokeragePaise).toBe(0);
    expect(s.brokerageDisclosed).toBe(true);
    expect(s.oneTimePaise).toBe(rupeesToPaise(12500));
    expect(s.monthlyRecurringPaise).toBe(rupeesToPaise(10500));
    expect(s.moveInPaise).toBe(rupeesToPaise(23000));
    expect(s.hasVariableCharges).toBe(true);
    expect(s.lines.find((l) => l.code === "brokerage")?.text).toBe("No brokerage");
    expect(s.lines.find((l) => l.code === "electricity")?.text).toBe("As per meter (₹9/unit)");
  });

  it("handles fractional months and monthly maintenance for flats", () => {
    const s = computeCostSummary({
      planKey: "unit_monthly",
      appliesTo: "unit_monthly",
      label: "Whole flat",
      basePaise: rupeesToPaise(32000),
      period: "month",
      charges: [
        { code: "security_deposit", mode: "months_of_rent", months: 2, recurrence: "one_time", refundable: true },
        { code: "brokerage", mode: "months_of_rent", months: 0.5, recurrence: "one_time" },
        { code: "maintenance", mode: "fixed", amountPaise: rupeesToPaise(3500), recurrence: "monthly" },
      ],
    });
    expect(s.brokeragePaise).toBe(rupeesToPaise(16000));
    expect(s.monthlyRecurringPaise).toBe(rupeesToPaise(35500));
    expect(s.moveInPaise).toBe(rupeesToPaise(35500 + 64000 + 16000));
    expect(s.lines.find((l) => l.code === "brokerage")?.text).toContain("0.5 months");
  });

  it("excludes optional charges from totals", () => {
    const s = computeCostSummary({ ...pg, charges: [...pg.charges, { code: "parking", mode: "fixed", amountPaise: 50000, recurrence: "monthly", mandatory: false }] });
    expect(s.monthlyRecurringPaise).toBe(rupeesToPaise(10500));
  });
});

describe("disclosureErrors", () => {
  it("requires brokerage and deposit for monthly plans", () => {
    const errs = disclosureErrors({ ...pg, charges: [] });
    expect(errs.join(" ")).toMatch(/brokerage must be declared/);
    expect(errs.join(" ")).toMatch(/security deposit must be declared/);
  });
  it("accepts brokerage 'none'", () => {
    expect(disclosureErrors(pg)).toEqual([]);
  });
  it("rejects incomplete charge values and zero rent", () => {
    const errs = disclosureErrors({ ...pg, basePaise: 0, charges: [...pg.charges, { code: "maintenance", mode: "months_of_rent", months: 0, recurrence: "monthly" }] });
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });
  it("does not require brokerage for nightly hotel plans", () => {
    expect(disclosureErrors({ planKey: "rt", appliesTo: "room_type_nightly", label: "Deluxe", basePaise: 280000, period: "night", charges: [] })).toEqual([]);
  });
});

describe("quoteStay", () => {
  const rates = ["2026-11-01", "2026-11-02", "2026-11-03"].map((date, i) => ({ date, ratePaise: 280000, availableCount: i === 2 ? 0 : 3 }));
  const tax = [{ code: "tax", mode: "percent" as const, percent: 5, recurrence: "nightly" as const }];
  it("totals nights and taxes", () => {
    const q = quoteStay(rates, "2026-11-01", "2026-11-03", tax);
    expect(q.nights).toBe(2);
    expect(q.available).toBe(true);
    expect(q.roomSubtotalPaise).toBe(560000);
    expect(q.taxPaise).toBe(28000);
    expect(q.totalPaise).toBe(588000);
  });
  it("flags sold-out nights", () => {
    const q = quoteStay(rates, "2026-11-02", "2026-11-04", tax);
    expect(q.available).toBe(false);
    expect(q.unavailableDates).toEqual(["2026-11-03"]);
  });
  it("enforces min stay and invalid ranges", () => {
    expect(quoteStay([{ date: "2026-11-01", ratePaise: 1, availableCount: 1, minStay: 2 }], "2026-11-01", "2026-11-02", []).reason).toMatch(/Minimum stay/);
    expect(quoteStay(rates, "2026-11-03", "2026-11-01", []).available).toBe(false);
    expect(eachNight("bad", "2026-11-01")).toEqual([]);
  });
});
