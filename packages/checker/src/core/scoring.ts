import type { Issue, Severity } from './types.js';

/**
 * Points a rule loses per issue. Errors hurt a lot, info barely registers.
 * Each rule is scored independently (floored at 0) so one very noisy rule can't push the
 * overall score below what the other rules justify. The overall score is a weighted mean.
 */
export const SEVERITY_PENALTY: Record<Severity, number> = {
  error: 30,
  warning: 10,
  info: 2,
};

export function ruleScore(issues: Issue[]): number {
  const penalty = issues.reduce((sum, i) => sum + SEVERITY_PENALTY[i.severity], 0);
  return Math.max(0, 100 - penalty);
}

export function overallScore(scores: { score: number; weight: number }[]): number {
  const totalWeight = scores.reduce((s, r) => s + r.weight, 0);
  if (totalWeight === 0) return 100;
  const weighted = scores.reduce((s, r) => s + r.score * r.weight, 0);
  return Math.round(weighted / totalWeight);
}
