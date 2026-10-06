import { rotatedBounds, round2, shortSide } from '../geometry.js';
import { RoleSchema } from '../schema.js';
import type { Role } from '../schema.js';
import { defineRule } from '../types.js';
import type { RuleIssue } from '../types.js';
import { clampDelta, hasRole, label, px } from './util.js';

export const safeMargins = defineRule({
  id: 'safe-margins',
  description:
    'Important elements (logo, headline, CTA, any text) too close to the canvas edges, where they can be cropped by app UI or feel cramped.',
  defaultSeverity: 'warning',
  weight: 1,
  defaultOptions: {
    /** Minimum distance from each edge, as % of the shorter canvas side (5% = 54px on 1080). */
    marginPercent: 5,
    roles: ['logo', 'headline', 'subheading', 'body', 'cta'] as Role[],
    /** Also apply to text elements that have no role. */
    includeAllText: true,
  },
  check({ design }, options) {
    const roles = options.roles.map((r) => RoleSchema.parse(r));
    const { width: W, height: H } = design.canvas;
    const margin = (shortSide(design.canvas) * options.marginPercent) / 100;
    const issues: RuleIssue[] = [];

    for (const el of design.elements) {
      if (hasRole(el, 'background', 'decoration')) continue;
      const important = hasRole(el, ...roles) || (options.includeAllText && el.type === 'text');
      if (!important) continue;

      const b = rotatedBounds(el);
      // Already sticking out of the canvas: off-canvas reports that, don't double count.
      if (b.x < 0 || b.y < 0 || b.x + b.width > W || b.y + b.height > H) continue;

      const distances = {
        left: b.x,
        top: b.y,
        right: W - (b.x + b.width),
        bottom: H - (b.y + b.height),
      };
      const tooClose = Object.entries(distances).filter(([, d]) => d < margin - 0.5);
      if (tooClose.length === 0) continue;

      const closest = Math.min(...tooClose.map(([, d]) => d));
      const edges = tooClose.map(([edge]) => edge).join(' and ');
      issues.push({
        elementIds: [el.id],
        message: `${label(el)} is ${px(closest)} from the ${edges} edge; keep at least ${px(margin)} (${options.marginPercent}% of the shorter side).`,
        measured: round2(closest),
        threshold: round2(margin),
        unit: 'px',
        fix: [
          {
            op: 'move',
            elementId: el.id,
            dx: round2(clampDelta(b.x, b.width, margin, W - margin)),
            dy: round2(clampDelta(b.y, b.height, margin, H - margin)),
          },
        ],
      });
    }
    return issues;
  },
});
