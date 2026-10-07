import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImage } from '@napi-rs/canvas';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { createFakeSaliencyModel } from '../src/core/attention/saliency.js';
import { heatColor, renderHeatmapPng } from '../src/node/heatmap.js';
import { createNodeEnv, loadDesign } from '../src/node/index.js';
import { ModelChecksumError, cacheDir, ensureModelFile } from '../src/node/saliency/model-file.js';
import {
  MSI_NET,
  createOnnxSaliencyModel,
  msiNetInputShape,
} from '../src/node/saliency/onnx-model.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

const payload = Buffer.from('pretend these are model weights');
const pinned = {
  fileName: 'model.onnx',
  url: 'https://example.invalid/model.onnx',
  bytes: payload.length,
  sha256: createHash('sha256').update(payload).digest('hex'),
};
const fakeFetch = (body: Buffer, counter = { calls: 0 }) =>
  (async () => {
    counter.calls++;
    return new Response(body);
  }) as unknown as typeof fetch;

describe('model file cache', () => {
  it('downloads once, verifies, and reuses the cached file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'redline-cache-'));
    const counter = { calls: 0 };
    const path = await ensureModelFile(pinned, { dir, fetchImpl: fakeFetch(payload, counter) });
    expect(path).toBe(join(dir, 'models', 'model.onnx'));
    await ensureModelFile(pinned, { dir, fetchImpl: fakeFetch(payload, counter) });
    expect(counter.calls).toBe(1);
  });

  it('rejects a download with the wrong checksum and leaves no partial files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'redline-cache-'));
    const tampered = Buffer.from('pretend these are model weightZ');
    await expect(
      ensureModelFile(pinned, { dir, fetchImpl: fakeFetch(tampered) }),
    ).rejects.toBeInstanceOf(ModelChecksumError);
    expect(readdirSync(join(dir, 'models'))).toEqual([]);
  });

  it('re-downloads a corrupted cached file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'redline-cache-'));
    const counter = { calls: 0 };
    const path = await ensureModelFile(pinned, { dir, fetchImpl: fakeFetch(payload, counter) });
    writeFileSync(path, 'corrupted');
    await ensureModelFile(pinned, { dir, fetchImpl: fakeFetch(payload, counter) });
    expect(counter.calls).toBe(2);
  });

  it('pins the MSI-Net release asset by size and SHA-256', () => {
    expect(MSI_NET.url).toMatch(
      /^https:\/\/github\.com\/simonlunay\/redline\/releases\/download\//,
    );
    expect(MSI_NET.bytes).toBe(50041285);
    expect(MSI_NET.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('MSI-Net preprocessing', () => {
  it('picks the trained input size closest to the design aspect ratio', () => {
    expect(msiNetInputShape(1080, 1080)).toEqual([320, 320]);
    expect(msiNetInputShape(1200, 628)).toEqual([240, 320]);
    expect(msiNetInputShape(1080, 1920)).toEqual([320, 240]);
    expect(msiNetInputShape(728, 90)).toEqual([240, 320]);
  });
});

describe('heatmap overlay', () => {
  it('is transparent when cold and opaque red when hot', () => {
    expect(heatColor(0)[3]).toBe(0);
    const [r, g, , a] = heatColor(1);
    expect([r, g]).toEqual([255, 0]);
    expect(a).toBeGreaterThan(150);
  });

  it('renders the design plus a header, with heat where the model looks', async () => {
    const loaded = await loadDesign(FIXTURES + 'clean-poster.json');
    const env = await createNodeEnv(loaded);
    // All attention in the top-left corner.
    const model = createFakeSaliencyModel((x, y) => (x < 0.1 && y < 0.1 ? 1 : 0));
    const map = await model.predict(await env.render(loaded.design));
    const png = await renderHeatmapPng(loaded.design, map, { images: env.images, modelId: 'fake' });
    const img = await loadImage(png);
    expect(img.width).toBe(1080);
    expect(img.height).toBeGreaterThan(1350); // header strip on top
    const ctx = createCanvas(img.width, img.height).getContext('2d');
    ctx.drawImage(img, 0, 0);
    const header = img.height - 1350;
    const [hr, hg, hb] = ctx.getImageData(20, header + 20, 1, 1).data;
    const [cr, cg, cb] = ctx.getImageData(900, header + 1300, 1, 1).data;
    expect(hr! - hb!).toBeGreaterThan(150); // hot corner is red/orange
    expect([cr, cg, cb]).toEqual([15, 23, 42]); // cold area shows the #0f172a background as-is
    expect(hg).toBeLessThan(200);
  });
});

// Runs the real model only if it is already downloaded, so CI never fetches 50 MB.
const cached = join(cacheDir(), 'models', MSI_NET.fileName);
describe.skipIf(!existsSync(cached))('MSI-Net (real model, cached)', () => {
  it('predicts a normalized map with the design aspect ratio', async () => {
    const loaded = await loadDesign(FIXTURES + 'clean-poster.json');
    const env = await createNodeEnv(loaded);
    const model = await createOnnxSaliencyModel();
    const map = await model.predict(await env.render(loaded.design));
    expect(map.width / map.height).toBeCloseTo(1080 / 1350, 1);
    expect(map.data.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 3);
  });
});
