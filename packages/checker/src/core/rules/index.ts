import type { AnyRule } from '../types.js';
import { alignment } from './alignment.js';
import { hierarchy } from './hierarchy.js';
import { imageAspectRatio } from './image-aspect-ratio.js';
import { minTextSize } from './min-text-size.js';
import { offCanvas } from './off-canvas.js';
import { safeMargins } from './safe-margins.js';
import { textOverflow } from './text-overflow.js';
import { unintendedOverlap } from './unintended-overlap.js';

/** All built-in rules, in report order. */
export const builtinRules: AnyRule[] = [
  offCanvas,
  minTextSize,
  imageAspectRatio,
  safeMargins,
  hierarchy,
  unintendedOverlap,
  textOverflow,
  alignment,
];

export function getRule(id: string): AnyRule | undefined {
  return builtinRules.find((r) => r.id === id);
}
