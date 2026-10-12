import type { FontSpec, TextMeasurer } from './text-measure.js';
import type { ImageSampler, RasterImage } from './types.js';

/**
 * An ImageSampler over pixels decoded ahead of time (nearest pixel, alpha as 0..1). Node decodes
 * with Skia, the browser with a canvas; the lookup is the same code in both.
 */
export function createRasterSampler(pixels: Map<string, RasterImage>): ImageSampler {
  return {
    has: (src) => pixels.has(src),
    sample(src, u, v) {
      const p = pixels.get(src);
      if (!p) return null;
      const x = Math.min(p.width - 1, Math.max(0, Math.floor(u * p.width)));
      const y = Math.min(p.height - 1, Math.max(0, Math.floor(v * p.height)));
      const i = (y * p.width + x) * 4;
      return { r: p.data[i]!, g: p.data[i + 1]!, b: p.data[i + 2]!, a: p.data[i + 3]! / 255 };
    },
  };
}

/** The part of a 2D canvas context that measures text. */
export interface MeasureContext {
  font: string;
  measureText(text: string): { width: number };
}

/**
 * A TextMeasurer backed by a canvas context with real fonts loaded (Skia in Node, the browser's
 * canvas in the web app), cached per font and string.
 */
export function createContextMeasurer(
  ctx: MeasureContext,
  cssFont: (font: FontSpec) => string,
): TextMeasurer {
  const cache = new Map<string, number>();
  return {
    measure(text, font) {
      const css = cssFont(font);
      const key = `${css}|${text}`;
      let width = cache.get(key);
      if (width === undefined) {
        ctx.font = css;
        width = ctx.measureText(text).width;
        cache.set(key, width);
      }
      return width;
    },
  };
}
