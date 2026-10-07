import { pct } from '../attention/shares.js';
import { containsRect, rectOf, round2 } from '../geometry.js';
import type { Design, DesignElement } from '../schema.js';
import { defineRule } from '../types.js';
import type { RuleIssue } from '../types.js';
import { attentionOf } from './attention-key-elements.js';
import { isBelow, label, paintOrder } from './util.js';

/**
 * A decoration that sits behind content (a headline panel, a CTA backing, a scrim added by the
 * fix loop) is part of that content, not a competitor: attention spilling from the text onto
 * its panel must not be counted against the panel.
 */
function isBacking(design: Design, decoration: DesignElement): boolean {
  return design.elements.some(
    (el) =>
      el !== decoration &&
      el.role !== 'decoration' &&
      el.role !== 'background' &&
      isBelow(design, decoration, el) &&
      containsRect(rectOf(decoration), rectOf(el)),
  );
}

export const attentionCompetition = defineRule({
  id: 'attention-competition',
  description:
    'Decorations or background areas that draw more predicted attention than the headline or CTA, pulling the eye away from the message.',
  defaultSeverity: 'warning',
  weight: 2,
  requires: ['saliency'],
  defaultOptions: {
    /** Ignore distractors below this share; tiny hot spots aren't worth an edit. */
    minDistractorShare: 0.05,
    /** At most this many background regions are reported (the strongest ones). */
    maxBackgroundRegions: 2,
  },
  async check({ design, saliency }, { minDistractorShare, maxBackgroundRegions }) {
    const attention = await attentionOf(design, saliency);
    const targets = (['headline', 'cta'] as const)
      .filter((role) => design.elements.some((el) => el.role === role))
      .map((role) => ({ role, share: attention.roleShares[role] ?? 0 }));
    if (targets.length === 0) return [];

    /** Key roles this share beats, e.g. "the CTA (6%)". */
    const beats = (share: number) =>
      targets
        .filter((t) => share > t.share)
        .map((t) => `the ${t.role === 'cta' ? 'CTA' : t.role} (${pct(t.share)})`);

    const issues: RuleIssue[] = [];
    for (const el of design.elements) {
      if (el.role !== 'decoration' || isBacking(design, el)) continue;
      const share = attention.elementShares[el.id] ?? 0;
      const beaten = beats(share);
      if (share < minDistractorShare || beaten.length === 0) continue;
      issues.push({
        elementIds: [el.id],
        message: `${label(el)} gets ${pct(share)} of predicted attention, more than ${beaten.join(' and ')}. Tone it down: smaller, lower opacity or less saturated.`,
        measured: round2(share * 100),
        threshold: round2(Math.min(...targets.map((t) => t.share)) * 100),
        unit: '% attention',
        fix: [
          { op: 'setOpacity', elementId: el.id, opacity: round2(Math.min(el.opacity, 0.5)) },
          {
            op: 'resize',
            elementId: el.id,
            width: round2(el.width * 0.75),
            height: round2(el.height * 0.75),
          },
        ],
      });
    }

    // A translucent scrim calms a busy background area. It goes behind the lowest
    // non-background element, i.e. above the background photo and below all content.
    const lowest = paintOrder(design).find((el) => el.role !== 'background');
    const hotspots = attention.backgroundRegions
      .filter((r) => r.share >= minDistractorShare && beats(r.share).length > 0)
      .sort((a, b) => b.share - a.share)
      .slice(0, maxBackgroundRegions);
    for (const region of hotspots) {
      issues.push({
        elementIds: [],
        message: `The background at the ${region.name} gets ${pct(region.share)} of predicted attention, more than ${beats(region.share).join(' and ')}. Calm it with a translucent overlay or move a key element there.`,
        measured: round2(region.share * 100),
        threshold: round2(Math.min(...targets.map((t) => t.share)) * 100),
        unit: '% attention',
        ...(lowest
          ? {
              fix: [
                {
                  op: 'insertShape' as const,
                  behindElementId: lowest.id,
                  kind: 'rect' as const,
                  x: round2(region.x),
                  y: round2(region.y),
                  width: round2(region.width),
                  height: round2(region.height),
                  fill: '#000000',
                  opacity: 0.35,
                  cornerRadius: 0,
                },
              ],
            }
          : {}),
      });
    }
    return issues;
  },
});
