import { bottom, centerX, centerY, containsRect, rectOf, right, round2 } from '../geometry.js';
import type { Rect } from '../geometry.js';
import { fontOf, layoutText, wrapText } from '../text-measure.js';
import type { TextMeasurer } from '../text-measure.js';
import type { Design, ShapeElement, TextElement } from '../schema.js';
import { defineRule } from '../types.js';
import type { Fix, RuleIssue } from '../types.js';
import { hasRole, isBelow, label, px } from './util.js';

/**
 * Where the text actually renders, not its box: the renderer draws wrapped lines from the top
 * of the box (each line centered in its line box) and places them by `align`. A label whose
 * box fills its button therefore sits high, and a left-aligned label in a wide box sits left.
 */
export function renderedTextBounds(
  el: TextElement,
  measurer: TextMeasurer,
  box: Rect = rectOf(el),
): Rect {
  const font = fontOf(el);
  const lines = wrapText(el.content, box.width, font, measurer);
  const widths = lines.map((l) => measurer.measure(l, font));
  const lefts = widths.map((w) =>
    el.align === 'left'
      ? box.x
      : el.align === 'right'
        ? right(box) - w
        : box.x + (box.width - w) / 2,
  );
  const x = Math.min(...lefts);
  const width = Math.max(...lefts.map((l, i) => l + widths[i]!)) - x;
  return { x, y: box.y, width, height: lines.length * el.fontSize * el.lineHeight };
}

/**
 * The shape a text element is the label of, or null. A text belongs to a shape painted below
 * it when they share a groupId (a group of exactly one shape and one text) or when the text
 * sits inside the shape and is the only text in it. Panels, cards and full-width bands are not
 * labels' containers: they usually hold left-aligned copy on purpose.
 */
function containerOf(
  design: Design,
  t: TextElement,
  rendered: Rect,
  maxHeightRatio: number,
): ShapeElement | null {
  const texts = design.elements.filter(
    (e): e is TextElement => e.type === 'text' && e.content.trim() !== '' && e.opacity > 0,
  );
  const inside = (s: ShapeElement, e: TextElement) => {
    const box = rectOf(e);
    const c = { x: centerX(box), y: centerY(box) };
    return (
      (c.x >= s.x && c.x <= right(s) && c.y >= s.y && c.y <= bottom(s)) ||
      containsRect(rectOf(s), box)
    );
  };
  const candidates = design.elements.filter((s): s is ShapeElement => {
    if (s.type !== 'shape' || s.rotation % 360 !== 0 || s.opacity === 0) return false;
    if (hasRole(s, 'background')) return false;
    if (s.width >= design.canvas.width * 0.9 || s.height >= design.canvas.height * 0.9)
      return false;
    if (s.height > rendered.height * maxHeightRatio) return false;
    if (!isBelow(design, s, t)) return false;
    if (t.groupId !== undefined && s.groupId === t.groupId) {
      const group = design.elements.filter((e) => e.groupId === t.groupId);
      return (
        group.filter((e) => e.type === 'shape').length === 1 &&
        group.filter((e) => e.type === 'text').length === 1
      );
    }
    return (
      (inside(s, t) || containsRect(rectOf(s), rendered)) &&
      texts.every((o) => o === t || !inside(s, o))
    );
  });
  // The tightest container wins (a button on a card is the label's container, not the card).
  candidates.sort((a, b) => a.width * a.height - b.width * b.height);
  return candidates[0] ?? null;
}

/**
 * The fix: shrink the box to the text block (so the box no longer pushes the text to the top)
 * and move it so the rendered text is centered. The width only changes when the box is wider
 * than the shape and narrowing it keeps the same line breaks.
 */
function centeringFix(el: TextElement, shape: ShapeElement, measurer: TextMeasurer): Fix[] {
  let width = el.width;
  if (width > shape.width) {
    const font = fontOf(el);
    const same =
      wrapText(el.content, shape.width, font, measurer).join('\n') ===
      wrapText(el.content, el.width, font, measurer).join('\n');
    if (same) width = shape.width;
  }
  const height = Math.ceil(layoutText({ ...el, width }, measurer).height * 100) / 100;
  const fixes: Fix[] = [];
  if (round2(width) !== round2(el.width) || height !== round2(el.height)) {
    fixes.push({ op: 'resize', elementId: el.id, width: round2(width), height });
  }
  const after = renderedTextBounds(el, measurer, { x: el.x, y: el.y, width, height });
  const dx = round2(centerX(shape) - centerX(after));
  const dy = round2(centerY(shape) - centerY(after));
  if (dx !== 0 || dy !== 0) fixes.push({ op: 'move', elementId: el.id, dx, dy });
  return fixes;
}

export const labelCentered = defineRule({
  id: 'label-centered',
  description:
    'A label (button text, badge text) whose rendered text is not centered in its shape. Measured on the wrapped text as it renders, not on the text box.',
  defaultSeverity: 'warning',
  weight: 2,
  defaultOptions: {
    /**
     * Allowed offset of the text center from the shape center on either axis, as % of the
     * shape's shorter side. The shorter side, so a wide pill isn't allowed a sloppier
     * horizontal offset than its padding can hide.
     */
    tolerancePercent: 5,
    /** ...but never less than this many px (rounding, and glyph ink vs. line box). */
    minTolerancePx: 3,
    /** Shapes taller than this many times the text are panels or cards, not label containers. */
    maxHeightRatio: 4,
  },
  check({ design, measurer }, { tolerancePercent, minTolerancePx, maxHeightRatio }) {
    const issues: RuleIssue[] = [];
    for (const el of design.elements) {
      if (el.type !== 'text' || el.content.trim() === '' || el.opacity === 0) continue;
      if (el.rotation % 360 !== 0) continue;
      const rendered = renderedTextBounds(el, measurer);
      const shape = containerOf(design, el, rendered, maxHeightRatio);
      if (!shape) continue;

      const offX = centerX(rendered) - centerX(shape);
      const offY = centerY(rendered) - centerY(shape);
      const tol = Math.max(
        minTolerancePx,
        (Math.min(shape.width, shape.height) * tolerancePercent) / 100,
      );
      const badX = Math.abs(offX) > tol;
      const badY = Math.abs(offY) > tol;
      if (!badX && !badY) continue;

      // Text touching or crossing the shape's edge on an off axis looks broken, not just off.
      const touches =
        (badX && (rendered.x <= shape.x || right(rendered) >= right(shape))) ||
        (badY && (rendered.y <= shape.y || bottom(rendered) >= bottom(shape)));
      const where = [
        badY ? `${px(Math.abs(offY))} too ${offY < 0 ? 'high' : 'low'}` : '',
        badX ? `${px(Math.abs(offX))} too far ${offX < 0 ? 'left' : 'right'}` : '',
      ]
        .filter(Boolean)
        .join(' and ');
      const yWorse = Math.abs(offY) >= Math.abs(offX);
      issues.push({
        severity: touches ? 'error' : 'warning',
        elementIds: [el.id, shape.id],
        message: `${label(el)} renders ${where} in ${label(shape)}${touches ? ', touching its edge' : ''}.`,
        measured: round2(Math.abs(yWorse ? offY : offX)),
        threshold: round2(tol),
        unit: 'px',
        fix: centeringFix(el, shape, measurer),
      });
    }
    return issues;
  },
});
