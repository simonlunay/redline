import { loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { createMockImageProvider } from '../src/node/mock-provider.js';
import { createPexelsProvider } from '../src/providers/pexels.js';
import { FLUX_SCHNELL, createReplicateFluxProvider } from '../src/providers/replicate.js';
import { closestAspectRatio } from '../src/providers/types.js';
import type { ImageProvider, ImageRequest } from '../src/providers/types.js';
import { fakeFetch } from './helpers.js';

const request = (overrides: Partial<ImageRequest> = {}): ImageRequest => ({
  prompt: 'a calm lake at dawn. No text.',
  query: 'calm lake dawn',
  width: 1080,
  height: 1350,
  seed: 42,
  kind: 'background',
  ...overrides,
});

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const noSleep = async () => {};

/** The contract every provider must meet. */
async function expectProviderContract(provider: ImageProvider) {
  expect(provider.id).toBeTruthy();
  expect(provider.license).toBeTruthy();
  expect(provider.estimateCostUsd(request())).toBeGreaterThanOrEqual(0);
  const image = await provider.generate(request());
  expect(image.bytes.length).toBeGreaterThan(0);
  expect(image.mimeType).toMatch(/^image\//);
  expect(image).toMatchObject({
    provider: provider.id,
    model: provider.model,
    license: provider.license,
  });
  expect(image.costUsd).toBeLessThanOrEqual(provider.estimateCostUsd(request()));
  return image;
}

describe('closestAspectRatio', () => {
  it('picks the nearest supported ratio in log space', () => {
    const ratios = ['1:1', '16:9', '4:5', '9:16', '21:9'];
    expect(closestAspectRatio(1080, 1350, ratios)).toBe('4:5');
    expect(closestAspectRatio(1080, 1920, ratios)).toBe('9:16');
    expect(closestAspectRatio(1200, 628, ratios)).toBe('16:9');
    expect(closestAspectRatio(1500, 500, ratios)).toBe('21:9');
  });
});

describe('mock image provider', () => {
  it('meets the provider contract, is free and deterministic per seed', async () => {
    const mock = createMockImageProvider();
    const a = await expectProviderContract(mock);
    const b = await mock.generate(request());
    const c = await mock.generate(request({ seed: 43 }));
    expect(a.costUsd).toBe(0);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(Buffer.from(a.bytes).equals(Buffer.from(c.bytes))).toBe(false);
    const img = await loadImage(Buffer.from(a.bytes));
    expect(img.width / img.height).toBeCloseTo(1080 / 1350, 1);
  });
});

describe('Replicate FLUX.1 [schnell] provider', () => {
  function routes(firstStatus = 'succeeded') {
    let polls = 0;
    return fakeFetch([
      [
        /\/models\/black-forest-labs\/flux-schnell\/predictions$/,
        () =>
          Response.json({
            id: 'p1',
            status: firstStatus,
            output: firstStatus === 'succeeded' ? ['https://replicate.delivery/out.png'] : null,
            urls: { get: 'https://api.replicate.com/v1/predictions/p1' },
          }),
      ],
      [
        /\/predictions\/p1$/,
        () => {
          polls++;
          return Response.json(
            polls < 2
              ? {
                  id: 'p1',
                  status: 'processing',
                  urls: { get: 'https://api.replicate.com/v1/predictions/p1' },
                }
              : { id: 'p1', status: 'succeeded', output: ['https://replicate.delivery/out.png'] },
          );
        },
      ],
      [/replicate\.delivery/, () => new Response(PNG)],
    ]);
  }

  it('sends the right input, waits, downloads the image and reports cost and license', async () => {
    const { impl, calls } = routes();
    const provider = createReplicateFluxProvider({
      token: 'r8_secret',
      fetchImpl: impl,
      sleep: noSleep,
    });
    const image = await expectProviderContract(provider);
    const create = calls[0]!;
    expect(create.init?.headers).toMatchObject({
      Authorization: 'Bearer r8_secret',
      Prefer: 'wait=60',
    });
    expect(JSON.parse(String(create.init?.body)).input).toMatchObject({
      prompt: 'a calm lake at dawn. No text.',
      aspect_ratio: '4:5',
      seed: 42,
      output_format: 'jpg',
      num_inference_steps: 4,
    });
    expect(image).toMatchObject({
      seed: 42,
      costUsd: FLUX_SCHNELL.costPerImageUsd,
      mimeType: 'image/jpeg',
      sourceUrl: 'https://replicate.com/p/p1',
    });
    expect(FLUX_SCHNELL.license).toMatch(/Apache-2\.0/);
  });

  it('asks for PNG for subjects and polls predictions that are still running', async () => {
    const { impl, calls } = routes('starting');
    const provider = createReplicateFluxProvider({ token: 't', fetchImpl: impl, sleep: noSleep });
    const image = await provider.generate(request({ kind: 'subject', width: 600, height: 600 }));
    expect(image.mimeType).toBe('image/png');
    expect(JSON.parse(String(calls[0]!.init?.body)).input).toMatchObject({
      aspect_ratio: '1:1',
      output_format: 'png',
    });
    expect(calls.filter((c) => c.url.endsWith('/predictions/p1'))).toHaveLength(2);
  });

  it('retries rate limits and never puts the token in error messages', async () => {
    let attempts = 0;
    const { impl } = fakeFetch([
      [
        /predictions$/,
        () =>
          ++attempts < 3
            ? new Response('slow down', { status: 429 })
            : new Response('bad input', { status: 422 }),
      ],
    ]);
    const provider = createReplicateFluxProvider({
      token: 'r8_secret',
      fetchImpl: impl,
      sleep: noSleep,
    });
    const error = await provider.generate(request()).catch((e: Error) => e);
    expect(attempts).toBe(3);
    expect(String(error)).toMatch(/HTTP 422/);
    expect(String(error)).not.toContain('r8_secret');
  });
});

describe('Pexels provider', () => {
  it('searches with orientation, picks a photo by seed and records attribution', async () => {
    const photos = [1, 2, 3].map((id) => ({
      id,
      width: 4000,
      height: 5000,
      url: `https://www.pexels.com/photo/${id}/`,
      photographer: `Photographer ${id}`,
      src: { original: '', large2x: `https://images.pexels.com/${id}.jpg`, large: '' },
    }));
    const { impl, calls } = fakeFetch([
      [/api\.pexels\.com/, () => Response.json({ photos })],
      [
        /images\.pexels\.com/,
        () => new Response(PNG, { headers: { 'content-type': 'image/jpeg' } }),
      ],
    ]);
    const provider = createPexelsProvider({ apiKey: 'pk', fetchImpl: impl });
    const image = await expectProviderContract(provider);
    expect(calls[0]!.url).toContain('query=calm%20lake%20dawn');
    expect(calls[0]!.url).toContain('orientation=portrait');
    expect(calls[0]!.init?.headers).toEqual({ Authorization: 'pk' });
    expect(image).toMatchObject({
      seed: null,
      costUsd: 0,
      attribution: 'Photo by Photographer 1 on Pexels',
      sourceUrl: 'https://www.pexels.com/photo/1/',
    }); // 42 % 3 = 0
  });
});
