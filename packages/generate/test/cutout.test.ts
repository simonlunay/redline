import { describe, expect, it } from 'vitest';
import type { BackgroundRemover, Cutout } from '../src/cutout.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  BIREFNET_SESSION_OPTIONS,
  REPLICATE_BIREFNET,
  assessCutout,
  createAutoRemover,
  createBackdropKeyRemover,
  createReplicateBiRefNetRemover,
  cutOutWithQualityCheck,
  estimateBackdrop,
} from '../src/node/cutout.js';
import { createMockImageProvider } from '../src/node/mock-provider.js';
import { createReplicateClient } from '../src/providers/replicate-client.js';
import { BudgetExceededError, createMemoryLedger } from '../src/spend.js';
import { fakeFetch } from './helpers.js';

const GB = 1024 ** 3;

async function subjectPng() {
  const image = await createMockImageProvider().generate({
    prompt: 'a red ball',
    width: 200,
    height: 200,
    seed: 1,
    kind: 'subject',
  });
  return image.bytes;
}

function fakePrimary(): BackgroundRemover & { calls: number } {
  const fake = {
    id: 'fake-model',
    model: 'fake@1',
    license: 'test',
    calls: 0,
    async remove(): Promise<Cutout> {
      fake.calls++;
      return { png: new Uint8Array([1]), width: 1, height: 1, coverage: 0.5 };
    },
  };
  return fake;
}

