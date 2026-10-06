import {
  area,
  bottom,
  containsRect,
  intersection,
  rectOf,
  right,
  round2,
  shortSide,
} from '../geometry.js';
import type { Rect } from '../geometry.js';
import type { Design, DesignElement } from '../schema.js';
import { defineRule } from '../types.js';
import type { Fix, RuleIssue } from '../types.js';
import { hasRole, isBelow, label } from './util.js';

const IMPORTANT = ['headline', 'logo', 'cta', 'product'] as const;

/**
 * Decides whether an overlapping pair is a problem. Returns null when the overlap is a
 * normal design pattern, otherwise a short reason used in the message.
 */
function overlapKind(design: Design, a: DesignElement, b: DesignElement): string | null {
  if (a.groupId !== undefined && a.groupId === b.groupId) return null;

  const textA = a.type === 'text';
  const textB = b.type === 'text';
  if (textA && textB) return 'text overlaps text';

  if (textA || textB) {
    const [t, other] = textA ? [a, b] : [b, a];
    if (other.type === 'image') return 'text overlaps an image';
    // Text sitting fully on top of a shape is a button/label/badge: intentional.
    if (isBelow(design, other, t) && containsRect(rectOf(other), rectOf(t))) return null;
    if (hasRole(other, ...IMPORTANT) || hasRole(t, ...IMPORTANT)) {
      return 'text partly overlaps a shape';
    }
    return null;
  }

  if (hasRole(a, ...IMPORTANT) && hasRole(b, ...IMPORTANT)) return 'key elements overlap';
  return null;
}

/**
 * Smallest move that separates `mover` from `fixed` (plus a gap), preferring moves that keep
 * the element on the canvas.
 */
function separate(mover: Rect, fixed: Rect, gap: number, canvasW: number, canvasH: number) {
  const options = [
    { dx: right(fixed) + gap - mover.x, dy: 0 },
    { dx: fixed.x - gap - right(mover), dy: 0 },
    { dx: 0, dy: bottom(fixed) + gap - mover.y },
    { dx: 0, dy: fixed.y - gap - bottom(mover) },
  ];
  const fits = (o: { dx: number; dy: number }) =>
    mover.x + o.dx >= 0 &&
    mover.y + o.dy >= 0 &&
    right(mover) + o.dx <= canvasW &&
    bottom(mover) + o.dy <= canvasH;
  const byDistance = [...options].sort(
    (p, q) => Math.abs(p.dx) + Math.abs(p.dy) - (Math.abs(q.dx) + Math.abs(q.dy)),
  );
  return byDistance.find(fits) ?? byDistance[0]!;
}

export const unintendedOverlap = defineRule({
  id: 'unintended-overlap',
  description:
    'Elements that overlap when they should not: text over text or images, or key elements (headline, logo, CTA, product) colliding. Backgrounds, decorations, same-group elements and labels on shapes are treated as intentional.',
  defaultSeverity: 'warning',
  weight: 3,
  defaultOptions: {
    /** Overlap (as a fraction of the smaller element) at which it becomes an error. */
    errorRatio: 0.15,
    /** Gap left between elements by the suggested fix, as % of the shorter canvas side. */
    gapPercent: 2,
    /** Ignore overlaps smaller than this many px in either direction (touching edges). */
    minOverlapPx: 2,
  },
  check({ design }, { errorRatio, gapPercent, minOverlapPx }) {
    const gap = (shortSide(design.canvas) * gapPercent) / 100;
    const candidates = design.elements.filter(
      (el) => !hasRole(el, 'background', 'decoration') && el.opacity > 0,
    );
    const issues: RuleIssue[] = [];

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i]!;
        const b = candidates[j]!;
        const overlap = intersection(rectOf(a), rectOf(b));
        if (!overlap || overlap.width < minOverlapPx || overlap.height < minOverlapPx) continue;
        const kind = overlapKind(design, a, b);
        if (!kind) continue;

        const ratio = area(overlap) / Math.min(area(rectOf(a)), area(rectOf(b)));
        // Move the element on top: it is usually the one that was placed last / by mistake.
        const [fixed, mover] = isBelow(design, a, b) ? [a, b] : [b, a];
        const fix: Fix[] = [];
        if (mover.type === 'text' && fixed.type === 'shape') {
          // A label poking out of its button: pull it inside rather than pushing it away.
          const f = rectOf(fixed);
          const m = rectOf(mover);
          if (m.width <= f.width && m.height <= f.height) {
            const dx = Math.max(f.x - m.x, Math.min(0, right(f) - right(m)));
            const dy = Math.max(f.y - m.y, Math.min(0, bottom(f) - bottom(m)));
            fix.push({ op: 'move', elementId: mover.id, dx: round2(dx), dy: round2(dy) });
          }
        }
        if (fix.length === 0) {
          const { dx, dy } = separate(
            rectOf(mover),
            rectOf(fixed),
            gap,
            design.canvas.width,
            design.canvas.height,
          );
          fix.push({ op: 'move', elementId: mover.id, dx: round2(dx), dy: round2(dy) });
        }

        issues.push({
          severity: ratio >= errorRatio ? 'error' : 'warning',
          elementIds: [mover.id, fixed.id],
          message: `${label(mover)} overlaps ${label(fixed)} (${kind}, ${Math.round(ratio * 100)}% of the smaller element).`,
          measured: round2(ratio * 100),
          threshold: 0,
          unit: '% overlap',
          fix,
        });
      }
    }
    return issues;
  },
});
