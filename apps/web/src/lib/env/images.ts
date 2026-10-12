import type { RasterImage } from '@simonlunay/redline';

/** A decoded image: drawable on a canvas, plus its pixels for the contrast sampler. */
export interface LoadedImage {
  bitmap: ImageBitmap;
  pixels: RasterImage;
  width: number;
  height: number;
}

function pixelsOf(bitmap: ImageBitmap): RasterImage {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { width: bitmap.width, height: bitmap.height, data };
}

/**
 * Loads images by src. `url` turns a design's src into something fetchable (gallery images are
 * relative to their run folder; uploads are data URLs). No color-space conversion, so the
 * sampled pixels match the file, as in Node.
 */
export async function loadImages(
  srcs: Iterable<string>,
  url: (src: string) => string,
): Promise<{ images: Map<string, LoadedImage>; errors: Map<string, string> }> {
  const images = new Map<string, LoadedImage>();
  const errors = new Map<string, string>();
  await Promise.all(
    [...new Set(srcs)].map(async (src) => {
      try {
        const response = await fetch(url(src));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bitmap = await createImageBitmap(await response.blob(), {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'default',
        });
        images.set(src, {
          bitmap,
          pixels: pixelsOf(bitmap),
          width: bitmap.width,
          height: bitmap.height,
        });
      } catch (err) {
        errors.set(src, err instanceof Error ? err.message : String(err));
      }
    }),
  );
  return { images, errors };
}
