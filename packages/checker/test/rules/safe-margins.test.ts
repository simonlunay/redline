import { describe, expect, it } from 'vitest';
import { safeMargins } from '../../src/core/rules/safe-margins.js';
import { makeDesign, runRule, shape, text } from '../helpers.js';

describe('safe-margins', () => {
  it('passes when important elements respect the margin (54px on 1080)', () => {
    const design = makeDesign([text({ role: 'headline', x: 60, y: 60, width: 960, height: 100 })]);
    expect(runRule(safeMargins, design)).toEqual([]);
  });

  it('ignores decorations and unimportant shapes near the edge', () => {
    const design = makeDesign([
      shape({ role: 'decoration', x: 0, y: 0, width: 50, height: 50 }),
      shape({ x: 0, y: 0, width: 50, height: 50 }),
    ]);
    expect(runRule(safeMargins, design)).toEqual([]);
  });

  it('flags a logo in the corner and moves it inside the margin', () => {
    const design = makeDesign([
      shape({ id: 'logo', role: 'logo', x: 10, y: 20, width: 100, height: 60 }),
    ]);
    const [issue] = runRule(safeMargins, design);
    expect(issue).toMatchObject({
      elementIds: ['logo'],
      measured: 10,
      threshold: 54,
      fix: [{ op: 'move', elementId: 'logo', dx: 44, dy: 34 }],
    });
    expect(issue!.message).toContain('left and top edge');
  });

  it('scales the margin with the canvas and respects options', () => {
    // 1200x628 banner: 5% of 628 = 31.4px, so 40px from the edge is fine.
    const banner = makeDesign([text({ x: 40, y: 40, width: 400, height: 80 })], {
      width: 1200,
      height: 628,
    });
    expect(runRule(safeMargins, banner)).toEqual([]);
    expect(runRule(safeMargins, banner, { marginPercent: 10 })).toHaveLength(1);
  });

  it('skips elements that are already off-canvas (reported by off-canvas)', () => {
    const design = makeDesign([text({ x: -20, y: 100 })]);
    expect(runRule(safeMargins, design)).toEqual([]);
  });
});
