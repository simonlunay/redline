import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { checkAsync } from '../src/core/check.js';
import { judgeCutout, measureCutout } from '../src/core/cutout-quality.js';
import { imageRectToCanvas } from '../src/core/image-analysis.js';
import type { ImageAnalysis } from '../src/core/image-analysis.js';
import { builtinRules, imageRules } from '../src/core/rules/index.js';
import { cutoutQuality } from '../src/core/rules/cutout-quality.js';
import { imageText } from '../src/core/rules/image-text.js';
import type { ImageElement } from '../src/core/schema.js';
import { DEFAULT_FAMILY, registerBundledFonts } from '../src/node/fonts.js';
import { createImageAnalyzer } from '../src/node/image-analysis/index.js';
import {
  PP_OCR_DET,
  PP_OCR_REC,
  createOnnxTextDetector,
  ctcRead,
  dbBoxes,
} from '../src/node/image-analysis/text-detector.js';
import { cacheDir } from '../src/node/saliency/model-file.js';
import { image, makeDesign, runRule, shape } from './helpers.js';

/** A synthetic cutout: RGBA where `inside(x, y)` gives the subject's alpha and color. */
function cutout(
  size: number,
  pixel: (x: number, y: number) => [number, number, number, number] | null,
) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = pixel(x, y);
      if (p) data.set(p, (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

const S = 200;
const inDisc = (x: number, y: number, r = 70) => (x - 100) ** 2 + (y - 100) ** 2 <= r * r;
/** A textured orange disc: a clean cutout. */
const disc = (x: number, y: number): [number, number, number, number] | null =>
  inDisc(x, y) ? [230, 120 + ((x * 7 + y * 3) % 40), 40, 255] : null;

describe('cutout quality', () => {
  it('passes a clean cutout', () => {
    const v = judgeCutout(measureCutout(cutout(S, disc)));
    expect(v.severity).toBe('ok');
    expect(v.metrics.bites).toBeLessThan(0.02);
    expect(v.metrics.fragments).toBe(0);
    expect(v.metrics.sidesTouched).toBe(0);
  });

  it('flags tears bitten out of the outline', () => {
    // Eight narrow tears (5 px wide, 35 px deep) across the top of the disc, like a keyed edge.
    const torn = cutout(S, (x, y) =>
      y < 65 && x >= 50 && x < 150 && (x - 50) % 12 < 5 ? null : disc(x, y),
    );
    const v = judgeCutout(measureCutout(torn));
    expect(v.problems.map((p) => p.kind)).toContain('bites');
    expect(v.severity).toBe('error');
  });

  it('flags stray fragments, as an error once there are two', () => {
    const one = cutout(S, (x, y) =>
      x >= 180 && x < 186 && y >= 10 && y < 16 ? [200, 200, 200, 255] : disc(x, y),
    );
    const two = cutout(S, (x, y) =>
      (x >= 180 && x < 186 && y >= 10 && y < 16) || (x >= 10 && x < 16 && y >= 180 && y < 186)
        ? [200, 200, 200, 255]
        : disc(x, y),
    );
    expect(judgeCutout(measureCutout(one)).severity).toBe('warning');
    const v = judgeCutout(measureCutout(two));
    expect(v.metrics.fragmentCount).toBe(2);
    expect(v.severity).toBe('error');
  });

  it('flags a subject that was never cut out', () => {
    const uncut = cutout(S, () => [180, 180, 180, 255]);
    const v = judgeCutout(measureCutout(uncut));
    expect(v.metrics.sidesTouched).toBe(4);
    expect(v.problems.map((p) => p.kind)).toContain('uncut');
    expect(v.severity).toBe('error');
  });

  it('flags a see-through interior', () => {
    const glass = cutout(S, (x, y) => {
      const p = disc(x, y);
      return p && inDisc(x, y, 50) ? [p[0], p[1], p[2], 140] : p;
    });
    const v = judgeCutout(measureCutout(glass));
    expect(v.metrics.seeThrough).toBeGreaterThan(0.3);
    expect(v.severity).toBe('error');
  });

  it('treats flat backdrop left in as a warning alone, an error with another sign of damage', () => {
    const backdrop: [number, number, number] = [211, 211, 211];
    const slab = (x: number, y: number) => y >= 150 && y < 190 && x >= 20 && x < 180;
    const withSlab = cutout(S, (x, y) => (slab(x, y) ? [211, 211, 211, 255] : disc(x, y)));
    const alone = judgeCutout(measureCutout(withSlab, backdrop));
    expect(alone.metrics.leftoverBackdrop).toBeGreaterThan(0.2);
    expect(alone.severity).toBe('warning');
    const withFragment = cutout(S, (x, y) =>
      slab(x, y) || (x >= 185 && x < 191 && y >= 5 && y < 11) ? [211, 211, 211, 255] : disc(x, y),
    );
    expect(judgeCutout(measureCutout(withFragment, backdrop)).severity).toBe('error');
  });
});

describe('image rect mapping', () => {
  const el = (fit: 'fill' | 'cover' | 'contain') =>
    makeDesign([
      image({
        id: 'bg',
        x: 0,
        y: 0,
        width: 1000,
        height: 500,
        naturalWidth: 1000,
        naturalHeight: 1000,
        fit,
      }),
    ]).elements[0] as ImageElement;

  it('maps normalized image rects to canvas px through fill, cover and contain', () => {
    const r = { x: 0.25, y: 0.5, width: 0.5, height: 0.1 };
    expect(imageRectToCanvas(el('fill'), r)).toEqual({ x: 250, y: 250, width: 500, height: 50 });
    // cover: 1000x1000 drawn at 1000x1000, centered: y offset -250.
    expect(imageRectToCanvas(el('cover'), r)).toEqual({ x: 250, y: 250, width: 500, height: 100 });
    // contain: drawn at 500x500, x offset 250.
    expect(imageRectToCanvas(el('contain'), r)).toEqual({ x: 375, y: 250, width: 250, height: 50 });
    // Cropped away by cover: nothing visible.
    expect(imageRectToCanvas(el('cover'), { x: 0, y: 0, width: 1, height: 0.2 })).toBeNull();
  });
});

describe('image rules', () => {
  const textAt = (origin: ImageAnalysis['origin']): ImageAnalysis => ({
    origin,
    text: [
      { x: 0.3, y: 0.85, width: 0.3, height: 0.04, score: 0.99, chars: 21, readConfidence: 0.98 },
    ],
  });
  const design = (extra: Parameters<typeof makeDesign>[0] = []) =>
    makeDesign([
      image({
        id: 'bg',
        src: 'bg.jpg',
        x: 0,
        y: 0,
        width: 1080,
        height: 1080,
        naturalWidth: 1080,
        naturalHeight: 1080,
        fit: 'cover',
      }),
      ...extra,
    ]);
  const source = (map: Record<string, ImageAnalysis>) => ({ get: (src: string) => map[src] });

  it('image-text: an error for generated images, a warning for user images', () => {
    const gen = runRule(
      imageText,
      design(),
      {},
      { images: source({ 'bg.jpg': textAt('generated') }) },
    );
    expect(gen).toHaveLength(1);
    expect(gen[0]).toMatchObject({ severity: 'error', elementIds: ['bg'], measured: 1 });
    expect(gen[0]!.message).toMatch(/regenerate this image .*no text, no lettering/);
    const user = runRule(imageText, design(), {}, { images: source({ 'bg.jpg': textAt('user') }) });
    expect(user[0]).toMatchObject({ severity: 'warning' });
  });

  it('image-text: ignores text hidden under an opaque panel, tiny marks and low confidence', () => {
    const panel = shape({
      id: 'panel',
      x: 0,
      y: 900,
      width: 1080,
      height: 100,
      fill: '#000000',
      zIndex: 2,
    });
    expect(
      runRule(
        imageText,
        design([panel]),
        {},
        { images: source({ 'bg.jpg': textAt('generated') }) },
      ),
    ).toHaveLength(0);
    const tiny: ImageAnalysis = {
      origin: 'generated',
      text: [{ x: 0.1, y: 0.1, width: 0.05, height: 0.005, score: 0.99 }],
    };
    expect(runRule(imageText, design(), {}, { images: source({ 'bg.jpg': tiny }) })).toHaveLength(
      0,
    );
    const unsure: ImageAnalysis = {
      origin: 'generated',
      text: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.05, score: 0.4 }],
    };
    expect(runRule(imageText, design(), {}, { images: source({ 'bg.jpg': unsure }) })).toHaveLength(
      0,
    );
  });

  it('cutout-quality reports the verdict with every problem described', () => {
    const verdict = judgeCutout(measureCutout(cutout(S, () => [180, 180, 180, 255])));
    const issues = runRule(
      cutoutQuality,
      design(),
      {},
      {
        images: source({ 'bg.jpg': { origin: 'generated', cutout: verdict } }),
      },
    );
    expect(issues[0]).toMatchObject({ severity: 'error', elementIds: ['bg'], unit: 'uncut' });
    expect(issues[0]!.message).toMatch(/not cut out.*Re-cut it with BiRefNet, or regenerate/);
  });

  it('is skipped without image analysis and runs with it', async () => {
    const without = await checkAsync(design(), { rules: [...builtinRules, ...imageRules] });
    expect(without.skipped?.map((s) => s.ruleId)).toEqual(['image-text', 'cutout-quality']);
    const withIt = await checkAsync(design(), {
      rules: [...builtinRules, ...imageRules],
      images: source({ 'bg.jpg': textAt('generated') }),
    });
    expect(withIt.issues.map((i) => i.ruleId)).toContain('image-text');
    expect(withIt.passed).toBe(false);
  });
});

