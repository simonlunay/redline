import { describe, expect, it } from 'vitest';
import {
  blend,
  contrastRatio,
  minContrast,
  nearestPassingColor,
  parseHex,
  toHex,
} from '../src/core/color.js';
import {
  elementContainsPoint,
  gridPoints,
  intersection,
  rotatedBounds,
} from '../src/core/geometry.js';
import { makeDesign, shape } from './helpers.js';

describe('color', () => {
  it('parses short, long and alpha hex', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseHex('#00000080').a).toBeCloseTo(0.5, 2);
    expect(toHex({ r: 255, g: 0, b: 16 })).toBe('#ff0010');
  });

  it('computes WCAG contrast ratios matching the spec examples', () => {
    expect(contrastRatio(parseHex('#000'), parseHex('#fff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseHex('#777777'), parseHex('#ffffff'))).toBeCloseTo(4.48, 2);
    expect(contrastRatio(parseHex('#123456'), parseHex('#123456'))).toBe(1);
  });

  it('blends with alpha', () => {
    expect(blend({ r: 0, g: 0, b: 0 }, 0.5, { r: 255, g: 255, b: 255 })).toEqual({
      r: 127.5,
      g: 127.5,
      b: 127.5,
    });
  });

  it('suggests the closest passing color while keeping the hue', () => {
    const bg = [parseHex('#ffffff')];
    const fixed = nearestPassingColor(parseHex('#88aaff'), bg, 4.5);
    expect(minContrast(parseHex(fixed), bg)).toBeGreaterThanOrEqual(4.5);
    const { r, g, b } = parseHex(fixed);
    expect(b).toBeGreaterThan(r); // still blue-ish
    expect(b).toBeGreaterThan(g);
  });
});

describe('geometry', () => {
  it('intersects rects', () => {
    expect(
      intersection({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }),
    ).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(
      intersection({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 }),
    ).toBeNull();
  });

  it('computes rotated bounds', () => {
    const b = rotatedBounds({ x: 0, y: 0, width: 100, height: 100, rotation: 45 });
    expect(b.width).toBeCloseTo(141.42, 1);
    expect(b.x).toBeCloseTo(-20.71, 1);
  });

  it('hit tests ellipses', () => {
    const [el] = makeDesign([
      shape({ kind: 'ellipse', x: 0, y: 0, width: 100, height: 100 }),
    ]).elements;
    expect(elementContainsPoint(el!, { x: 50, y: 50 })).toBe(true);
    expect(elementContainsPoint(el!, { x: 2, y: 2 })).toBe(false);
  });

  it('creates grid sample points at cell centers', () => {
    expect(gridPoints({ x: 0, y: 0, width: 100, height: 10 }, 2, 1)).toEqual([
      { x: 25, y: 5 },
      { x: 75, y: 5 },
    ]);
  });
});
