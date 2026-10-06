import type { AnyRule } from '../types.js';
import { offCanvas } from './off-canvas.js';
import { safeMargins } from './safe-margins.js';

/** All built-in rules, in report order. */
export const builtinRules: AnyRule[] = [offCanvas, safeMargins];

export function getRule(id: string): AnyRule | undefined {
  return builtinRules.find((r) => r.id === id);
}
