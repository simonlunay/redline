import { describe, expect, it } from 'vitest';
import { hierarchy, prominence } from '../../src/core/rules/hierarchy.js';
import { makeDesign, runRule, text } from '../helpers.js';

describe('hierarchy', () => {
  it('passes with a clearly dominant headline', () => {
    const design = makeDesign([
      text({ role: 'headline', fontSize: 96, fontWeight: 800 }),
      text({ role: 'subheading', fontSize: 40, fontWeight: 600 }),
      text({ role: 'body', fontSize: 28 }),
    ]);
    expect(runRule(hierarchy, design)).toEqual([]);
  });

  it('warns when a subheading competes and errors when body beats the headline', () => {
    const design = makeDesign([
      text({ id: 'h', role: 'headline', fontSize: 60, fontWeight: 700 }),
      text({ id: 'sub', role: 'subheading', fontSize: 56, fontWeight: 700 }),
      text({ id: 'body', role: 'body', fontSize: 72, fontWeight: 700 }),
    ]);
    const issues = runRule(hierarchy, design);
    expect(issues.map((i) => [i.elementIds[0], i.severity])).toEqual([
      ['sub', 'warning'],
      ['body', 'error'],
    ]);
    // Fix brings the competitor down to 70% of the headline's prominence.
    const fix = issues[0]!.fix![0]!;
    expect(fix.op).toBe('setFontSize');
    if (fix.op === 'setFontSize') {
      expect(prominence({ fontSize: fix.fontSize, fontWeight: 700 })).toBeLessThanOrEqual(
        prominence({ fontSize: 60, fontWeight: 700 }) * 0.7,
      );
    }
  });

  it('accounts for font weight, not just size', () => {
    const design = makeDesign([
      text({ role: 'headline', fontSize: 50, fontWeight: 400 }),
      text({ id: 'sub', role: 'subheading', fontSize: 44, fontWeight: 900 }),
    ]);
    expect(runRule(hierarchy, design)[0]).toMatchObject({
      elementIds: ['sub', expect.any(String)],
      severity: 'error',
    });
  });

  it('reports info when there is no headline or several', () => {
    expect(runRule(hierarchy, makeDesign([text(), text()]))[0]!.severity).toBe('info');
    const two = makeDesign([text({ role: 'headline' }), text({ role: 'headline' })]);
    expect(runRule(hierarchy, two)[0]!.message).toMatch(/2 elements are marked as headline/);
  });
});
