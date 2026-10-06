import type { AnyRule } from '../types.js';
import { hierarchy } from './hierarchy.js';
import { minTextSize } from './min-text-size.js';
import { offCanvas } from './off-canvas.js';
import { safeMargins } from './safe-margins.js';

/** All built-in rules, in report order. */
export const builtinRules: AnyRule[] = [offCanvas, minTextSize, safeMargins, hierarchy];

export function getRule(id: string): AnyRule | undefined {
  return builtinRules.find((r) => r.id === id);
}
