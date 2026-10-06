import type { AnyRule } from '../types.js';

/** All built-in rules, in report order. */
export const builtinRules: AnyRule[] = [];

export function getRule(id: string): AnyRule | undefined {
  return builtinRules.find((r) => r.id === id);
}
