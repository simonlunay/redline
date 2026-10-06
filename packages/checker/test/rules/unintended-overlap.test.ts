import { describe, expect, it } from 'vitest';
import { unintendedOverlap } from '../../src/core/rules/unintended-overlap.js';
import { image, makeDesign, runRule, shape, text } from '../helpers.js';

describe('unintended-overlap', () => {
  it('passes for separated elements', () => {
    const design = makeDesign([
      text({ x: 100, y: 100, width: 800, height: 100 }),
      image({ x: 100, y: 300, width: 400, height: 300 }),
    ]);
    expect(runRule(unintendedOverlap, design)).toEqual([]);
  });

  it('treats backgrounds, decorations, groups and button labels as intentional', () => {
    const design = makeDesign([
      image({
        role: 'background',
        x: 0,
        y: 0,
        width: 1080,
        height: 1080,
        naturalWidth: 1080,
        naturalHeight: 1080,
      }),
      shape({ role: 'decoration', x: 80, y: 80, width: 300, height: 300 }),
      text({ x: 100, y: 100, width: 300, height: 80, groupId: 'card' }),
      image({ x: 100, y: 150, width: 300, height: 225, groupId: 'card' }),
      shape({ role: 'cta', x: 600, y: 900, width: 300, height: 90, zIndex: 1 }),
      text({ role: 'cta', x: 620, y: 915, width: 260, height: 60, zIndex: 2 }),
    ]);
    expect(runRule(unintendedOverlap, design)).toEqual([]);
  });

  it('errors when the headline sits on the product image and moves the top element', () => {
    const design = makeDesign([
      image({ id: 'product', role: 'product', x: 240, y: 300, width: 600, height: 450, zIndex: 1 }),
      text({
        id: 'headline',
        role: 'headline',
        x: 140,
        y: 250,
        width: 800,
        height: 150,
        zIndex: 2,
      }),
    ]);
    const [issue] = runRule(unintendedOverlap, design);
    expect(issue).toMatchObject({
      severity: 'error',
      elementIds: ['headline', 'product'],
      fix: [{ op: 'move', elementId: 'headline', dx: 0, dy: -121.6 }],
    });
    expect(issue!.message).toContain('text overlaps an image');
  });

  it('flags text overlapping text', () => {
    const design = makeDesign([
      text({ id: 'a', x: 100, y: 100, width: 500, height: 100 }),
      text({ id: 'b', x: 100, y: 190, width: 500, height: 100 }),
    ]);
    const [issue] = runRule(unintendedOverlap, design);
    expect(issue).toMatchObject({ severity: 'warning', elementIds: ['b', 'a'], measured: 10 });
  });

  it('pulls a CTA label that pokes out of its button back inside', () => {
    const design = makeDesign([
      shape({ id: 'btn', role: 'cta', x: 600, y: 900, width: 300, height: 90 }),
      text({ id: 'label', role: 'cta', x: 640, y: 930, width: 260, height: 80 }),
    ]);
    expect(runRule(unintendedOverlap, design)[0]!.fix).toEqual([
      { op: 'move', elementId: 'label', dx: 0, dy: -20 },
    ]);
  });

  it('ignores plain shapes overlapping each other', () => {
    const design = makeDesign([shape({ x: 0 }), shape({ x: 50 })]);
    expect(runRule(unintendedOverlap, design)).toEqual([]);
  });
});
