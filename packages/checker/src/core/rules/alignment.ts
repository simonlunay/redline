import {
  bottom,
  centerX,
  centerY,
  containsRect,
  rectOf,
  right,
  round2,
  shortSide,
} from '../geometry.js';
import type { Rect } from '../geometry.js';
import type { DesignElement } from '../schema.js';
import { defineRule } from '../types.js';
import type { RuleIssue } from '../types.js';
import { hasRole, label, px } from './util.js';

type Axis = 'x' | 'y';

interface EdgeKind {
  axis: Axis;
  name: string;
  get: (r: Rect) => number;
}

const EDGE_KINDS: EdgeKind[] = [
  { axis: 'x', name: 'left edge', get: (r) => r.x },
  { axis: 'x', name: 'horizontal center', get: centerX },
  { axis: 'x', name: 'right edge', get: right },
  { axis: 'y', name: 'top edge', get: (r) => r.y },
  { axis: 'y', name: 'vertical center', get: centerY },
  { axis: 'y', name: 'bottom edge', get: bottom },
];

/** Differences at or below this are "exactly aligned" (sub-pixel noise). */
const EXACT = 0.5;

interface Item {
  id: string;
  el?: DesignElement;
  rect: Rect;
}

export const alignment = defineRule({
  id: 'alignment',
  description:
    'Elements that are almost, but not quite, aligned (edges or centers a few pixels apart). Near-misses look accidental; either align exactly or offset clearly.',
  defaultSeverity: 'warning',
  weight: 1,
  defaultOptions: {
    /** Max offset (as % of the shorter side) that counts as a near-miss. 0.8% = ~8.6px on 1080. */
    tolerancePercent: 0.8,
  },
  check({ design }, { tolerancePercent }) {
    const tolerance = (shortSide(design.canvas) * tolerancePercent) / 100;

    const items: Item[] = design.elements
      .filter((el) => !hasRole(el, 'background', 'decoration') && el.opacity > 0)
      .map((el) => ({ id: el.id, el, rect: rectOf(el) }));
    // The canvas itself is an alignment target, so "almost centered" is caught too.
    const canvasItem: Item = {
      id: '(canvas)',
      rect: { x: 0, y: 0, width: design.canvas.width, height: design.canvas.height },
    };

    const isAligned = (a: Item, b: Item, axis: Axis) =>
      EDGE_KINDS.some(
        (k) =>
          k.axis === axis &&
          // For the canvas only its center lines count; aligning to its edges is safe-margins' job.
          (k.name.includes('center') || (a !== canvasItem && b !== canvasItem)) &&
          Math.abs(k.get(a.rect) - k.get(b.rect)) <= EXACT,
      );
    // "Anchored" = already exactly aligned with something on this axis. Moving an anchored
    // element would break an alignment that is clearly intentional.
    const anchored = (item: Item, axis: Axis) =>
      item === canvasItem ||
      [...items, canvasItem].some((o) => o !== item && isAligned(item, o, axis));

    const issues: RuleIssue[] = [];
    const reported = new Set<string>();

    for (const kind of EDGE_KINDS) {
      const targets = kind.name.includes('center') ? [...items, canvasItem] : items;
      for (let i = 0; i < items.length; i++) {
        const a = items[i]!;
        for (const b of targets) {
          if (a === b) continue;
          // Visit each element pair once; the canvas is visited from every element.
          if (b !== canvasItem && targets.indexOf(b) < i) continue;
          // A label inside its button is laid out relative to the button, not aligned to it.
          if (b !== canvasItem && (containsRect(a.rect, b.rect) || containsRect(b.rect, a.rect))) {
            continue;
          }
          const delta = kind.get(b.rect) - kind.get(a.rect);
          if (Math.abs(delta) <= EXACT || Math.abs(delta) > tolerance) continue;
          if (isAligned(a, b, kind.axis)) continue;

          // Decide who moves: never the canvas, prefer the non-anchored element,
          // then the smaller one (moving a small badge is less disruptive than a hero image).
          const aAnchored = anchored(a, kind.axis);
          const bAnchored = anchored(b, kind.axis);
          if (aAnchored && bAnchored) continue;
          let mover: Item;
          let target: Item;
          if (aAnchored !== bAnchored) {
            [mover, target] = aAnchored ? [b, a] : [a, b];
          } else {
            const aArea = a.rect.width * a.rect.height;
            const bArea = b.rect.width * b.rect.height;
            [mover, target] = aArea <= bArea ? [a, b] : [b, a];
          }
          const moverEl = mover.el!;
          const key = `${mover.id}:${kind.axis}`;
          if (reported.has(key)) continue;
          reported.add(key);

          const shift = round2(kind.get(target.rect) - kind.get(mover.rect));
          const targetLabel = target === canvasItem ? 'the canvas' : `"${target.id}"`;
          issues.push({
            elementIds: target === canvasItem ? [mover.id] : [mover.id, target.id],
            message: `${label(moverEl)} ${kind.name} is ${px(Math.abs(shift))} off the ${kind.name} of ${targetLabel}; this looks accidental.`,
            measured: Math.abs(shift),
            threshold: round2(tolerance),
            unit: 'px',
            fix: [
              {
                op: 'move',
                elementId: mover.id,
                dx: kind.axis === 'x' ? shift : 0,
                dy: kind.axis === 'y' ? shift : 0,
              },
            ],
          });
        }
      }
    }
    return issues;
  },
});