describe('auto remover memory guard', () => {
  it('uses the model when enough memory is free and says so on the cutout', async () => {
    const primary = fakePrimary();
    const remover = createAutoRemover({ primary, freeMemory: () => 8 * GB, minFreeBytes: 2 * GB });
    const cut = await remover.remove(await subjectPng());
    expect(primary.calls).toBe(1);
    expect(cut.remover?.id).toBe('fake-model');
    expect(cut.fallbackReason).toBeUndefined();
  });

  it('falls back to the keyer for one cutout when memory is low, then recovers', async () => {
    const primary = fakePrimary();
    let free = 1 * GB;
    const reasons: string[] = [];
    const remover = createAutoRemover({
      primary,
      freeMemory: () => free,
      minFreeBytes: 2 * GB,
      onFallback: (r) => reasons.push(r),
    });
    const low = await remover.remove(await subjectPng());
    expect(primary.calls).toBe(0);
    expect(low.remover?.id).toBe('backdrop-key');
    expect(low.fallbackReason).toMatch(/1024 MB of memory free/);
    expect(reasons).toHaveLength(1);

    free = 8 * GB;
    const ok = await remover.remove(await subjectPng());
    expect(primary.calls).toBe(1);
    expect(ok.remover?.id).toBe('fake-model');
  });

  it('by default needs the ~6 GB inference peak plus a margin before running the model', async () => {
    const at = async (free: number) => {
      const primary = fakePrimary();
      const remover = createAutoRemover({ primary, freeMemory: () => free });
      return (await remover.remove(await subjectPng())).remover?.id;
    };
    expect(await at(7 * GB)).toBe('backdrop-key'); // what the eval machine had: not enough
    expect(await at(8 * GB)).toBe('fake-model');
  });

  it('stays on the keyer once the model has failed to load', async () => {
    const primary = fakePrimary();
    primary.remove = async () => {
      throw new Error('no onnxruntime');
    };
    const remover = createAutoRemover({ primary, freeMemory: () => 8 * GB });
    const first = await remover.remove(await subjectPng());
    const second = await remover.remove(await subjectPng());
    expect(first.fallbackReason).toBe('no onnxruntime');
    expect(second.remover?.id).toBe('backdrop-key');
  });

  it('uses the hosted remover instead of the keyer when memory is low', async () => {
    const primary = fakePrimary();
    const hosted = Object.assign(fakePrimary(), { id: 'hosted-model', model: 'hosted@1' });
    const used: string[] = [];
    const remover = createAutoRemover({
      primary,
      hosted,
      freeMemory: () => 1 * GB,
      minFreeBytes: 2 * GB,
      onFallback: (_reason, r) => used.push(r.id),
    });
    const cut = await remover.remove(await subjectPng());
    expect(primary.calls).toBe(0);
    expect(hosted.calls).toBe(1);
    expect(cut.remover?.id).toBe('hosted-model');
    expect(cut.fallbackReason).toMatch(/1024 MB of memory free/);
    expect(used).toEqual(['hosted-model']);
    expect(remover.model).toBe('fake@1 (fallback hosted@1, then backdrop-flood-key-v1)');
  });

  it('keeps local BiRefNet first when there is memory, even with a hosted remover', async () => {
    const primary = fakePrimary();
    const hosted = fakePrimary();
    const remover = createAutoRemover({ primary, hosted, freeMemory: () => 16 * GB });
    await remover.remove(await subjectPng());
    expect([primary.calls, hosted.calls]).toEqual([1, 0]);
  });

  it('falls back to the keyer when the hosted remover fails too, naming both reasons', async () => {
    const hosted = fakePrimary();
    hosted.remove = async () => {
      throw new Error('HTTP 502');
    };
    const remover = createAutoRemover({
      primary: fakePrimary(),
      hosted,
      freeMemory: () => 1 * GB,
      minFreeBytes: 2 * GB,
    });
    const cut = await remover.remove(await subjectPng());
    expect(cut.remover?.id).toBe('backdrop-key');
    expect(cut.fallbackReason).toMatch(/memory free.*; hosted cutout failed: HTTP 502/);
  });

  it('forceHosted skips the local model even with plenty of memory, without a warning', async () => {
    const primary = fakePrimary();
    const hosted = Object.assign(fakePrimary(), { id: 'hosted-model' });
    const reasons: string[] = [];
    const remover = createAutoRemover({
      primary,
      hosted,
      forceHosted: true,
      freeMemory: () => 64 * GB,
      onFallback: (r) => reasons.push(r),
    });
    const cut = await remover.remove(await subjectPng());
    expect(primary.calls).toBe(0);
    expect(cut.remover?.id).toBe('hosted-model');
    expect(cut.fallbackReason).toBeUndefined();
    expect(reasons).toEqual([]);
    expect(() => createAutoRemover({ forceHosted: true })).toThrow(/needs a hosted remover/);
  });

  it("doesn't keep ONNX Runtime's CPU arena (it holds the ~6 GB inference peak)", () => {
    expect(BIREFNET_SESSION_OPTIONS).toMatchObject({
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
  });
});

describe('quality-checked cutouts', () => {
  /** A studio shot: an orange disc on a plain light-grey backdrop. */
  async function studioShot() {
    const c = createCanvas(240, 240);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#d3d3d3';
    ctx.fillRect(0, 0, 240, 240);
    ctx.fillStyle = '#e8701a';
    ctx.beginPath();
    ctx.arc(120, 120, 80, 0, Math.PI * 2);
    ctx.fill();
    return new Uint8Array(await c.encode('png'));
  }

  it('keeps a good first cut and tries nothing else', async () => {
    const result = await cutOutWithQualityCheck(createBackdropKeyRemover(), await studioShot());
    expect(result.verdict.severity).toBe('ok');
    expect(result.recuts).toEqual([]);
  });

  it('re-cuts a damaged cut (here: nothing removed) and keeps the better one', async () => {
    const shot = await studioShot();
    // A "remover" that removes nothing: the whole photo stays opaque, an uncut subject.
    const lazy: BackgroundRemover = {
      id: 'lazy',
      model: 'lazy@1',
      license: 'test',
      remove: async (bytes) => ({ png: bytes, width: 240, height: 240, coverage: 1 }),
    };
    const result = await cutOutWithQualityCheck(lazy, shot);
    expect(result.recuts.length).toBe(2);
    expect(result.kept).toMatch(/^backdrop-key:/);
    expect(result.verdict.severity).toBe('ok');
    expect(result.cut.remover?.id).toBe('backdrop-key');
    expect((await assessCutout(result.cut.png, await estimateBackdrop(shot))).severity).toBe('ok');
  });

  it('estimates the backdrop from the border', async () => {
    expect(await estimateBackdrop(await studioShot())).toEqual([211, 211, 211]);
  });
});

describe('hosted BiRefNet (Replicate)', () => {
  /** What the model returns: the subject in RGBA, a disc (r 40) on transparency. */
  async function modelOutput(width = 300, height = 200) {
    const c = createCanvas(width, height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e8701a';
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, (40 * width) / 300, 0, Math.PI * 2);
    ctx.fill();
    return new Uint8Array(await c.encode('png'));
  }

  async function studioPhoto(width = 300, height = 200) {
    const c = createCanvas(width, height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#d3d3d3';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#e8701a';
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, (40 * width) / 300, 0, Math.PI * 2);
    ctx.fill();
    return new Uint8Array(await c.encode('png'));
  }

  function replicate(opts: { output?: Uint8Array; predictTime?: number; fail?: boolean } = {}) {
    return fakeFetch([
      [
        /\/v1\/files$/,
        () => Response.json({ id: 'f1', urls: { get: 'https://api.replicate.com/v1/files/f1' } }),
      ],
      [/\/v1\/files\/f1$/, () => new Response(null, { status: 204 })],
      [
        /\/v1\/predictions$/,
        () =>
          opts.fail
            ? Response.json({ id: 'p9', status: 'failed', error: 'CUDA out of memory' })
            : Response.json({
                id: 'p9',
                status: 'succeeded',
                output: 'https://replicate.delivery/cut.png',
                ...(opts.predictTime === undefined
                  ? {}
                  : { metrics: { predict_time: opts.predictTime } }),
              }),
      ],
      [
        /replicate\.delivery\/cut\.png$/,
        async () => new Response(opts.output ?? (await modelOutput())),
      ],
    ]);
  }

  const client = (impl: typeof fetch) =>
    createReplicateClient({ token: 'r8_secret', fetchImpl: impl, sleep: async () => {} });

  it('uploads the subject, runs the pinned version, deletes the upload and trims the cut', async () => {
    const { impl, calls } = replicate({ predictTime: 0.8 });
    const ledger = createMemoryLedger(1);
    const remover = createReplicateBiRefNetRemover({ client: client(impl), ledger });
    const cut = await remover.remove(await studioPhoto());

    const upload = calls.find((c) => c.url.endsWith('/v1/files'))!;
    expect(upload.init?.method).toBe('POST');
    expect(upload.init?.body).toBeInstanceOf(FormData);
    const create = calls.find((c) => c.url.endsWith('/v1/predictions'))!;
    expect(JSON.parse(String(create.init?.body))).toEqual({
      version: REPLICATE_BIREFNET.version,
      input: { image: 'https://api.replicate.com/v1/files/f1' },
    });
    expect(String(create.init?.body)).not.toContain('r8_secret');
    expect(calls.some((c) => c.url.endsWith('/files/f1') && c.init?.method === 'DELETE')).toBe(
      true,
    );

    // Trimmed to the disc (80x80) plus the 1% margin.
    expect(cut.width).toBeGreaterThanOrEqual(80);
    expect(cut.width).toBeLessThanOrEqual(84);
    expect(cut.height).toBe(cut.width);
    expect(Math.abs(cut.coverage - (Math.PI * 40 ** 2) / 60_000)).toBeLessThan(0.005);
    const png = await loadImage(Buffer.from(cut.png));
    expect([png.width, png.height]).toEqual([cut.width, cut.height]);

    expect(ledger.entries()).toMatchObject([
      { kind: 'image', model: REPLICATE_BIREFNET.model, costUsd: 0.00112 },
    ]);
    expect(remover.license).toMatch(/^MIT/);
  });

  it('uses the model alpha even when the output comes back at another size', async () => {
    const { impl } = replicate({ output: await modelOutput(150, 100), predictTime: 0.5 });
    const cut = await createReplicateBiRefNetRemover({ client: client(impl) }).remove(
      await studioPhoto(),
    );
    expect(cut.width).toBeGreaterThanOrEqual(78);
    expect(cut.width).toBeLessThanOrEqual(86);
  });

  it('charges the reserved estimate when the prediction has no metrics', async () => {
    const { impl } = replicate();
    const ledger = createMemoryLedger(1);
    await createReplicateBiRefNetRemover({ client: client(impl), ledger }).remove(
      await studioPhoto(),
    );
    expect(ledger.entries()[0]!.costUsd).toBe(REPLICATE_BIREFNET.estimateUsd);
  });

  it('is refused by the spend guard before any request is made', async () => {
    const { impl, calls } = replicate();
    const ledger = createMemoryLedger(0.005);
    const remover = createReplicateBiRefNetRemover({ client: client(impl), ledger });
    await expect(remover.remove(await studioPhoto())).rejects.toThrow(BudgetExceededError);
    expect(calls).toEqual([]);
  });

  it('deletes the upload and records nothing when the prediction fails', async () => {
    const { impl, calls } = replicate({ fail: true });
    const ledger = createMemoryLedger(1);
    const remover = createReplicateBiRefNetRemover({ client: client(impl), ledger });
    await expect(remover.remove(await studioPhoto())).rejects.toThrow(
      /prediction p9 failed: CUDA out of memory/,
    );
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(true);
    expect(ledger.entries()).toEqual([]);
  });

  it('measures as a clean cut under cutout-quality', async () => {
    const { impl } = replicate({ predictTime: 0.5 });
    const photo = await studioPhoto();
    const cut = await createReplicateBiRefNetRemover({ client: client(impl) }).remove(photo);
    expect((await assessCutout(cut.png, await estimateBackdrop(photo))).severity).toBe('ok');
  });
});
