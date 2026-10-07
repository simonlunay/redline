import type { AnyRule } from '../types.js';
import { attentionCompetition } from './attention-competition.js';
import { attentionKeyElements } from './attention-key-elements.js';
import { alignment } from './alignment.js';
import { hierarchy } from './hierarchy.js';
import { imageAspectRatio } from './image-aspect-ratio.js';
import { labelCentered } from './label-centered.js';
import { minTextSize } from './min-text-size.js';
import { offCanvas } from './off-canvas.js';
import { safeMargins } from './safe-margins.js';
import { textContrast } from './text-contrast.js';
import { textOverflow } from './text-overflow.js';
import { unintendedOverlap } from './unintended-overlap.js';

/** All built-in rules, in report order. */
export const builtinRules: AnyRule[] = [
  textContrast,
  offCanvas,
  minTextSize,
  imageAspectRatio,
  safeMargins,
  hierarchy,
  unintendedOverlap,
  textOverflow,
  alignment,
  labelCentered,
];

/**
 * Attention rules need a render and a saliency model, so they only run in checkAsync().
 * They are opt-in (`rules: [...builtinRules, ...attentionRules]`, CLI --attention) so that
 * the browser-friendly check() and existing reports are unchanged.
 */
export const attentionRules: AnyRule[] = [attentionKeyElements, attentionCompetition];

export function getRule(id: string): AnyRule | undefined {
  return [...builtinRules, ...attentionRules].find((r) => r.id === id);
}

export {
  alignment,
  attentionCompetition,
  attentionKeyElements,
  hierarchy,
  imageAspectRatio,
  labelCentered,
  minTextSize,
  offCanvas,
  safeMargins,
  textContrast,
  textOverflow,
  unintendedOverlap,
};
