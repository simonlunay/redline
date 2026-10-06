import type { RGBA } from './color.js';
import type { Design } from './schema.js';
import type { TextMeasurer } from './text-measure.js';

export type Severity = 'error' | 'warning' | 'info';

/**
 * A machine-readable repair suggestion. An AI agent (or a "fix all" button) can apply
 * these directly to the design JSON without understanding the rule that produced them.
 * Values are absolute targets (color, fontSize, width/height) or deltas (move), whichever is
 * least ambiguous for that operation.
 */
export type Fix =
  | { op: 'move'; elementId: string; dx: number; dy: number }
  | { op: 'resize'; elementId: string; width: number; height: number }
  | { op: 'setColor'; elementId: string; color: string }
  | { op: 'setFontSize'; elementId: string; fontSize: number }
  | { op: 'setFontWeight'; elementId: string; fontWeight: number };

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

export interface RuleContext {
  design: Design;
  measurer: TextMeasurer;
  sampler?: ImageSampler;
}

export interface Rule<O extends object = object> {
  id: string;
  description: string;
  defaultSeverity: Severity;
  /** Relative importance in the overall score. */
  weight: number;
  defaultOptions: O;
  check(ctx: RuleContext, options: O): RuleIssue[];
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
}

export interface Report {
  /** 0-100, weighted mean of the enabled rules' scores. */
  score: number;
  /** False when at least one error was found. Drives the CLI exit code. */
  passed: boolean;
  summary: { errors: number; warnings: number; infos: number };
  rules: RuleScore[];
  issues: Issue[];
}
