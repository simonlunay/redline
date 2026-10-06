import { z } from 'zod';
import type { AnyRule, Severity } from './types.js';

const SeveritySchema = z.enum(['error', 'warning', 'info']);

/**
 * ESLint-style per-rule setting:
 *   "off"                                     disable the rule
 *   "warning"                                 enable it and force all its issues to that severity
 *   { options: {...}, weight: 2, severity }   override thresholds / scoring weight
 */
const RuleSettingSchema = z.union([
  z.literal('off'),
  SeveritySchema,
  z.object({
    enabled: z.boolean().optional(),
    severity: SeveritySchema.optional(),
    weight: z.number().nonnegative().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export const ConfigSchema = z.object({
  rules: z.record(z.string(), RuleSettingSchema).optional(),
});

export type RuleSetting = z.infer<typeof RuleSettingSchema>;
export type RedlineConfig = z.infer<typeof ConfigSchema>;

export interface ResolvedRule {
  rule: AnyRule;
  options: object;
  weight: number;
  /** When set, replaces the severity of every issue the rule reports. */
  severityOverride?: Severity;
}

/** Validates config and merges it with each rule's defaults. Unknown rule ids are an error. */
export function resolveRules(rules: AnyRule[], config: RedlineConfig = {}): ResolvedRule[] {
  const parsed = ConfigSchema.parse(config);
  const settings = parsed.rules ?? {};
  const known = new Set(rules.map((r) => r.id));
  for (const id of Object.keys(settings)) {
    if (!known.has(id)) {
      throw new Error(`Unknown rule "${id}" in config. Known rules: ${[...known].join(', ')}`);
    }
  }

  const resolved: ResolvedRule[] = [];
  for (const rule of rules) {
    const setting = settings[rule.id];
    if (setting === 'off') continue;
    if (setting === undefined) {
      resolved.push({ rule, options: { ...rule.defaultOptions }, weight: rule.weight });
    } else if (typeof setting === 'string') {
      resolved.push({
        rule,
        options: { ...rule.defaultOptions },
        weight: rule.weight,
        severityOverride: setting,
      });
    } else {
      if (setting.enabled === false) continue;
      resolved.push({
        rule,
        options: { ...rule.defaultOptions, ...setting.options },
        weight: setting.weight ?? rule.weight,
        severityOverride: setting.severity,
      });
    }
  }
  return resolved;
}