describe('text detector post-processing', () => {
  it('dbBoxes: thresholded components, scored, grown by the unclip offset, normalized', () => {
    const w = 40;
    const h = 20;
    const prob = new Float32Array(w * h);
    for (let y = 8; y < 12; y++) for (let x = 5; x < 25; x++) prob[y * w + x] = 0.9;
    prob[2 * w + 35] = 0.95; // a single pixel: too small
    const boxes = dbBoxes(prob, w, h);
    expect(boxes).toHaveLength(1);
    const b = boxes[0]!;
    expect(b.score).toBeCloseTo(0.9, 5);
    // 20x4 box, unclip d = 80 * 1.5 / 48 = 2.5 px on each side.
    expect(b.x * w).toBeCloseTo(2.5, 5);
    expect(b.width * w).toBeCloseTo(25, 5);
    expect(b.height * h).toBeCloseTo(9, 5);
  });

  it('ctcRead: counts non-blank steps after collapsing repeats', () => {
    // 6 steps over 3 classes (0 = blank): a a _ b _ b -> "abb" = 3 chars.
    const seq = [1, 1, 0, 2, 0, 2];
    const probs = new Float32Array(
      seq.flatMap((k) => [0, 1, 2].map((c) => (c === k ? 0.9 : 0.05))),
    );
    expect(ctcRead(probs, 6, 3)).toEqual({ chars: 3, confidence: expect.closeTo(0.9, 5) });
    expect(
      ctcRead(
        new Float32Array(6 * 3).fill(0).map((_, i) => (i % 3 === 0 ? 1 : 0)),
        6,
        3,
      ).chars,
    ).toBe(0);
  });
});

