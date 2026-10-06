// Isomorphic public API: safe to import in Node and in the browser.
export { check } from './check.js';
export type { CheckOptions } from './check.js';
export { DesignSchema, DesignValidationError, FORMAT_VERSION, parseDesign } from './schema.js';
export type {
  Canvas,
  Design,
  DesignElement,
  DesignInput,
  ImageElement,
  Role,
  ShapeElement,
  TextElement,
} from './schema.js';
export { ConfigSchema, resolveRules } from './config.js';
export type { RedlineConfig, RuleSetting } from './config.js';
export { builtinRules, getRule } from './rules/index.js';
export { defineRule } from './types.js';
export type {
  AnyRule,
  Fix,
  ImageSampler,
  Issue,
  Report,
  Rule,
  RuleContext,
  RuleIssue,
  RuleScore,
  Severity,
} from './types.js';
export { heuristicMeasurer, layoutText, wrapText } from './text-measure.js';
export type { FontSpec, TextLayout, TextMeasurer } from './text-measure.js';
export { contrastRatio, parseHex, relativeLuminance, toHex } from './color.js';
export type { RGB, RGBA } from './color.js';
export { SEVERITY_PENALTY } from './scoring.js';
