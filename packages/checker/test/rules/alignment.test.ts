import { describe, expect, it } from 'vitest';
import { alignment } from '../../src/core/rules/alignment.js';
import { makeDesign, runRule, shape, text } from '../helpers.js';

describe('alignment', () => {
  it('passes when left edges are exactly aligned', () => {
    const design = makeDesign([
      text({ x: 100, y: 100, width: 600 }),
      text({ x: 100, y: 300, width: 400 }),
    ]);
    expect(runRule(alignment, design)).toEqual([]);
  });

  it('passes when offsets are large enough to look deliberate', () => {
    const design = makeDesign([
      text({ x: 100, y: 100, width: 600 }),
      text({ x: 160, y: 300, width: 400 }),
    ]);
    expect(runRule(alignment, design)).toEqual([]);
  });

  it('flags a near-miss left edge and moves the unanchored element', () => {
    const design = makeDesign([
      text({ id: 'title', x: 100, y: 100, width: 600 }),
      text({ id: 'sub', x: 100, y: 250, width: 500 }),
      text({ id: 'body', x: 106, y: 400, width: 333 }),
    ]);
    const issues = runRule(alignment, design);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      elementIds: ['body', 'title'],
      measured: 6,
      fix: [{ op: 'move', elementId: 'body', dx: -6, dy: 0 }],
    });
  });

  it('flags an element that is almost centered on the canvas', () => {
    const design = makeDesign([text({ id: 'h', x: 245, y: 100, width: 600 })]); // center 545 vs 540
    const [issue] = runRule(alignment, design);
    expect(issue).toMatchObject({
      elementIds: ['h'],
      fix: [{ op: 'move', elementId: 'h', dx: -5, dy: 0 }],
    });
  });

  it('does not flag centered elements of different widths (their edges differ on purpose)', () => {
    const design = makeDesign([
      text({ x: 240, y: 100, width: 600 }),
      text({ x: 244, y: 300, width: 592 }),
    ]);
    expect(runRule(alignment, design)).toEqual([]);
  });

  it('ignores a label inside its button', () => {
    const design = makeDesign([
      shape({ x: 100, y: 800, width: 300, height: 80 }),
      text({ x: 104, y: 810, width: 292, height: 60 }),
    ]);
    expect(runRule(alignment, design)).toEqual([]);
  });

  it('ignores backgrounds and decorations', () => {
    const design = makeDesign([
      text({ x: 100, y: 100 }),
      shape({ role: 'decoration', x: 103, y: 400 }),
      shape({ role: 'background', x: 97, y: 0, width: 1080, height: 1080 }),
    ]);
    expect(runRule(alignment, design)).toEqual([]);
  });
});
