import { isAbsolute, resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Image } from '@napi-rs/canvas';
import type { Design } from '../core/schema.js';
import type { ImageSampler } from '../core/types.js';

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Resolves an image src relative to the design file. Data URLs and http(s) pass through. */
export function resolveSrc(src: string, baseDir: string): string {
  if (/^(data:|https?:)/.test(src) || isAbsolute(src)) return src;
  return resolve(baseDir, src);
}

export interface LoadedImages {
  images: Map<string, Image>;
  /** src -> error message for images that could not be loaded. */
  errors: Map<string, string>;
}

/** Loads every distinct image referenced by the design (missing files are reported, not thrown). */
export async function loadDesignImages(design: Design, baseDir: string): Promise<LoadedImages> {
  const images = new Map<string, Image>();
  const errors = new Map<string, string>();
  const sources = new Set(design.elements.flatMap((el) => (el.type === 'image' ? [el.src] : [])));
  await Promise.all(
    [...sources].map(async (src) => {
      try {
        images.set(src, await loadImage(resolveSrc(src, baseDir)));
      } catch (err) {
        errors.set(src, err instanceof Error ? err.message : String(err));
      }
    }),
  );
  return { images, errors };
}

/**
 * Decodes images once into raw RGBA buffers so `sample()` is a cheap synchronous lookup.
 * This is what lets the core `check()` stay synchronous.
 */
export function createImageSampler(images: Map<string, Image>): ImageSampler {
  const pixels = new Map<string, Pixels>();
  for (const [src, img] of images) {
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    pixels.set(src, {
      width: img.width,
      height: img.height,
      data: ctx.getImageData(0, 0, img.width, img.height).data,
    });
  }
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
