import type { RGBA } from './color.js';
import type { SaliencyMap } from './attention/saliency.js';
import type { Fix } from './fixes.js';
import type { Design } from './schema.js';
import type { TextMeasurer } from './text-measure.js';

export type Severity = 'error' | 'warning' | 'info';

/**
 * A machine-readable repair suggestion (see fixes.ts for the schema and applyFixes). An AI
 * agent or a "fix all" button can apply these directly to the design JSON.
 */
export type { Fix } from './fixes.js';

export interface Issue {
  ruleId: string;
  severity: Severity;
  /** Elements involved. The first one is the element the fix (if any) targets primarily. */
  elementIds: string[];
  message: string;
  /** What was measured, e.g. 2.3 (a contrast ratio). */
  measured: number | string;
  /** The limit it was compared against, e.g. 4.5. */
  threshold: number | string;
  unit?: string;
  /** Alternative or combined fixes. Apply all of them in order to resolve the issue. */
  fix?: Fix[];
}

/** What a rule returns. ruleId is filled in by the engine; severity defaults to the rule's. */
export type RuleIssue = Omit<Issue, 'ruleId' | 'severity'> & { severity?: Severity };

/**
 * Reads pixels from images that were decoded ahead of time. Synchronous on purpose:
 * loading is async (file system, network), but by the time `check()` runs, pixels are in
 * memory. That keeps `check()` synchronous, pure and easy to test.
 */
export interface ImageSampler {
  /** True when this image's pixels are available. */
  has(src: string): boolean;
  /** Color at normalized image coordinates (u, v in 0..1), or null if unavailable. */
  sample(src: string, u: number, v: number): RGBA | null;
}

/** Raw RGBA pixels (4 bytes per pixel, row-major). Same layout as canvas ImageData. */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Capabilities a rule can require. Rules whose requirements are missing are skipped. */
export type RuleRequirement = 'render' | 'saliency';

export interface RuleContext {
  design: Design;
  measurer: TextMeasurer;
  sampler?: ImageSampler;
  /**
   * Renders the current design to pixels (lazy, at most once per check). Only available in
   * checkAsync() when a renderer is provided, e.g. for a future saliency/attention rule.
   */
  render?: () => Promise<RasterImage>;
  /**
   * Predicted attention heatmap of the current design (lazy, at most once per check). Only
   * available in checkAsync() when both a renderer and a saliency model are provided.
   */
  saliency?: () => Promise<SaliencyMap>;
}

/** Richer rule output: issues plus optional per-element scores (e.g. attention share). */
export interface RuleResult {
  issues: RuleIssue[];
  /** elementId -> score, reported as-is in the rule's RuleScore. */
  elementScores?: Record<string, number>;
  /** Extra structured data reported as-is in the rule's RuleScore (e.g. viewing order). */
  details?: Record<string, unknown>;
}

export type RuleOutput = RuleIssue[] | RuleResult;

export interface Rule<O extends object = object> {
  id: string;
  description: string;
  defaultSeverity: Severity;
  /** How much each issue of this rule costs: an error removes 8% x weight of the score. */
  weight: number;
  defaultOptions: O;
  /** Capabilities the rule needs; it is skipped (and listed in report.skipped) without them. */
  requires?: RuleRequirement[];
  /**
   * Sync rules work with check() and checkAsync(). Async rules (returning a Promise, e.g. a
   * model call) only run in checkAsync(); check() skips them.
   */
  check(ctx: RuleContext, options: O): RuleOutput | Promise<RuleOutput>;
}

/** Erased rule type used in registries (options are validated per rule at run time). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRule = Rule<any>;

/** Helper that infers the options type from defaultOptions. */
export function defineRule<O extends object>(rule: Rule<O>): Rule<O> {
  return rule;
}

export interface RuleScore {
  ruleId: string;
  score: number;
  weight: number;
  issues: number;
  elementScores?: Record<string, number>;
  details?: Record<string, unknown>;
}

export interface SkippedRule {
  ruleId: string;
  reason: string;
}

export interface Report {
  /** 0-100, the product of the enabled rules' scores (see scoring.ts). */
  score: number;
  /** False when at least one error was found. Drives the CLI exit code. */
  passed: boolean;
  summary: { errors: number; warnings: number; infos: number };
  rules: RuleScore[];
  issues: Issue[];
  /** Rules that could not run (async rule in check(), missing renderer). Omitted when empty. */
  skipped?: SkippedRule[];
}
