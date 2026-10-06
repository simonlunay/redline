import { backdropAt } from '../backdrop.js';
import { blend, contrastRatio, nearestPassingColor, parseHex } from '../color.js';
import type { RGB } from '../color.js';
import { gridPoints, round2, shortSide } from '../geometry.js';
import type { Point } from '../geometry.js';
import type { TextElement } from '../schema.js';
import { fontOf, layoutText } from '../text-measure.js';
import type { TextMeasurer } from '../text-measure.js';
import { defineRule } from '../types.js';
import type { RuleIssue } from '../types.js';
import { hasRole, label, paintOrder } from './util.js';

/**
 * Sample points where glyphs actually are: one band per wrapped line, sized to that line's
 * measured width and positioned by alignment. Sampling the whole box would test empty space
 * (e.g. the right half of a short left-aligned word), which gives misleading results.
 */
function inkPoints(el: TextElement, measurer: TextMeasurer, cols: number): Point[] {
  const layout = layoutText(el, measurer);
  const font = fontOf(el);
  const points: Point[] = [];
  layout.lines.forEach((line, i) => {
    const top = el.y + i * layout.lineHeightPx + (layout.lineHeightPx - el.fontSize) / 2;
    if (line.trim() === '' || top >= el.y + el.height) return;
    const width = Math.min(el.width, measurer.measure(line, font));
    const x =
      el.align === 'left'
        ? el.x
        : el.align === 'right'
          ? el.x + el.width - width
          : el.x + (el.width - width) / 2;
    points.push(...gridPoints({ x, y: top, width, height: el.fontSize }, cols, 2));
  });
  return points;
}

export const textContrast = defineRule({
  id: 'text-contrast',
  description:
    'WCAG 2.x contrast between text and what is actually behind it (canvas, shapes and image pixels, composited in z-order). 4.5:1 for normal text, 3:1 for large text.',
  defaultSeverity: 'error',
  weight: 4,
  defaultOptions: {
    normalRatio: 4.5,
    largeRatio: 3,
    /** WCAG "large text": 24px regular or 18.66px bold, at the reference canvas size below. */
    largeSizePx: 24,
    largeBoldSizePx: 18.66,
    /**
     * Font sizes are normalized to a canvas with this shorter side, so 40px on a 2160px
     * canvas counts like 20px on a 1080px one (both end up the same size on a phone).
     */
    referenceShortSide: 1080,
    /** Sample points per line, horizontally. */
    samplesPerLine: 6,
  },
  check({ design, measurer, sampler }, options) {
    const issues: RuleIssue[] = [];
    const scale = options.referenceShortSide / shortSide(design.canvas);
    const order = paintOrder(design);

    for (const el of design.elements) {
      if (el.type !== 'text' || el.content.trim() === '' || el.opacity === 0) continue;
      // WCAG exempts logotypes and purely decorative text.
      if (hasRole(el, 'logo', 'decoration')) continue;

      const size = el.fontSize * scale;
      const large =
        size >= options.largeSizePx || (el.fontWeight >= 700 && size >= options.largeBoldSizePx);
      const required = large ? options.largeRatio : options.normalRatio;

      const layersBelow = order.slice(0, order.indexOf(el));
      const fg = parseHex(el.color);
      const fgOpaque: RGB = { r: fg.r, g: fg.g, b: fg.b };

      let worst = Infinity;
      const backgrounds: RGB[] = [];
      const unknown = new Set<string>();
      for (const p of inkPoints(el, measurer, options.samplesPerLine)) {
        const { color: bg, unknownImages } = backdropAt(design, layersBelow, p, sampler);
        if (unknownImages.length > 0) {
          unknownImages.forEach((id) => unknown.add(id));
          continue;
        }
        // Semi-transparent text is blended with the backdrop before measuring.
        const visibleFg = blend(fgOpaque, fg.a * el.opacity, bg);
        worst = Math.min(worst, contrastRatio(visibleFg, bg));
        backgrounds.push(bg);
      }

      const sizeNote = large ? 'large text' : 'normal text';
      if (worst < required) {
        const suggested = nearestPassingColor(fgOpaque, backgrounds, required);
        issues.push({
          severity: 'error',
          elementIds: [el.id, ...unknown],
          message: `${label(el)} has a contrast of ${round2(worst)}:1 against what is behind it; ${sizeNote} needs ${required}:1.`,
          measured: round2(worst),
          threshold: required,
          unit: ':1',
          fix: [{ op: 'setColor', elementId: el.id, color: suggested }],
        });
      } else if (unknown.size > 0) {
        issues.push({
          severity: 'warning',
          elementIds: [el.id, ...unknown],
          message: `Contrast of ${label(el)} could not be verified: it sits on image ${[...unknown].map((id) => `"${id}"`).join(', ')} and no pixel data was available.`,
          measured: 'unknown',
          threshold: required,
          unit: ':1',
        });
      }
    }
    return issues;
  },
});
