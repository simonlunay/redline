import { describe, expect, it } from 'vitest';
import { imageUV } from '../../src/core/backdrop.js';
import { contrastRatio, parseHex } from '../../src/core/color.js';
import { textContrast } from '../../src/core/rules/text-contrast.js';
import type { ImageElement } from '../../src/core/schema.js';
import type { ImageSampler } from '../../src/core/types.js';
import { image, makeDesign, runRule, shape, text } from '../helpers.js';

/** An image that is black on its left half and light grey on its right half. */
const splitSampler: ImageSampler = {
  has: (src) => src === 'split.png',
  sample: (_src, u) => (u < 0.5 ? { r: 0, g: 0, b: 0, a: 1 } : { r: 220, g: 220, b: 220, a: 1 }),
};

describe('text-contrast', () => {
  it('passes dark text on a white canvas', () => {
    expect(runRule(textContrast, makeDesign([text({ color: '#222222' })]))).toEqual([]);
  });

  it('fails light grey normal text on white and suggests a passing color', () => {
    const design = makeDesign([text({ id: 't', color: '#aaaaaa', fontSize: 22 })]);
    const [issue] = runRule(textContrast, design);
    expect(issue).toMatchObject({ severity: 'error', threshold: 4.5, measured: 2.32 });
    const fix = issue!.fix![0]!;
    expect(fix.op).toBe('setColor');
    if (fix.op === 'setColor') {
      expect(contrastRatio(parseHex(fix.color), parseHex('#ffffff'))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('applies the 3:1 large-text threshold, scaled to the canvas', () => {
    // #888 on white is 3.54:1: fails as 22px normal text, passes as 48px large text.
    expect(runRule(textContrast, makeDesign([text({ color: '#888888', fontSize: 48 })]))).toEqual(
      [],
    );
    // 22px on a 540px canvas is like 44px on 1080, so it is large text too.
    const small = makeDesign([text({ color: '#888888', fontSize: 22, x: 10, y: 10, width: 400 })], {
      width: 540,
      height: 540,
    });
    expect(runRule(textContrast, small)).toEqual([]);
  });

  it('measures against the shape behind the text, not the canvas', () => {
    const design = makeDesign([
      shape({ x: 0, y: 0, width: 1080, height: 400, fill: '#1a1a1a' }),
      text({ id: 'on-dark', x: 100, y: 100, color: '#333333', zIndex: 1 }),
    ]);
    expect(runRule(textContrast, design)[0]!.elementIds).toEqual(['on-dark']);
  });

  it('ignores shapes painted above the text and respects shape opacity', () => {
    const above = makeDesign([
      text({ color: '#111111' }),
      shape({ x: 0, y: 0, width: 1080, height: 1080, fill: '#000000', zIndex: 5 }),
    ]);
    expect(runRule(textContrast, above)).toEqual([]);
    // A 10% black overlay barely changes white: dark text still passes.
    const faint = makeDesign([
      shape({ x: 0, y: 0, width: 1080, height: 1080, fill: '#000000', opacity: 0.1 }),
      text({ color: '#111111', zIndex: 1 }),
    ]);
    expect(runRule(textContrast, faint)).toEqual([]);
  });

  it('uses the worst sampled pixel when text crosses an image', () => {
    const design = makeDesign([
      image({
        id: 'photo',
        src: 'split.png',
        x: 0,
        y: 0,
        width: 1080,
        height: 1080,
        naturalWidth: 1080,
        naturalHeight: 1080,
      }),
      // Centered white text spans both the black and the light grey half.
      text({
        id: 'h',
        content: 'Summer sale',
        x: 240,
        y: 500,
        width: 600,
        color: '#ffffff',
        align: 'center',
        zIndex: 1,
      }),
    ]);
    const [issue] = runRule(textContrast, design, {}, { sampler: splitSampler });
    expect(issue).toMatchObject({ severity: 'error', elementIds: ['h'] });
    expect(issue!.measured).toBeLessThan(1.5); // white on #dcdcdc
  });

  it('warns that contrast could not be verified when there is no sampler', () => {
    const design = makeDesign([
      image({
        id: 'photo',
        x: 0,
        y: 0,
        width: 1080,
        height: 1080,
        naturalWidth: 1080,
        naturalHeight: 1080,
      }),
      text({ id: 'h', color: '#ffffff', zIndex: 1 }),
    ]);
    expect(runRule(textContrast, design)[0]).toMatchObject({
      severity: 'warning',
      elementIds: ['h', 'photo'],
      measured: 'unknown',
    });
  });

  it('skips logos and decorative text', () => {
    const design = makeDesign([
      text({ role: 'logo', color: '#fefefe' }),
      text({ role: 'decoration', color: '#fefefe' }),
    ]);
    expect(runRule(textContrast, design)).toEqual([]);
  });
});

describe('imageUV', () => {
  const base = makeDesign([
    image({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      naturalWidth: 100,
      naturalHeight: 100,
      fit: 'contain',
    }),
  ]).elements[0] as ImageElement;

  it('maps contain images and returns null in the letterbox area', () => {
    expect(imageUV(base, { x: 100, y: 50 })).toEqual({ u: 0.5, v: 0.5 });
    expect(imageUV(base, { x: 10, y: 50 })).toBeNull();
  });

  it('maps cover images (cropped)', () => {
    const cover = { ...base, fit: 'cover' as const };
    expect(imageUV(cover, { x: 0, y: 50 })).toEqual({ u: 0, v: 0.5 });
  });
});
