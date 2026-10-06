import { blend, parseHex } from './color.js';
import type { RGB, RGBA } from './color.js';
import { elementContainsPoint } from './geometry.js';
import type { Point } from './geometry.js';
import type { Design, DesignElement, ImageElement } from './schema.js';
import type { ImageSampler } from './types.js';

const WHITE: RGB = { r: 255, g: 255, b: 255 };

export interface BackdropResult {
  color: RGB;
  /** Images under this point whose pixels could not be read (no sampler or not loaded). */
  unknownImages: string[];
}

/**
 * Maps a canvas point to normalized image coordinates, honoring object-fit.
 * Returns null where a "contain" image leaves the box empty (letterbox bars).
 */
export function imageUV(el: ImageElement, p: Point): { u: number; v: number } | null {
  if (el.fit === 'fill') {
    return { u: (p.x - el.x) / el.width, v: (p.y - el.y) / el.height };
  }
  const sx = el.width / el.naturalWidth;
  const sy = el.height / el.naturalHeight;
  const scale = el.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const drawnW = el.naturalWidth * scale;
  const drawnH = el.naturalHeight * scale;
  const u = (p.x - (el.x + (el.width - drawnW) / 2)) / drawnW;
  const v = (p.y - (el.y + (el.height - drawnH) / 2)) / drawnH;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { u, v };
}

/**
 * The opaque color visible at `p` when only `layers` are painted (in order) over the canvas
 * background. Each layer is alpha-blended using its fill alpha times element opacity.
 */
export function backdropAt(
  design: Design,
  layers: DesignElement[],
  p: Point,
  sampler?: ImageSampler,
): BackdropResult {
  const bg = parseHex(design.canvas.background);
  // A transparent canvas is assumed to be shown on white.
  let color = blend(bg, bg.a, WHITE);
  const unknownImages: string[] = [];

  for (const el of layers) {
    if (el.type === 'text' || el.opacity === 0 || !elementContainsPoint(el, p)) continue;
    let paint: RGBA | null = null;
    if (el.type === 'shape') {
      paint = parseHex(el.fill);
    } else {
      const uv = imageUV(el, p);
      if (!uv) continue;
      if (sampler?.has(el.src)) {
        paint = sampler.sample(el.src, uv.u, uv.v);
      }
      if (!paint) {
        unknownImages.push(el.id);
        continue;
      }
    }
    color = blend(paint, paint.a * el.opacity, color);
  }
  return { color, unknownImages };
}
