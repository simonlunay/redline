import { describe, expect, it } from 'vitest';
import { offCanvas } from '../../src/core/rules/off-canvas.js';
import { makeDesign, runRule, shape, text } from '../helpers.js';

describe('off-canvas', () => {
  it('passes when everything is inside the canvas', () => {
    const design = makeDesign([shape({ x: 0, y: 0, width: 1080, height: 1080 }), text()]);
    expect(runRule(offCanvas, design)).toEqual([]);
  });

  it('ignores background elements that bleed off the edge', () => {
    const design = makeDesign([
      shape({ role: 'background', x: -50, y: -50, width: 1200, height: 1200 }),
    ]);
    expect(runRule(offCanvas, design)).toEqual([]);
  });

  it('warns about a partly outside element and suggests moving it back in', () => {
    const design = makeDesign([shape({ id: 'logo', x: 980, y: 40, width: 200, height: 100 })]);
    const [issue] = runRule(offCanvas, design);
    expect(issue).toMatchObject({
      severity: 'warning',
      elementIds: ['logo'],
      measured: 50,
      fix: [{ op: 'move', elementId: 'logo', dx: -100, dy: 0 }],
    });
  });

  it('errors on a fully outside element', () => {
    const design = makeDesign([shape({ id: 'lost', x: 1200, y: 100, width: 100, height: 100 })]);
    expect(runRule(offCanvas, design)[0]).toMatchObject({ severity: 'error', measured: 100 });
  });

  it('uses rotated bounds', () => {
    // A 200x200 square at the right edge fits unrotated but pokes out at 45 degrees.
    const design = makeDesign([shape({ x: 870, y: 400, width: 200, height: 200, rotation: 45 })]);
    expect(runRule(offCanvas, design)).toHaveLength(1);
    expect(runRule(offCanvas, design, { tolerance: 50 })).toHaveLength(0);
  });

  it('suggests resize + move for an element larger than the canvas', () => {
    const design = makeDesign([shape({ id: 'big', x: -10, y: 0, width: 2160, height: 540 })]);
    expect(runRule(offCanvas, design)[0]!.fix).toEqual([
      { op: 'resize', elementId: 'big', width: 1080, height: 270 },
      { op: 'move', elementId: 'big', dx: 10, dy: 0 },
    ]);
  });
});
