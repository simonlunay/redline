import { describe, expect, it } from 'vitest';
import { minTextSize } from '../../src/core/rules/min-text-size.js';
import { makeDesign, runRule, text } from '../helpers.js';

describe('min-text-size', () => {
  it('passes for readable text on a 1080 post (min 21.6px)', () => {
    expect(runRule(minTextSize, makeDesign([text({ fontSize: 24 })]))).toEqual([]);
  });

  it('warns for small text and errors for tiny text', () => {
    const design = makeDesign([
      text({ id: 'small', fontSize: 18 }),
      text({ id: 'tiny', fontSize: 12 }),
    ]);
    const issues = runRule(minTextSize, design);
    expect(issues.map((i) => [i.elementIds[0], i.severity])).toEqual([
      ['small', 'warning'],
      ['tiny', 'error'],
    ]);
    expect(issues[0]!.fix).toEqual([{ op: 'setFontSize', elementId: 'small', fontSize: 22 }]);
  });

  it('scales the threshold with the canvas', () => {
    // 1200x628 banner: min is 12.56px, so 14px is fine there but not on a 1080 post.
    const banner = makeDesign([text({ fontSize: 14 })], { width: 1200, height: 628 });
    expect(runRule(minTextSize, banner)).toEqual([]);
    expect(runRule(minTextSize, makeDesign([text({ fontSize: 14 })]))).toHaveLength(1);
  });

  it('ignores empty text', () => {
    expect(runRule(minTextSize, makeDesign([text({ fontSize: 5, content: '  ' })]))).toEqual([]);
  });
});
