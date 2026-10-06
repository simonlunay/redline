import { describe, expect, it } from 'vitest';
import { textOverflow } from '../../src/core/rules/text-overflow.js';
import type { TextMeasurer } from '../../src/core/text-measure.js';
import { makeDesign, runRule, text } from '../helpers.js';

// Deterministic measurer: every character is 0.5em wide.
const halfEm: TextMeasurer = { measure: (t, f) => t.length * f.size * 0.5 };
const run = (design: ReturnType<typeof makeDesign>, options = {}) =>
  runRule(textOverflow, design, options, { measurer: halfEm });

describe('text-overflow', () => {
  it('passes when wrapped text fits', () => {
    // 'aaaa bbbb' at 40px = 9 chars * 20 = 180px wide -> one line, 48px tall.
    const design = makeDesign([text({ content: 'aaaa bbbb', width: 200, height: 50 })]);
    expect(run(design)).toEqual([]);
  });

  it('errors when lines overflow the height and grows the box when shrinking is not enough', () => {
    // Wraps to 3 lines at 40px * 1.2 = 144px, box is 50px.
    const design = makeDesign([
      text({ id: 't', content: 'aaaa bbbb cccc', width: 100, height: 50, fontSize: 40 }),
    ]);
    const [issue] = run(design);
    expect(issue).toMatchObject({
      severity: 'error',
      measured: 144,
      threshold: 50,
      fix: [{ op: 'resize', elementId: 't', width: 100, height: 144 }],
    });
  });

  it('suggests a slightly smaller font when that is enough', () => {
    // 10 chars at 40px = 200px in a 190px box: 38px fits on one line (190px).
    const design = makeDesign([
      text({ id: 't', content: 'aaaaaaaaaa', width: 190, height: 50, fontSize: 40 }),
    ]);
    const [issue] = run(design);
    expect(issue!.message).toMatch(/word that is 10px wider/);
    expect(issue!.fix).toEqual([{ op: 'setFontSize', elementId: 't', fontSize: 38 }]);
  });

  it('warns when less than half a line is clipped', () => {
    const design = makeDesign([text({ content: 'ab', width: 200, height: 40, fontSize: 40 })]);
    expect(run(design)[0]!.severity).toBe('warning');
  });

  it('uses the default heuristic measurer when none is given', () => {
    const long = 'This sentence is far too long to fit inside such a small text box';
    const design = makeDesign([text({ content: long, width: 200, height: 60, fontSize: 32 })]);
    expect(runRule(textOverflow, design)).toHaveLength(1);
  });
});
