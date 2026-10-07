import type { Severity } from './types.js';

/**
 * Percent of a rule's score that one issue removes, before multiplying by the rule weight.
 * A contrast error (weight 3) removes 24%; an alignment warning (weight 1) removes 3%.
 */
export const SEVERITY_POINTS: Record<Severity, number> = {
  error: 8,
  warning: 3,
  info: 0.5,
};

/**
 * Score of one rule, 0-100 (unrounded). Each issue multiplies the score by
 * (1 - points * weight / 100), so issues compound, the score never goes below 0, and
 * the order of issues does not matter.
 */
export function ruleScore(severities: Severity[], weight: number): number {
  return severities.reduce(
    (score, s) => score * Math.max(0, 1 - (SEVERITY_POINTS[s] * weight) / 100),
    100,
  );
}

/**
 * Overall score: the product of the rule scores (as fractions).
 * Why not a weighted average? With 10 rules, an average lets 9 passing rules hide a real
 * error (a stretched image would still score 97). With a product, every failing rule
 * pulls the total down, which is what an automated "fix until it scores well" loop needs.
 */
export function overallScore(ruleScores: number[]): number {
  return Math.round(ruleScores.reduce((total, s) => total * (s / 100), 100));
}
