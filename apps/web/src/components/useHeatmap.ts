'use client';

import { useEffect, useState } from 'react';

/**
 * The predicted-attention overlay, from the gallery's 8-bit map (peak = white).
 *
 * One hue, like a highlighter on a proof: where viewers are predicted to look stays bright and
 * gets a yellow wash, and the rest is veiled. It's a sequential scale (more = brighter), with no
 * red, because red marks problems on this page.
 */
const VEIL: [number, number, number] = [10, 20, 16];
const HIGHLIGHT: [number, number, number] = [255, 225, 77];

export function colorize(gray: Uint8ClampedArray, width: number, height: number): ImageData {
  const out = new ImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const v = gray[i * 4]! / 255;
    const ah = 0.5 * v ** 1.4;
    const av = 0.7 * (1 - v) ** 1.6;
    const a = ah + av * (1 - ah);
    for (let c = 0; c < 3; c++) {
      out.data[i * 4 + c] = a > 0 ? (HIGHLIGHT[c]! * ah + VEIL[c]! * av * (1 - ah)) / a : 0;
    }
    out.data[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

const cache = new Map<string, Promise<ImageData>>();

async function load(url: string): Promise<ImageData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return colorize(data, bitmap.width, bitmap.height);
}

/** The colored overlay for `url`, or null while it loads (or when there's none). */
export function useHeatmap(url: string | undefined): ImageData | null {
  const [state, setState] = useState<{ url: string; data: ImageData } | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    let promise = cache.get(url);
    if (!promise) {
      promise = load(url);
      cache.set(url, promise);
      promise.catch(() => cache.delete(url));
    }
    promise.then(
      (data) => live && setState({ url, data }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [url]);
  // Keep the previous map on screen until the next one is ready, so steps crossfade cleanly.
  return url ? (state?.data ?? null) : null;
}
