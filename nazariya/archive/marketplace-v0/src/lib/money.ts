const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

/** Format paise as an Indian-grouped rupee string, e.g. 1250000 -> "₹12,500". */
export function formatINR(paise: number): string {
  return inr.format(Math.round(paise / 100));
}

export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees) || rupees < 0) throw new Error("Invalid rupee amount");
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: number): number {
  return Math.round(paise) / 100;
}
