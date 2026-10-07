import { describe, expect, it } from 'vitest';
import {
  cachedSaliencyModel,
  createFakeSaliencyModel,
  hashRaster,
  normalizeSaliency,
} from '../src/core/attention/saliency.js';
import type { SaliencyMap } from '../src/core/attention/saliency.js';
import { analyzeAttention } from '../src/core/attention/shares.js';
import { check, checkAsync } from '../src/core/check.js';
import { attentionRules, builtinRules } from '../src/core/rules/index.js';
import { attentionScale } from '../src/core/rules/attention-key-elements.js';
import type { RasterImage } from '../src/core/types.js';
import { image, makeDesign, shape, text } from './helpers.js';

/** A uniform 10x10 map: every cell holds 1% of the attention. */
const uniform: SaliencyMap = normalizeSaliency({
  width: 10,
  height: 10,
  data: new Float32Array(100).fill(1),
});

const raster = (width: number, height: number): RasterImage => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
});
const render = async (d: { canvas: { width: number; height: number } }) =>
  raster(d.canvas.width, d.canvas.height);

/** Gaussian blob centered at (cx, cy) in 0..1 canvas coordinates. */
const blob =
  (cx: number, cy: number, sigma = 0.08) =>
  (x: number, y: number) =>
    Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2)) + 1e-4;

describe('analyzeAttention', () => {
  const design = makeDesign(
    [
      image({
        id: 'bg',
        role: 'background',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        naturalWidth: 100,
        naturalHeight: 100,
      }),
      shape({ id: 'btn', role: 'cta', x: 0, y: 0, width: 50, height: 100, zIndex: 1 }),
      text({ id: 'label', role: 'cta', x: 0, y: 0, width: 50, height: 50, zIndex: 2 }),
      shape({ id: 'hidden', x: 50, y: 0, width: 50, height: 100, opacity: 0, zIndex: 3 }),
    ],
    { width: 100, height: 100 },
  );

  it('gives each cell to the top-most visible element and sums roles', () => {
    const a = analyzeAttention(design, uniform);
    expect(a.elementShares.label).toBeCloseTo(0.25); // top-left quarter, label on top
    expect(a.elementShares.btn).toBeCloseTo(0.25); // rest of the left half
    expect(a.elementShares.hidden).toBeUndefined(); // opacity 0 never wins
    expect(a.roleShares.cta).toBeCloseTo(0.5); // button + label together
    expect(a.backgroundShare).toBeCloseTo(0.5); // background-role image counts as background
  });

  it('buckets background attention into a 4x4 grid of named regions', () => {
    const a = analyzeAttention(design, uniform);
    expect(a.backgroundRegions).toHaveLength(16);
    expect(a.backgroundRegions.reduce((s, r) => s + r.share, 0)).toBeCloseTo(0.5);
    expect(a.backgroundRegions.find((r) => r.name === 'top-left')!.share).toBe(0);
    expect(a.backgroundRegions.find((r) => r.name === 'top-right')!.share).toBeGreaterThan(0);
  });

  it('orders key roles by peak attention (first fixation proxy)', async () => {
    const d = makeDesign(
      [
        text({ id: 'h', role: 'headline', x: 0, y: 0, width: 1080, height: 200 }),
        shape({ id: 'c', role: 'cta', x: 400, y: 800, width: 280, height: 100 }),
      ],
      {},
    );
    const map = await createFakeSaliencyModel(blob(0.5, 0.8)).predict(raster(1080, 1080));
    expect(analyzeAttention(d, map).viewingOrder).toEqual(['cta', 'headline']);
  });
});

describe('saliency model helpers', () => {
  it('normalizes to sum 1 and caches predictions by pixels', async () => {
    let calls = 0;
    const base = createFakeSaliencyModel(() => 1);
    const counting = { id: 'c', predict: (img: RasterImage) => (calls++, base.predict(img)) };
    const model = cachedSaliencyModel(counting, 2);
    const a = raster(20, 20);
    const b = raster(20, 20);
    b.data[0] = 255;
    const map = await model.predict(a);
    expect(map.data.reduce((s, v) => s + v, 0)).toBeCloseTo(1);
    await model.predict(raster(20, 20)); // same pixels -> hit
    await model.predict(b); // different pixels -> miss
    expect(model.stats).toEqual({ hits: 1, misses: 2 });
    expect(calls).toBe(2);
    expect(hashRaster(a)).not.toBe(hashRaster(b));
  });

  it('does not cache failed predictions', async () => {
    let fail = true;
    const model = cachedSaliencyModel({
      id: 'flaky',
      predict: async () => {
        if (fail) throw new Error('boom');
        return uniform;
      },
    });
    await expect(model.predict(raster(4, 4))).rejects.toThrow('boom');
    fail = false;
    await expect(model.predict(raster(4, 4))).resolves.toBe(uniform);
  });
});

