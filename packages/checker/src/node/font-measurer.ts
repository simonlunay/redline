import { createCanvas } from '@napi-rs/canvas';
import type { TextMeasurer } from '../core/text-measure.js';
import { cssFont, registerBundledFonts } from './fonts.js';

/**
 * Precise TextMeasurer backed by real font files through Skia (@napi-rs/canvas).
 * It uses the same engine as the PNG renderer, so "this text overflows" in a report
 * always matches what the rendered preview shows.
 */
export function createFontMeasurer(): TextMeasurer {
  registerBundledFonts();
  const ctx = createCanvas(1, 1).getContext('2d');
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
