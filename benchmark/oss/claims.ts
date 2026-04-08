/**
 * Claims framework: only makes claims the data supports.
 */

import type { MetricSummary } from './metrics.js';

export type ClaimStatus = 'SUPPORTED' | 'NOT_SUPPORTED' | 'INSUFFICIENT_DATA';

export interface Claim {
  id: string;
  statement: string;
  status: ClaimStatus;
  evidence: string;
  caveats: string[];
}

export function evaluateClaims(data: {
  shouldHelp: { tokenReduction: MetricSummary; accuracyDelta: MetricSummary; latencyRatio: MetricSummary };
  shouldNotHelp: { falsePositiveRate: MetricSummary };
  overall: { accuracy: { baseline: MetricSummary; cg: MetricSummary }; fnr: MetricSummary };
  repeats: number;
  scenarioCount: number;
}): Claim[] {
  const claims: Claim[] = [];

  // Claim 1: Token reduction
  const tr = data.shouldHelp.tokenReduction;
  if (tr.n < 2) {
    claims.push({ id: 'token-reduction', statement: 'Context Guardian reduces cloud token usage on large contexts', status: 'INSUFFICIENT_DATA', evidence: `Only ${tr.n} data points`, caveats: [] });
  } else if (tr.mean > 0.5 && tr.ci95_low > 0.3) {
    claims.push({ id: 'token-reduction', statement: 'Context Guardian reduces cloud token usage on large contexts', status: 'SUPPORTED', evidence: `${(tr.mean * 100).toFixed(1)}% mean reduction [${(tr.ci95_low * 100).toFixed(1)}%, ${(tr.ci95_high * 100).toFixed(1)}%] 95% CI`, caveats: ['On scenarios with >10K tokens of context', `N=${tr.n}, ${data.repeats} repeats`] });
  } else {
    claims.push({ id: 'token-reduction', statement: 'Context Guardian reduces cloud token usage on large contexts', status: 'NOT_SUPPORTED', evidence: `${(tr.mean * 100).toFixed(1)}% mean, CI lower bound ${(tr.ci95_low * 100).toFixed(1)}%`, caveats: [] });
  }

  // Claim 2: Accuracy preserved
  const ad = data.shouldHelp.accuracyDelta;
  if (ad.n < 2) {
    claims.push({ id: 'accuracy-preserved', statement: 'Context Guardian preserves answer accuracy', status: 'INSUFFICIENT_DATA', evidence: `Only ${ad.n} data points`, caveats: [] });
  } else if (ad.mean > -0.05 && ad.ci95_low > -0.10) {
    const stronger = ad.mean > 0 && ad.ci95_low > 0;
    claims.push({
      id: 'accuracy-preserved',
      statement: stronger ? 'Context Guardian improves answer accuracy' : 'Context Guardian preserves answer accuracy (within 5pp)',
      status: 'SUPPORTED',
      evidence: `${(ad.mean * 100).toFixed(1)}pp delta [${(ad.ci95_low * 100).toFixed(1)}pp, ${(ad.ci95_high * 100).toFixed(1)}pp] 95% CI`,
      caveats: [`N=${ad.n}`, `${data.repeats} repeats`, `${data.scenarioCount} scenarios`],
    });
  } else {
    claims.push({ id: 'accuracy-preserved', statement: 'Context Guardian preserves answer accuracy', status: 'NOT_SUPPORTED', evidence: `${(ad.mean * 100).toFixed(1)}pp delta, CI lower bound ${(ad.ci95_low * 100).toFixed(1)}pp`, caveats: [] });
  }

  // Claim 3: Latency overhead
  const lr = data.shouldHelp.latencyRatio;
  if (lr.n < 2) {
    claims.push({ id: 'latency-overhead', statement: 'Context Guardian has acceptable latency overhead (<3x)', status: 'INSUFFICIENT_DATA', evidence: `Only ${lr.n} data points`, caveats: [] });
  } else if (lr.mean < 3.0 && lr.ci95_high < 5.0) {
    claims.push({ id: 'latency-overhead', statement: 'Context Guardian has acceptable latency overhead (<3x)', status: 'SUPPORTED', evidence: `${lr.mean.toFixed(2)}x mean [${lr.ci95_low.toFixed(2)}x, ${lr.ci95_high.toFixed(2)}x] 95% CI`, caveats: [`N=${lr.n}`] });
  } else {
    claims.push({ id: 'latency-overhead', statement: 'Context Guardian has acceptable latency overhead (<3x)', status: 'NOT_SUPPORTED', evidence: `${lr.mean.toFixed(2)}x mean, CI upper ${lr.ci95_high.toFixed(2)}x`, caveats: [] });
  }

  // Claim 4: False positive rate
  const fpr = data.shouldNotHelp.falsePositiveRate;
  if (fpr.n < 2) {
    claims.push({ id: 'false-positive-rate', statement: 'Context Guardian correctly passes through small/focused prompts (FPR < 20%)', status: 'INSUFFICIENT_DATA', evidence: `Only ${fpr.n} data points`, caveats: [] });
  } else if (fpr.mean < 0.20) {
    claims.push({ id: 'false-positive-rate', statement: 'Context Guardian correctly passes through small/focused prompts (FPR < 20%)', status: 'SUPPORTED', evidence: `${(fpr.mean * 100).toFixed(1)}% FPR [${(fpr.ci95_low * 100).toFixed(1)}%, ${(fpr.ci95_high * 100).toFixed(1)}%] 95% CI`, caveats: [`${data.scenarioCount} negative scenarios tested`] });
  } else {
    claims.push({ id: 'false-positive-rate', statement: 'Context Guardian correctly passes through small/focused prompts (FPR < 20%)', status: 'NOT_SUPPORTED', evidence: `${(fpr.mean * 100).toFixed(1)}% FPR`, caveats: [] });
  }

  // Claim 5: False negative rate
  const fnr = data.overall.fnr;
  if (fnr.n < 2) {
    claims.push({ id: 'false-negative-rate', statement: 'Context Guardian activates reliably on large/noisy contexts (FNR < 10%)', status: 'INSUFFICIENT_DATA', evidence: `Only ${fnr.n} data points`, caveats: [] });
  } else if (fnr.mean < 0.10) {
    claims.push({ id: 'false-negative-rate', statement: 'Context Guardian activates reliably on large/noisy contexts (FNR < 10%)', status: 'SUPPORTED', evidence: `${(fnr.mean * 100).toFixed(1)}% FNR [${(fnr.ci95_low * 100).toFixed(1)}%, ${(fnr.ci95_high * 100).toFixed(1)}%] 95% CI`, caveats: [`${data.scenarioCount} positive scenarios tested`] });
  } else {
    claims.push({ id: 'false-negative-rate', statement: 'Context Guardian activates reliably on large/noisy contexts (FNR < 10%)', status: 'NOT_SUPPORTED', evidence: `${(fnr.mean * 100).toFixed(1)}% FNR`, caveats: [] });
  }

  return claims;
}