describe('attention rules', () => {
  // A small CTA at the bottom, a headline at the top, a loud decoration on the right.
  const ad = makeDesign([
    text({ id: 'headline', role: 'headline', x: 90, y: 90, width: 900, height: 150, fontSize: 96 }),
    shape({
      id: 'burst',
      role: 'decoration',
      kind: 'ellipse',
      x: 700,
      y: 400,
      width: 300,
      height: 300,
    }),
    shape({ id: 'cta-btn', role: 'cta', x: 90, y: 900, width: 160, height: 60 }),
    text({
      id: 'cta-label',
      role: 'cta',
      x: 100,
      y: 910,
      width: 140,
      height: 40,
      fontSize: 24,
      zIndex: 1,
    }),
  ]);
  const run = (fn: (x: number, y: number) => number) =>
    checkAsync(ad, {
      rules: attentionRules,
      render,
      saliency: createFakeSaliencyModel(fn),
    });

  it('flags a CTA that gets too little attention, with concrete numbers and grow fixes', async () => {
    const report = await run(blob(0.78, 0.5)); // eyes go to the burst
    const cta = report.issues.find(
      (i) => i.ruleId === 'attention-key-elements' && i.elementIds.includes('cta-btn'),
    )!;
    expect(cta.severity).toBe('error');
    expect(cta.message).toMatch(/^CTA gets [\d.]+% of predicted attention; minimum is 5%/);
    expect(cta.elementIds).toEqual(['cta-btn', 'cta-label']);
    const ops = cta.fix!.map((f) => `${f.op}:${'elementId' in f ? f.elementId : ''}`);
    expect(ops).toEqual([
      'move:cta-btn',
      'resize:cta-btn',
      'move:cta-label',
      'resize:cta-label',
      'setFontSize:cta-label',
    ]);
    expect(report.rules[0]!.details).toMatchObject({ viewingOrder: expect.any(Array) });
    expect(report.rules[0]!.elementScores!.burst).toBeGreaterThan(0.3);
  });

  it('flags a decoration that out-draws the headline and CTA', async () => {
    const report = await run(blob(0.78, 0.5));
    const burst = report.issues.find((i) => i.ruleId === 'attention-competition')!;
    expect(burst.elementIds).toEqual(['burst']);
    expect(burst.message).toMatch(
      /decoration "burst" gets \d+% of predicted attention, more than the headline \([\d.]+%\) and the CTA/,
    );
    expect(burst.fix![0]).toEqual({ op: 'setOpacity', elementId: 'burst', opacity: 0.5 });
  });

  it('flags a background hot spot and suggests a scrim behind all content', async () => {
    const report = await run(blob(0.1, 0.55, 0.06)); // empty area on the left
    const hot = report.issues.find(
      (i) => i.ruleId === 'attention-competition' && i.elementIds.length === 0,
    )!;
    expect(hot.message).toMatch(/background at the (upper|lower)-middle-left/);
    expect(hot.fix![0]).toMatchObject({
      op: 'insertShape',
      behindElementId: 'headline',
      opacity: 0.35,
    });
  });

  it('passes when the key elements get their share', async () => {
    const report = await run(
      (x, y) => blob(0.5, 0.153, 0.04)(x, y) + blob(0.157, 0.861, 0.02)(x, y),
    );
    expect(report.issues).toEqual([]);
  });

  it('only runs in checkAsync with a model; check() and builtin reports are unaffected', async () => {
    const sync = check(ad, { rules: [...builtinRules, ...attentionRules] });
    expect(sync.skipped!.map((s) => s.ruleId)).toEqual([
      'attention-key-elements',
      'attention-competition',
    ]);
    const noModel = await checkAsync(ad, { rules: attentionRules, render });
    expect(noModel.skipped).toHaveLength(2);
    expect(check(ad).skipped).toBeUndefined();
  });

  it('scales a fix with how far below the minimum the share is, within 1.1-1.4x', () => {
    expect(attentionScale(0.09, 0.1)).toBe(1.1);
    expect(attentionScale(0.05, 0.1)).toBe(1.4);
    expect(attentionScale(0.08, 0.1)).toBe(1.12);
  });
});
