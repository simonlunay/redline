import { createFontMeasurer } from '@simonlunay/redline/node';
import type { TextMeasurer } from '@simonlunay/redline';
import { describe, expect, it } from 'vitest';
import { FONT_PROBES, PROBE_TOLERANCE_PX, checkDesignFonts } from '../src/lib/env/font-check';

const loaded = () => true;

describe('design-font check', () => {
  it("pins the probes to the CLI's own measurements", () => {
    const cli = createFontMeasurer();
    for (const p of FONT_PROBES) {
      const width = cli.measure(p.text, { family: 'Inter', size: p.size, weight: p.weight });
      expect(Math.abs(width - p.width), p.text).toBeLessThanOrEqual(0.005);
    }
    expect(checkDesignFonts(cli, loaded)).toEqual({ ok: true, problems: [] });
  });

  it('flags a browser that hints glyphs to whole pixels (the Linux CI failure)', () => {
    const cli = createFontMeasurer();
    // Hinting rounds each glyph's advance: approximate it per character.
    const hinted: TextMeasurer = {
      measure: (text, font) =>
        [...text].reduce((sum, ch) => sum + Math.round(cli.measure(ch, font)), 0),
    };
    const result = checkDesignFonts(hinted, loaded);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/Start free trial/);
  });

  it('flags a fallback font and a weight that did not load', () => {
    const fallback: TextMeasurer = { measure: (text, font) => text.length * font.size * 0.5 };
    expect(checkDesignFonts(fallback, loaded).ok).toBe(false);
    const result = checkDesignFonts(createFontMeasurer(), (css) => !css.startsWith('900'));
    expect(result.problems).toEqual(["Inter 900 didn't load."]);
  });

  it('keeps the tolerance far below what hinting changes', () => {
    // On Linux Chromium, hinting moved these probes by 0.6 to 2.3 px.
    expect(PROBE_TOLERANCE_PX).toBeLessThan(0.6 / 10);
  });
});
