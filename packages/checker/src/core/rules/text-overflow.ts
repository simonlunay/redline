import { round2, shortSide } from '../geometry.js';
import { layoutText } from '../text-measure.js';
import type { TextMeasurer, TextLayout } from '../text-measure.js';
import type { TextElement } from '../schema.js';
import { defineRule } from '../types.js';
import type { Fix, RuleIssue } from '../types.js';
import { label, px } from './util.js';

function fits(layout: TextLayout, el: TextElement, tolerance: number): boolean {
  return layout.height <= el.height + tolerance && layout.width <= el.width + tolerance;
}

/** Largest integer font size in [min, max] whose layout fits the box, or null. */
function largestFittingSize(
  el: TextElement,
  measurer: TextMeasurer,
  min: number,
  max: number,
  tolerance: number,
): number | null {
  let lo = Math.ceil(min);
  let hi = Math.floor(max);
  let best: number | null = null;
  // Binary search works because a smaller font never needs more space than a larger one.
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(layoutText(el, measurer, mid), el, tolerance)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export const textOverflow = defineRule({
  id: 'text-overflow',
  description:
    'Text that does not fit its box once wrapped at the given font size and line height, so it would be clipped or spill onto other elements.',
  defaultSeverity: 'error',
  weight: 3,
  defaultOptions: {
    /** Pixels of slack before reporting (measurement is never pixel-perfect). */
    tolerance: 2,
    /** The fix may shrink the font by at most this much; beyond that it grows the box instead. */
    maxShrinkPercent: 15,
    /** Never suggest a font size below this % of the shorter side (matches min-text-size). */
    minFontPercent: 2,
  },
  check({ design, measurer }, { tolerance, maxShrinkPercent, minFontPercent }) {
    const issues: RuleIssue[] = [];
    const minFont = (shortSide(design.canvas) * minFontPercent) / 100;

    for (const el of design.elements) {
      if (el.type !== 'text' || el.content.trim() === '') continue;
      const layout = layoutText(el, measurer);
      if (fits(layout, el, tolerance)) continue;

      const overflowH = layout.height - el.height;
      const overflowW = layout.width - el.width;
      const wordTooWide = overflowW > tolerance;

      const shrinkFloor = Math.max(minFont, el.fontSize * (1 - maxShrinkPercent / 100));
      const size = largestFittingSize(el, measurer, shrinkFloor, el.fontSize - 1, tolerance);
      const fix: Fix[] =
        size !== null
          ? [{ op: 'setFontSize', elementId: el.id, fontSize: size }]
          : [
              {
                op: 'resize',
                elementId: el.id,
                width: Math.ceil(Math.max(el.width, layout.width)),
                height: Math.ceil(Math.max(el.height, layout.height)),
              },
            ];

      const lines = `${layout.lines.length} line${layout.lines.length === 1 ? '' : 's'}`;
      issues.push({
        // Losing less than half a line is usually just clipped descenders: a warning.
        severity: wordTooWide || overflowH >= layout.lineHeightPx / 2 ? 'error' : 'warning',
        elementIds: [el.id],
        message: wordTooWide
          ? `${label(el)} has a word that is ${px(overflowW)} wider than its ${px(el.width)} box.`
          : `${label(el)} needs ${px(layout.height)} (${lines} at ${el.fontSize}px x ${el.lineHeight}) but its box is ${px(el.height)} tall.`,
        measured: round2(wordTooWide ? layout.width : layout.height),
        threshold: wordTooWide ? el.width : el.height,
        unit: 'px',
        fix,
      });
    }
    return issues;
  },
});
