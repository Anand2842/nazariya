import { formatINR } from "@/lib/money";
import type { CostSummary } from "@/lib/pricing";

/** The ONE component that renders charges everywhere (listing page, viewer sheet, compare, enquiry). */
export function PriceBlock({ summary, compact = false, testId }: { summary: CostSummary; compact?: boolean; testId?: string }) {
  const per = summary.period === "month" ? "/month" : "/night";
  return (
    <div data-testid={testId ?? `price-${summary.planKey}`} className={compact ? "" : "space-y-2"}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-semibold text-ink">{summary.label}</div>
        <div className="text-right">
          <span className="text-xl font-extrabold text-ink" data-testid="price-base">{formatINR(summary.basePaise)}</span>
          <span className="text-sm text-slate-500">{per}</span>
        </div>
      </div>
      {!compact && (
        <dl className="divide-y divide-slate-100 rounded-xl bg-slate-50 px-3 text-sm">
          {summary.lines.map((l) => (
            <div key={l.code} className="flex justify-between gap-3 py-1.5">
              <dt className="text-slate-600">
                {l.label}
                {l.refundable && <span className="ml-1 text-xs text-emerald-700">(refundable)</span>}
                {!l.mandatory && <span className="ml-1 text-xs text-slate-400">(optional)</span>}
              </dt>
              <dd className="text-right font-medium text-ink" data-testid={`charge-${l.code}`}>{l.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {summary.period === "month" && (
        <div className="flex justify-between text-sm">
          <span className="text-slate-600">To move in{summary.hasVariableCharges ? " (excl. metered)" : ""}</span>
          <span className="font-bold text-nazar" data-testid="price-movein">{formatINR(summary.moveInPaise)}</span>
        </div>
      )}
      {summary.period === "month" && !compact && (
        <div className="flex justify-between text-xs text-slate-500">
          <span>Monthly after move-in</span>
          <span>{formatINR(summary.monthlyRecurringPaise)}{summary.hasVariableCharges ? " + metered" : ""}</span>
        </div>
      )}
    </div>
  );
}
