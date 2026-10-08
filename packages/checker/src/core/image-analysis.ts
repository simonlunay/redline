import type { CutoutVerdict } from './cutout-quality.js';
import type { Rect } from './geometry.js';
import type { ImageElement } from './schema.js';

/**
 * Where an image came from. Generated and stock images must not contain text (it's always a
 * defect there); a user's own image may (a product label, a sign in a photo).
 */
export type ImageOrigin = 'generated' | 'stock' | 'user';

/** A text-like region found in an image, in normalized image coordinates (0..1). */
export interface TextRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Detector confidence, 0..1. */
  score: number;
  /** Characters the recognizer read in the region (gibberish counts), when it ran. */
  chars?: number;
  /** The recognizer's mean per-character confidence, 0..1. */
  readConfidence?: number;
}

/**
 * What was found in one image file, ahead of the check (like decoded pixels, the analysis is
 * async and model-based, so it's done before the synchronous rules run).
 */
export interface ImageAnalysis {
  origin: ImageOrigin;
  /** Text-like regions. Undefined when text detection didn't run (no model). */
  text?: TextRegion[];
  /** Set for cutouts (images with real transparency): the cutout-quality verdict. */
  cutout?: CutoutVerdict;
}

/** Image analyses by src. Passed to check() / checkAsync() as `images`. */
export interface ImageAnalysisSource {
  get(src: string): ImageAnalysis | undefined;
}

/**
 * Maps a normalized image rect to canvas pixels, honoring object-fit (the inverse of imageUV),
 * clipped to the element's box. Null when nothing of it is visible in the box.
 */
export function imageRectToCanvas(el: ImageElement, r: Rect): Rect | null {
  let ox = el.x;
  let oy = el.y;
  let w = el.width;
  let h = el.height;
  if (el.fit !== 'fill') {
    const sx = el.width / el.naturalWidth;
    const sy = el.height / el.naturalHeight;
    const scale = el.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
    w = el.naturalWidth * scale;
    h = el.naturalHeight * scale;
    ox = el.x + (el.width - w) / 2;
    oy = el.y + (el.height - h) / 2;
  }
  const x0 = Math.max(el.x, ox + r.x * w);
  const y0 = Math.max(el.y, oy + r.y * h);
  const x1 = Math.min(el.x + el.width, ox + (r.x + r.width) * w);
  const y1 = Math.min(el.y + el.height, oy + (r.y + r.height) * h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
