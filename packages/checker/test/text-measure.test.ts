import { describe, expect, it } from 'vitest';
import { heuristicMeasurer, wrapText } from '../src/core/text-measure.js';
import type { TextMeasurer } from '../src/core/text-measure.js';

// Every character is exactly 10px wide, which makes wrapping easy to reason about.
const mono: TextMeasurer = { measure: (t) => t.length * 10 };
const font = { family: 'Inter', size: 20, weight: 400 };

describe('wrapText', () => {
  it('wraps greedily at word boundaries', () => {
    expect(wrapText('aaa bbb ccc', 70, font, mono)).toEqual(['aaa bbb', 'ccc']);
  });

  it('keeps explicit line breaks and empty lines', () => {
    expect(wrapText('a\n\nb', 100, font, mono)).toEqual(['a', '', 'b']);
  });

  it('puts an over-long word on its own line', () => {
    expect(wrapText('hi supercalifragilistic yo', 50, font, mono)).toEqual([
      'hi',
      'supercalifragilistic',
      'yo',
    ]);
  });
});

describe('heuristicMeasurer', () => {
  it('scales with font size and weight', () => {
    const w1 = heuristicMeasurer.measure('Hello', font);
    expect(heuristicMeasurer.measure('Hello', { ...font, size: 40 })).toBeCloseTo(w1 * 2);
    expect(heuristicMeasurer.measure('Hello', { ...font, weight: 800 })).toBeGreaterThan(w1);
  });
});
