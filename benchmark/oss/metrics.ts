/**
 * Statistical metrics for OSS benchmark.
 * Uses Student's t-distribution for 95% CI (appropriate for small N).
 */

export interface MetricSummary {
  n: number;
  mean: number;
  std: number;
  ci95_low: number;
  ci95_high: number;
  min: number;
  max: number;
  values: number[];
}

// t-critical values for 95% CI (two-tailed), indexed by degrees of freedom (n-1)
const T_CRIT: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
  6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262,
};

export function computeMetricSummary(values: number[]): MetricSummary {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, std: 0, ci95_low: 0, ci95_high: 0, min: 0, max: 0, values: [] };
  if (n === 1) return { n: 1, mean: values[0], std: 0, ci95_low: values[0], ci95_high: values[0], min: values[0], max: values[0], values };

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  const se = std / Math.sqrt(n);
  const df = n - 1;
  const tCrit = T_CRIT[df] || 1.96; // fallback to z-score for large N
  const ci95_low = mean - tCrit * se;
  const ci95_high = mean + tCrit * se;

  return {
    n,
    mean,
    std,
    ci95_low,
    ci95_high,
    min: Math.min(...values),
    max: Math.max(...values),
    values,
  };
}

export interface PairedComparison {
  metric: string;
  baseline_mean: number;
  cg_mean: number;
  delta_mean: number;
  delta_ci95: [number, number];
  significant: boolean;
}

export function pairedComparison(
  metric: string,
  baselineValues: number[],
  cgValues: number[],
): PairedComparison {
  const n = Math.min(baselineValues.length, cgValues.length);
  const deltas = Array.from({ length: n }, (_, i) => cgValues[i] - baselineValues[i]);
  const summary = computeMetricSummary(deltas);

  return {
    metric,
    baseline_mean: baselineValues.reduce((a, b) => a + b, 0) / Math.max(1, baselineValues.length),
    cg_mean: cgValues.reduce((a, b) => a + b, 0) / Math.max(1, cgValues.length),
    delta_mean: summary.mean,
    delta_ci95: [summary.ci95_low, summary.ci95_high],
    significant: summary.ci95_low > 0 || summary.ci95_high < 0, // CI doesn't cross zero
  };
}
