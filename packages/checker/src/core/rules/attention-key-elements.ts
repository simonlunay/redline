import { analyzeAttention, pct } from '../attention/shares.js';
import type { SaliencyMap } from '../attention/saliency.js';
import type { AttentionAnalysis } from '../attention/shares.js';
import { round2 } from '../geometry.js';
import type { Design, DesignElement, Role } from '../schema.js';
import { defineRule } from '../types.js';
import type { Fix, RuleIssue } from '../types.js';

/** Roles checked by default and their minimum share of predicted attention. */
export type AttentionMinimums = Partial<Record<Role, number>>;

/**
 * Defaults come from a calibration run (see README "Attention calibration"): roughly the 10th
 * percentile of each role's share across designs that pass every layout rule, rounded down.
 */
export const DEFAULT_ATTENTION_MINIMUMS: AttentionMinimums = {
  headline: 0.12,
  cta: 0.05,
  product: 0.15,
};

/**
 * Suggested scale for an element that gets too little attention. Attention grows roughly with
 * area, so scale both sides by sqrt(needed / current), kept between 1.1x and 1.4x so a fix
 * never blows up the layout in one step.
 */
export function attentionScale(share: number, minimum: number): number {
  const ideal = Math.sqrt(minimum / Math.max(share, 1e-6));
  return Math.round(Math.min(1.4, Math.max(1.1, ideal)) * 100) / 100;
}

/** Fixes that grow all elements of a role around their joint center (button + label together). */
export function growFixes(elements: DesignElement[], scale: number): Fix[] {
  const left = Math.min(...elements.map((el) => el.x));
  const top = Math.min(...elements.map((el) => el.y));
  const right = Math.max(...elements.map((el) => el.x + el.width));
  const bottom = Math.max(...elements.map((el) => el.y + el.height));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  return elements.flatMap((el): Fix[] => {
    const fixes: Fix[] = [
      {
        op: 'move',
        elementId: el.id,
        dx: round2(cx + (el.x - cx) * scale - el.x),
        dy: round2(cy + (el.y - cy) * scale - el.y),
      },
      {
        op: 'resize',
        elementId: el.id,
        width: round2(el.width * scale),
        height: round2(el.height * scale),
      },
    ];
    if (el.type === 'text') {
      fixes.push({
        op: 'setFontSize',
        elementId: el.id,
        fontSize: Math.round(el.fontSize * scale),
      });
    }
    return fixes;
  });
}

const ROLE_LABEL: Partial<Record<Role, string>> = {
  cta: 'CTA',
  headline: 'Headline',
  product: 'Product',
};

/** Shared by the attention rules: run the model once per check (ctx.saliency is memoized). */
export async function attentionOf(
  design: Design,
  saliency: (() => Promise<SaliencyMap>) | undefined,
): Promise<AttentionAnalysis> {
  if (!saliency)
    throw new Error('attention rules need ctx.saliency (use checkAsync with a saliency model)');
  return analyzeAttention(design, await saliency());
}

export const attentionKeyElements = defineRule({
  id: 'attention-key-elements',
  description:
    'Key elements (CTA, headline, product) must each get a minimum share of predicted visual attention, from a saliency model run on the rendered design.',
  defaultSeverity: 'warning',
  weight: 2,
  requires: ['saliency'],
  defaultOptions: {
    minShare: DEFAULT_ATTENTION_MINIMUMS,
    /** Below this fraction of the minimum the issue becomes an error. */
    errorFraction: 0.5,
  },
  async check({ design, saliency }, { minShare, errorFraction }) {
    const attention = await attentionOf(design, saliency);
    const order = attention.viewingOrder.join(' → ');
    const issues: RuleIssue[] = [];

    for (const [role, minimum] of Object.entries(minShare) as [Role, number][]) {
      const elements = design.elements.filter((el) => el.role === role && el.opacity > 0);
      if (elements.length === 0) continue; // e.g. no product in this design
      const share = attention.roleShares[role] ?? 0;
      if (share >= minimum) continue;
      const label = ROLE_LABEL[role] ?? role;
      const scale = attentionScale(share, minimum);
      issues.push({
        severity: share < minimum * errorFraction ? 'error' : 'warning',
        // Button first for CTAs so the primary element is the visible box.
        elementIds: [...elements]
          .sort((a, b) => b.width * b.height - a.width * a.height)
          .map((el) => el.id),
        message: `${label} gets ${pct(share)} of predicted attention; minimum is ${pct(minimum)}. Make it larger, higher-contrast or more isolated (predicted viewing order: ${order || 'n/a'}).`,
        measured: round2(share * 100),
        threshold: round2(minimum * 100),
        unit: '% attention',
        fix: growFixes(elements, scale),
      });
    }

    return {
      issues,
      elementScores: Object.fromEntries(
        Object.entries(attention.elementShares).map(([id, v]) => [
          id,
          Math.round(v * 10000) / 10000,
        ]),
      ),
      details: {
        roleShares: Object.fromEntries(
          Object.entries(attention.roleShares).map(([r, v]) => [r, Math.round(v! * 10000) / 10000]),
        ),
        viewingOrder: attention.viewingOrder,
        backgroundShare: Math.round(attention.backgroundShare * 10000) / 10000,
      },
    };
  },
});
