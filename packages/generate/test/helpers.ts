import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeSaliencyModel } from '@simonlunay/redline';
import type { SaliencyModel } from '@simonlunay/redline';
import type { CreativeBrief } from '../src/director/types.js';

export const tempDir = (prefix = 'redline-gen-') => mkdtempSync(join(tmpdir(), prefix));

export const brief = (overrides: Partial<CreativeBrief> = {}): CreativeBrief => ({
  prompt: 'poster for a charity 5K, energetic, blue and orange',
  canvas: { width: 1080, height: 1350 },
  layouts: 2,
  fonts: ['Inter'],
  ...overrides,
});

/** Deterministic stand-in for MSI-Net: attention follows brightness, so tests never load ONNX. */
export function brightnessSaliency(): SaliencyModel {
  return createFakeSaliencyModel((x, y, image) => {
    const px = Math.min(image.width - 1, Math.floor(x * image.width));
    const py = Math.min(image.height - 1, Math.floor(y * image.height));
    const i = (py * image.width + px) * 4;
    return 0.05 + (image.data[i]! + image.data[i + 1]! + image.data[i + 2]!) / 765;
  });
}

/** A fetch fake that answers by URL pattern and records requests. */
export function fakeFetch(routes: [RegExp, (url: string, init?: RequestInit) => Response | Promise<Response>][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [pattern, handler] of routes) if (pattern.test(url)) return handler(url, init);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}
