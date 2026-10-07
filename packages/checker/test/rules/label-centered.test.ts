import { describe, expect, it } from 'vitest';
import { applyFixes } from '../../src/core/fixes.js';
import { labelCentered, renderedTextBounds } from '../../src/core/rules/label-centered.js';
import type { TextElement } from '../../src/core/schema.js';
import type { TextMeasurer } from '../../src/core/text-measure.js';
import { makeDesign, runRule, shape, text } from '../helpers.js';

// Deterministic measurer: every character is 0.5em wide.
const halfEm: TextMeasurer = { measure: (t, f) => t.length * f.size * 0.5 };
const run = (design: ReturnType<typeof makeDesign>, options = {}) =>
  runRule(labelCentered, design, options, { measurer: halfEm });

// A 300x100 button at (100, 100): its center is (250, 150).
const button = (props = {}) => shape({ id: 'btn', role: 'cta', width: 300, height: 100, ...props });
// 'Go now' at 40px = 6 chars * 20 = 120px wide, one 40px line (lineHeight 1).
const labelProps = {
  id: 'lbl',
  role: 'cta' as const,
  content: 'Go now',
  fontSize: 40,
  lineHeight: 1,
};

describe('label-centered', () => {
  it('passes a label whose rendered text is centered in its button', () => {
    const design = makeDesign([
      button(),
      text({ ...labelProps, x: 100, y: 130, width: 300, height: 40, align: 'center' }),
    ]);
    expect(run(design)).toEqual([]);
  });

  it('flags a label box that fills the button: the text renders at the top', () => {
    // Box == button, align center: horizontally fine, but the 40px line sits at y 100..140.
    const design = makeDesign([
      button(),
      text({ ...labelProps, x: 100, y: 100, width: 300, height: 100, align: 'center' }),
    ]);
    const [issue] = run(design);
    expect(issue).toMatchObject({
      severity: 'error', // touches the top edge
      elementIds: ['lbl', 'btn'],
      measured: 30,
      threshold: 5,
      unit: 'px',
      fix: [
        { op: 'resize', elementId: 'lbl', width: 300, height: 40 },
        { op: 'move', elementId: 'lbl', dx: 0, dy: 30 },
      ],
    });
    expect(issue!.message).toMatch(/30px too high/);
  });

  it('measures the rendered text, not the box: a left-aligned label in a centered box', () => {
    // Box is centered in the button, but the 120px line starts at its left edge.
    const design = makeDesign([
      button(),
      text({ ...labelProps, x: 110, y: 130, width: 280, height: 40, align: 'left' }),
    ]);
    const [issue] = run(design);
    expect(issue).toMatchObject({ severity: 'warning', measured: 80 });
    expect(issue!.message).toMatch(/80px too far left/);
    expect(issue!.fix).toEqual([{ op: 'move', elementId: 'lbl', dx: 80, dy: 0 }]);
  });

  it('applying the suggested fix centers the label and clears the issue', () => {
    const design = makeDesign([
      button(),
      text({ ...labelProps, x: 100, y: 100, width: 300, height: 100, align: 'center' }),
    ]);
    const fixed = applyFixes(design, run(design)[0]!.fix!).design;
    expect(run(fixed)).toEqual([]);
    const label = fixed.elements.find((e) => e.id === 'lbl') as TextElement;
    expect(renderedTextBounds(label, halfEm)).toEqual({ x: 190, y: 130, width: 120, height: 40 });
  });

  it('narrows a box that is wider than its button when the line breaks stay the same', () => {
    const design = makeDesign([
      button(),
      text({ ...labelProps, x: 60, y: 100, width: 400, height: 100, align: 'center' }),
    ]);
    const [issue] = run(design);
    expect(issue!.fix).toEqual([
      { op: 'resize', elementId: 'lbl', width: 300, height: 40 },
      { op: 'move', elementId: 'lbl', dx: 40, dy: 30 },
    ]);
  });

  it('ignores small offsets within the tolerance', () => {
    // 4px low; tolerance is 5% of the 100px side = 5px.
    const design = makeDesign([
      button(),
      text({ ...labelProps, x: 100, y: 134, width: 300, height: 40, align: 'center' }),
    ]);
    expect(run(design)).toEqual([]);
    expect(run(design, { tolerancePercent: 2 })).toHaveLength(1);
  });

  it('pairs by groupId even when the label has drifted out of its shape', () => {
    const design = makeDesign([
      button({ groupId: 'cta' }),
      text({
        ...labelProps,
        groupId: 'cta',
        x: 100,
        y: 190,
        width: 300,
        height: 40,
        align: 'center',
      }),
    ]);
    expect(run(design)[0]).toMatchObject({ severity: 'error', measured: 60 });
  });

  it('ignores panels holding several texts, full-width bands, tall cards and text below the shape', () => {
    const panel = makeDesign([
      shape({ id: 'panel', x: 0, y: 0, width: 600, height: 300 }),
      text({ id: 'a', x: 20, y: 20, width: 400, height: 50, fontSize: 40, content: 'Title' }),
      text({ id: 'b', x: 20, y: 90, width: 400, height: 40, fontSize: 24, content: 'Body' }),
    ]);
    const band = makeDesign([
      shape({ id: 'band', x: 0, y: 900, width: 1080, height: 120 }),
      text({ ...labelProps, x: 40, y: 910, width: 600, height: 40 }),
    ]);
    const card = makeDesign([
      shape({ id: 'card', x: 100, y: 100, width: 400, height: 400 }),
      text({ ...labelProps, x: 120, y: 120, width: 300, height: 40 }),
    ]);
    const behind = makeDesign([
      text({ ...labelProps, x: 100, y: 100, width: 300, height: 100, zIndex: 0 }),
      button({ zIndex: 1 }),
    ]);
    for (const design of [panel, band, card, behind]) expect(run(design)).toEqual([]);
  });

  it('picks the tightest container: a button on a card', () => {
    const design = makeDesign([
      shape({ id: 'card', x: 50, y: 50, width: 400, height: 200 }),
      button({ zIndex: 1 }),
      text({ ...labelProps, x: 100, y: 100, width: 300, height: 100, zIndex: 2, align: 'center' }),
    ]);
    expect(run(design)[0]!.elementIds).toEqual(['lbl', 'btn']);
  });

  it('skips rotated labels and empty text', () => {
    const design = makeDesign([
      button(),
      text({ ...labelProps, x: 100, y: 100, width: 300, height: 100, rotation: 10 }),
      button({ id: 'btn2', x: 500 }),
      text({ ...labelProps, id: 'empty', content: ' ', x: 500, y: 100, width: 300, height: 100 }),
    ]);
    expect(run(design)).toEqual([]);
  });

  it('places multi-line text by align when measuring its bounds', () => {
    const el = makeDesign([
      text({
        content: 'aa\naaaa',
        fontSize: 10,
        lineHeight: 1.5,
        x: 0,
        y: 0,
        width: 100,
        align: 'right',
      }),
    ]).elements[0] as TextElement;
    // Lines 10px and 20px wide, right-aligned in a 100px box; two 15px lines.
    expect(renderedTextBounds(el, halfEm)).toEqual({ x: 80, y: 0, width: 20, height: 30 });
  });
});