const modelsCached =
  existsSync(join(cacheDir(), 'models', PP_OCR_DET.fileName)) &&
  existsSync(join(cacheDir(), 'models', PP_OCR_REC.fileName));

describe.skipIf(!modelsCached)('PP-OCRv5 text detector (real models, cached)', () => {
  function photo(withText: boolean) {
    registerBundledFonts();
    const c = createCanvas(900, 600);
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 600);
    g.addColorStop(0, '#d9cbe0');
    g.addColorStop(1, '#6f6a80');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 900, 600);
    if (withText) {
      ctx.fillStyle = '#5a5566';
      ctx.beginPath();
      ctx.roundRect(260, 440, 380, 70, 35);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `600 34px ${DEFAULT_FAMILY}`;
      ctx.fillText("Fore tob'x cort terte", 290, 487);
    }
    const id = ctx.getImageData(0, 0, 900, 600);
    return { width: 900, height: 600, data: id.data };
  }

  it('finds gibberish lettering drawn into an image and nothing in a plain one', async () => {
    const detector = await createOnnxTextDetector();
    const found = await detector.detect(photo(true));
    expect(found.length).toBeGreaterThanOrEqual(1);
    const box = found[0]!;
    expect(box.y * 600).toBeGreaterThan(420);
    expect(box.chars).toBeGreaterThanOrEqual(10);
    expect(await detector.detect(photo(false))).toEqual([]);
  }, 30_000);
});

describe('image analyzer', () => {
  it('the analyzer caches per src and measures cutouts only for images with transparency', async () => {
    const analyzer = createImageAnalyzer({ detector: null });
    const c = createCanvas(S, S);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff8800';
    ctx.beginPath();
    ctx.arc(100, 100, 70, 0, Math.PI * 2);
    ctx.fill();
    const { loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(await c.encode('png'));
    const a = await analyzer.analyze('subject.png', img, { origin: 'generated' });
    expect(a.cutout?.severity).toBe('ok');
    expect(a.text).toBeUndefined();
    expect(await analyzer.analyze('subject.png', img, { origin: 'generated' })).toBe(a);
    expect(analyzer.get('subject.png')).toBe(a);
  });
});
