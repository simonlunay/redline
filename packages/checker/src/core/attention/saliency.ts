import type { RasterImage } from '../types.js';

/**
 * Predicted attention over the canvas: a width x height grid (row-major) of non-negative
 * values that sum to 1. Cell (col, row) covers the canvas region of size
 * (canvas.width / width) x (canvas.height / height). The grid has the canvas aspect ratio.
 */
export interface SaliencyMap {
  width: number;
  height: number;
  data: Float32Array;
}

/**
 * Anything that predicts where people look: an ONNX model in Node (see node/saliency), the same
 * model via onnxruntime-web in a browser later, or a fake in tests. Render in, heatmap out.
 */
export interface SaliencyModel {
  /** Stable id including the weights version, used for caching and reports. */
  id: string;
  predict(image: RasterImage): Promise<SaliencyMap>;
}

/** Scales values so they sum to 1 (uniform if everything is 0). Returns a new map. */
export function normalizeSaliency(map: SaliencyMap): SaliencyMap {
  let sum = 0;
  for (const v of map.data) sum += Math.max(0, v);
  const data = new Float32Array(map.data.length);
  for (let i = 0; i < data.length; i++) {
    data[i] = sum > 0 ? Math.max(0, map.data[i]!) / sum : 1 / data.length;
  }
  return { width: map.width, height: map.height, data };
}

/**
 * FNV-1a hash of a raster's pixels, sampled with a stride so a full HD render hashes in a few
 * milliseconds. Collisions would need two renders that differ only between sampled bytes,
 * which the stride (a prime) makes vanishingly unlikely for real designs.
 */
export function hashRaster(image: RasterImage): string {
  let h = 0x811c9dc5;
  const step = image.data.length > 400_000 ? 7 : 1;
  for (let i = 0; i < image.data.length; i += step) {
    h ^= image.data[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return `${image.width}x${image.height}:${(h >>> 0).toString(16)}`;
}

/**
 * Wraps a model with an in-memory LRU cache keyed by the render's pixels. The fix loop re-checks
 * identical designs (after rollbacks) and the eval checks each original several times, so this
 * avoids repeated inference. Concurrent requests for the same image share one prediction.
 */
export function cachedSaliencyModel(
  model: SaliencyModel,
  maxEntries = 64,
): SaliencyModel & {
  stats: { hits: number; misses: number };
} {
  const cache = new Map<string, Promise<SaliencyMap>>();
  const stats = { hits: 0, misses: 0 };
  return {
    id: model.id,
    stats,
    predict(image) {
      const key = hashRaster(image);
      const cached = cache.get(key);
      if (cached) {
        stats.hits++;
        cache.delete(key); // re-insert to mark as most recently used
        cache.set(key, cached);
        return cached;
      }
      stats.misses++;
      const result = model.predict(image);
      cache.set(key, result);
      result.catch(() => cache.delete(key)); // don't cache failures
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
      return result;
    },
  };
}

/**
 * Deterministic model for tests and demos without weights: attention = fn(x, y) evaluated on a
 * grid over the canvas (x, y in 0..1), then normalized.
 */
export function createFakeSaliencyModel(
  fn: (x: number, y: number, image: RasterImage) => number,
  options: { id?: string; width?: number } = {},
): SaliencyModel {
  return {
    id: options.id ?? 'fake',
    async predict(image) {
      const width = options.width ?? 64;
      const height = Math.max(1, Math.round((width * image.height) / image.width));
      const data = new Float32Array(width * height);
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          data[row * width + col] = fn((col + 0.5) / width, (row + 0.5) / height, image);
        }
      }
      return normalizeSaliency({ width, height, data });
    },
  };
}
