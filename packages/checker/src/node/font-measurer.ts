import { createCanvas } from '@napi-rs/canvas';
import { createContextMeasurer } from '../core/environment.js';
import type { TextMeasurer } from '../core/text-measure.js';
import { cssFont, registerBundledFonts } from './fonts.js';

/**
 * Precise TextMeasurer backed by real font files through Skia (@napi-rs/canvas).
 * It uses the same engine as the PNG renderer, so "this text overflows" in a report
 * always matches what the rendered preview shows.
 */
export function createFontMeasurer(): TextMeasurer {
  registerBundledFonts();
  return createContextMeasurer(createCanvas(1, 1).getContext('2d'), cssFont);
}
