import { round2 } from '../geometry.js';
import type { TextElement } from '../schema.js';
import { defineRule } from '../types.js';
import type { RuleIssue } from '../types.js';
import { label } from './util.js';

/**
 * Rough visual weight of a text element. Size dominates; weight helps but less than
 * linearly (bold 700 at 40px reads about as strong as regular 53px).
 */
export function prominence(el: Pick<TextElement, 'fontSize' | 'fontWeight'>): number {
  return el.fontSize * Math.sqrt(el.fontWeight / 400);
}

export const hierarchy = defineRule({
  id: 'hierarchy',
  description:
    'The headline should be the most prominent text. Flags subheadings, body text or CTAs that compete with or beat it.',
  defaultSeverity: 'warning',
  weight: 2,
  defaultOptions: {
    /** Warn when a competitor reaches this fraction of the headline's prominence. */
    competeRatio: 0.9,
    /** Suggested fixes shrink competitors down to this fraction of the headline. */
    targetRatio: 0.7,
  },
  check({ design }, { competeRatio, targetRatio }) {
    const texts = design.elements.filter((el): el is TextElement => el.type === 'text');
    const headlines = texts.filter((t) => t.role === 'headline');
    const issues: RuleIssue[] = [];

    if (headlines.length === 0) {
      if (texts.length >= 2) {
        issues.push({
          severity: 'info',
          elementIds: texts.map((t) => t.id),
          message: 'No text has role "headline", so visual hierarchy could not be checked.',
          measured: 0,
          threshold: 1,
          unit: 'headlines',
        });
      }
      return issues;
    }
    if (headlines.length > 1) {
      issues.push({
        severity: 'info',
        elementIds: headlines.map((h) => h.id),
        message: `${headlines.length} elements are marked as headline; a design reads best with one clear entry point.`,
        measured: headlines.length,
        threshold: 1,
        unit: 'headlines',
      });
    }

    // With several headlines, competitors must lose to the strongest one.
    const headline = headlines.reduce((a, b) => (prominence(b) > prominence(a) ? b : a));
    const headlineP = prominence(headline);

    for (const el of texts) {
      if (el.role !== 'subheading' && el.role !== 'body' && el.role !== 'cta') continue;
      const ratio = prominence(el) / headlineP;
      if (ratio < competeRatio) continue;
      const beats = ratio > 1;
      const targetSize = Math.floor((headlineP * targetRatio) / Math.sqrt(el.fontWeight / 400));
      issues.push({
        severity: beats ? 'error' : 'warning',
        elementIds: [el.id, headline.id],
        message: beats
          ? `${label(el)} (${el.fontSize}px/${el.fontWeight}) is more prominent than the headline "${headline.id}" (${headline.fontSize}px/${headline.fontWeight}).`
          : `${label(el)} (${el.fontSize}px/${el.fontWeight}) competes with the headline "${headline.id}" (${headline.fontSize}px/${headline.fontWeight}); make the difference clearer.`,
        measured: round2(ratio),
        threshold: competeRatio,
        unit: 'x headline prominence',
        fix: [{ op: 'setFontSize', elementId: el.id, fontSize: targetSize }],
      });
    }
    return issues;
  },
});
