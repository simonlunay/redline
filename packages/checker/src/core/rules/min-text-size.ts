import { round2, shortSide } from '../geometry.js';
import { defineRule } from '../types.js';
import type { RuleIssue } from '../types.js';
import { label, px } from './util.js';

export const minTextSize = defineRule({
  id: 'min-text-size',
  description:
    'Text too small to read relative to the canvas. The threshold scales with the shorter canvas side, so it works for a 1080px post and a 1200x628 banner alike.',
  defaultSeverity: 'warning',
  weight: 2,
  defaultOptions: {
    /** Warn below this % of the shorter side (2% = 21.6px on a 1080px post). */
    minPercent: 2,
    /** Error below this % (1.4% = ~15px on 1080), basically unreadable on a phone. */
    errorPercent: 1.4,
  },
  check({ design }, { minPercent, errorPercent }) {
    const side = shortSide(design.canvas);
    const minSize = (side * minPercent) / 100;
    const errorSize = (side * errorPercent) / 100;
    const issues: RuleIssue[] = [];

    for (const el of design.elements) {
      if (el.type !== 'text' || el.content.trim() === '') continue;
      if (el.fontSize >= minSize) continue;
      issues.push({
        severity: el.fontSize < errorSize ? 'error' : 'warning',
        elementIds: [el.id],
        message: `${label(el)} is ${px(el.fontSize)}, below the ${px(minSize)} minimum for a ${design.canvas.width}x${design.canvas.height} canvas.`,
        measured: el.fontSize,
        threshold: round2(minSize),
        unit: 'px',
        fix: [{ op: 'setFontSize', elementId: el.id, fontSize: Math.ceil(minSize) }],
      });
    }
    return issues;
  },
});
