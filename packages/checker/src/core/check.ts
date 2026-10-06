import { resolveRules } from './config.js';
import type { RedlineConfig } from './config.js';
import { builtinRules } from './rules/index.js';
import { parseDesign } from './schema.js';
import { overallScore, ruleScore } from './scoring.js';
import { heuristicMeasurer } from './text-measure.js';
import type { TextMeasurer } from './text-measure.js';
import type { AnyRule, ImageSampler, Issue, Report, RuleScore, Severity } from './types.js';

export interface CheckOptions {
  config?: RedlineConfig;
  /** Defaults to the heuristic measurer. Pass a font-backed one for precise overflow checks. */
  measurer?: TextMeasurer;
  /** Without a sampler, contrast over images is reported as "couldn't verify". */
  sampler?: ImageSampler;
  /** Replace the rule set, e.g. to add custom rules: [...builtinRules, myRule]. */
  rules?: AnyRule[];
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Checks a design against all enabled rules. Accepts raw JSON (it is validated first)
 * and is synchronous and side-effect free, so it runs the same in Node and the browser.
 */
export function check(input: unknown, options: CheckOptions = {}): Report {
  const design = parseDesign(input);
  const ctx = {
    design,
    measurer: options.measurer ?? heuristicMeasurer,
    sampler: options.sampler,
  };
  const resolved = resolveRules(options.rules ?? builtinRules, options.config);

  const issues: Issue[] = [];
  const rules: RuleScore[] = [];
  for (const { rule, options: ruleOptions, weight, severityOverride } of resolved) {
    const ruleIssues: Issue[] = rule.check(ctx, ruleOptions).map((raw) => ({
      ruleId: rule.id,
      ...raw,
      severity: severityOverride ?? raw.severity ?? rule.defaultSeverity,
    }));
    issues.push(...ruleIssues);
    rules.push({
      ruleId: rule.id,
      score: ruleScore(ruleIssues),
      weight,
      issues: ruleIssues.length,
    });
  }

  // Stable order: severity first, then rule order (Array.prototype.sort is stable).
  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const summary = {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    infos: issues.filter((i) => i.severity === 'info').length,
  };

  return {
    score: overallScore(rules),
    passed: summary.errors === 0,
    summary,
    rules,
    issues,
  };
}
