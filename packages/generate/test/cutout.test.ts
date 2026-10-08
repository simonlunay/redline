import { describe, expect, it } from 'vitest';
import type { BackgroundRemover, Cutout } from '../src/cutout.js';
import { createCanvas } from '@napi-rs/canvas';
import {
  BIREFNET_SESSION_OPTIONS,
  assessCutout,
  createAutoRemover,
  createBackdropKeyRemover,
  cutOutWithQualityCheck,
  estimateBackdrop,
} from '../src/node/cutout.js';
import { createMockImageProvider } from '../src/node/mock-provider.js';

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
