import { parseHex } from '../color.js';
import { canvasRect, containsRect, intersection, shortSide } from '../geometry.js';
import type { Rect } from '../geometry.js';
import { imageRectToCanvas } from '../image-analysis.js';
import type { Design, DesignElement, ImageElement } from '../schema.js';
import { defineRule } from '../types.js';
import type { RuleIssue } from '../types.js';
import { label, paintOrder } from './util.js';

/** True when an opaque, unrotated rectangle painted above `el` hides all of `r`. */
export function hiddenAbove(design: Design, el: DesignElement, r: Rect): boolean {
  const order = paintOrder(design);
  for (const other of order.slice(order.indexOf(el) + 1)) {
    if (other.type !== 'shape' || other.kind !== 'rect' || other.rotation !== 0) continue;
    if (other.opacity < 0.95 || parseHex(other.fill).a < 0.95) continue;
    if (containsRect(other, r)) return true;
  }
  return false;
}

/** Text-region rects of an image, in canvas px, visible in the design and tall enough. */
export function visibleTextRegions(
  design: Design,
  el: ImageElement,
  regions: { x: number; y: number; width: number; height: number; score: number }[],
  minHeight: number,
  minScore: number,
): Rect[] {
  const out: Rect[] = [];
  for (const region of regions) {
    if (region.score < minScore) continue;
    const mapped = imageRectToCanvas(el, region);
    const visible = mapped && intersection(mapped, canvasRect(design.canvas));
    if (!visible || visible.height < minHeight) continue;
    if (hiddenAbove(design, el, visible)) continue;
    out.push(visible);
  }
  return out;
}

const box = (r: Rect) =>
  `(${Math.round(r.x)}, ${Math.round(r.y)}) ${Math.round(r.width)}x${Math.round(r.height)} px`;

/**
 * Text drawn into an image: image models ignore "no text" sometimes and paint gibberish
 * lettering, fake buttons or signs, which read as broken copy. Needs image analysis (a text
 * detector run on each image ahead of the check).
 */
export const imageText = defineRule({
  id: 'image-text',
  description:
    'Text-like marks drawn into a generated or stock image (gibberish lettering, fake signs or buttons). Text belongs in text elements; regenerate the image with a brief that forbids text.',
  defaultSeverity: 'error',
  weight: 3,
  requires: ['images'],
  defaultOptions: {
    /** Regions shorter than this share of the canvas's short side are ignored (fine texture). */
    minHeightFraction: 0.012,
    /** Detector confidence below this is ignored. */
    minScore: 0.6,
  },
  check({ design, images }, { minHeightFraction, minScore }) {
    const issues: RuleIssue[] = [];
    const minHeight = minHeightFraction * shortSide(design.canvas);
    for (const el of design.elements) {
      if (el.type !== 'image' || el.opacity < 0.05) continue;
      const analysis = images?.get(el.src);
      if (!analysis?.text?.length) continue;
      const regions = visibleTextRegions(design, el, analysis.text, minHeight, minScore);
      if (regions.length === 0) continue;
      const largest = regions.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
      const own = analysis.origin === 'user';
      issues.push({
        // A user's photo may legitimately show text (a label, a sign); generated images may not.
        severity: own ? 'warning' : 'error',
        elementIds: [el.id],
        message: `${label(el)} has text-like marks drawn into the image: ${regions.length} region${regions.length === 1 ? '' : 's'}, the largest at ${box(largest)}. ${
          own
            ? 'Check that this text is meant to be there.'
            : 'Text belongs in text elements: regenerate this image with a brief that says "no text, no lettering, no signs, no labels, no buttons", or cover the area.'
        }`,
        measured: regions.length,
        threshold: 0,
        unit: 'text regions',
      });
    }
    return issues;
  },
});
