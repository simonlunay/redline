import { area, canvasRect, intersection, rotatedBounds, round2 } from '../geometry.js';
import { defineRule } from '../types.js';
import type { Fix, RuleIssue } from '../types.js';
import { clampDelta, hasRole, label } from './util.js';

export const offCanvas = defineRule({
  id: 'off-canvas',
  description: 'Elements that are partly or fully outside the canvas (backgrounds are ignored).',
  defaultSeverity: 'warning',
  weight: 2,
  defaultOptions: {
    /** Pixels an element may stick out before it counts (anti-aliasing slack). */
    tolerance: 1,
  },
  check({ design }, { tolerance }) {
    const { width: W, height: H } = design.canvas;
    const canvas = canvasRect(design.canvas);
    const issues: RuleIssue[] = [];

    for (const el of design.elements) {
      if (hasRole(el, 'background') || el.opacity === 0) continue;
      // Rotated bounds: a rotated card can poke out of the canvas even if its x/y look fine.
      const b = rotatedBounds(el);
      const outside =
        b.x < -tolerance ||
        b.y < -tolerance ||
        b.x + b.width > W + tolerance ||
        b.y + b.height > H + tolerance;
      if (!outside) continue;

      const visible = intersection(b, canvas);
      const outsidePct = area(b) === 0 ? 100 : (1 - (visible ? area(visible) : 0) / area(b)) * 100;
      const fully = visible === null;

      const fix: Fix[] = [];
      if (b.width > W || b.height > H) {
        // Too big to fit at all: scale it down first (keeping its aspect ratio).
        const scale = Math.min(W / b.width, H / b.height);
        fix.push({
          op: 'resize',
          elementId: el.id,
          width: Math.floor(el.width * scale),
          height: Math.floor(el.height * scale),
        });
        fix.push({ op: 'move', elementId: el.id, dx: round2(-el.x), dy: round2(-el.y) });
      } else {
        fix.push({
          op: 'move',
          elementId: el.id,
          dx: round2(clampDelta(b.x, b.width, 0, W)),
          dy: round2(clampDelta(b.y, b.height, 0, H)),
        });
      }

      issues.push({
        severity: fully ? 'error' : 'warning',
        elementIds: [el.id],
        message: fully
          ? `${label(el)} is completely outside the canvas and will not be visible.`
          : `${label(el)} is ${Math.round(outsidePct)}% outside the canvas and will be cut off.`,
        measured: round2(outsidePct),
        threshold: 0,
        unit: '% outside',
        fix,
      });
    }
    return issues;
  },
});
