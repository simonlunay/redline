import { resolveRules } from './config.js';
import type { RedlineConfig, ResolvedRule } from './config.js';
import { builtinRules } from './rules/index.js';
import { parseDesign } from './schema.js';
import type { Design } from './schema.js';
import { overallScore, ruleScore } from './scoring.js';
import { heuristicMeasurer } from './text-measure.js';
import type { TextMeasurer } from './text-measure.js';
import type {
  AnyRule,
  ImageSampler,
  Issue,
  RasterImage,
  Report,
  RuleContext,
  RuleOutput,
  RuleScore,
  Severity,
  SkippedRule,
} from './types.js';

export interface CheckOptions {
  config?: RedlineConfig;
  /** Defaults to the heuristic measurer. Pass a font-backed one for precise overflow checks. */
  measurer?: TextMeasurer;
  /** Without a sampler, contrast over images is reported as "couldn't verify". */
  sampler?: ImageSampler;
  /** Replace the rule set, e.g. to add custom rules: [...builtinRules, myRule]. */
  rules?: AnyRule[];
}

export interface CheckAsyncOptions extends CheckOptions {
  /** Renders a design to pixels. Enables rules with `requires: ['render']`. */
  render?: (design: Design) => Promise<RasterImage>;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

interface RuleRun {
  resolved: ResolvedRule;
  output: RuleOutput;
}

function prepare(input: unknown, options: CheckOptions) {
  const design = parseDesign(input);
  const ctx: RuleContext = {
    design,
    measurer: options.measurer ?? heuristicMeasurer,
    sampler: options.sampler,
  };
  return { design, ctx, resolved: resolveRules(options.rules ?? builtinRules, options.config) };
}

function missingRequirement(rule: AnyRule, ctx: RuleContext): string | null {
  if (rule.requires?.includes('render') && !ctx.render) {
    return 'needs a renderer (run checkAsync with a render function)';
  }
  return null;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as Promise<unknown> | null)?.then === 'function';
}

/** Shared by check() and checkAsync(): turns raw rule outputs into a scored report. */
function buildReport(runs: RuleRun[], skipped: SkippedRule[]): Report {
  const issues: Issue[] = [];
  const rules: RuleScore[] = [];
  const exactScores: number[] = [];
  for (const { resolved, output } of runs) {
    const { rule, weight, severityOverride } = resolved;
    const result = Array.isArray(output) ? { issues: output } : output;
    const ruleIssues: Issue[] = result.issues.map((raw) => ({
      ruleId: rule.id,
      ...raw,
      severity: severityOverride ?? raw.severity ?? rule.defaultSeverity,
    }));
    issues.push(...ruleIssues);
    const score = ruleScore(
      ruleIssues.map((i) => i.severity),
      weight,
    );
    exactScores.push(score);
    rules.push({
      ruleId: rule.id,
      score: Math.round(score),
      weight,
      issues: ruleIssues.length,
      ...('elementScores' in result && result.elementScores
        ? { elementScores: result.elementScores }
        : {}),
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
    score: overallScore(exactScores),
    passed: summary.errors === 0,
    summary,
    rules,
    issues,
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

/**
 * Checks a design against all enabled rules. Accepts raw JSON (it is validated first)
 * and is synchronous and side-effect free, so it runs the same in Node and the browser.
 * Async rules are skipped here (see report.skipped); use checkAsync() to run them.
 */
export function check(input: unknown, options: CheckOptions = {}): Report {
  const { ctx, resolved } = prepare(input, options);
  const runs: RuleRun[] = [];
  const skipped: SkippedRule[] = [];
  for (const r of resolved) {
    const missing = missingRequirement(r.rule, ctx);
    if (missing) {
      skipped.push({ ruleId: r.rule.id, reason: missing });
      continue;
    }
    const output = r.rule.check(ctx, r.options);
    if (isPromise(output)) {
      output.catch(() => undefined); // result is discarded; avoid an unhandled rejection
      skipped.push({ ruleId: r.rule.id, reason: 'async rule (run checkAsync to include it)' });
      continue;
    }
    runs.push({ resolved: r, output });
  }
  return buildReport(runs, skipped);
}

/**
 * Like check(), but also runs async rules and can provide a lazily-rendered image of the
 * design to rules that need one (e.g. a saliency/attention model). Rules run in order, one
 * at a time, so reports are deterministic.
 */
export async function checkAsync(input: unknown, options: CheckAsyncOptions = {}): Promise<Report> {
  const { design, ctx, resolved } = prepare(input, options);
  if (options.render) {
    const render = options.render;
    let rendered: Promise<RasterImage> | undefined;
    ctx.render = () => (rendered ??= render(design));
  }
  const runs: RuleRun[] = [];
  const skipped: SkippedRule[] = [];
  for (const r of resolved) {
    const missing = missingRequirement(r.rule, ctx);
    if (missing) {
      skipped.push({ ruleId: r.rule.id, reason: missing });
      continue;
    }
    runs.push({ resolved: r, output: await r.rule.check(ctx, r.options) });
  }
  return buildReport(runs, skipped);
}
