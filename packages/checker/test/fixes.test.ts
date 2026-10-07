import { describe, expect, it } from 'vitest';
import { check } from '../src/core/check.js';
import { applyFixes } from '../src/core/fixes.js';
import { designJsonSchema, fixJsonSchema } from '../src/core/json-schema.js';
import { paintOrder } from '../src/core/rules/util.js';
import { DesignSchema } from '../src/core/schema.js';
import type { ImageSampler } from '../src/core/types.js';
import { image, makeDesign, shape, text } from './helpers.js';

const base = () =>
  makeDesign([
    shape({ id: 'box', x: 100, y: 100, width: 200, height: 100 }),
    text({ id: 'title', x: 100, y: 300, width: 600, height: 100, fontSize: 40 }),
    image({ id: 'photo', x: 100, y: 500 }),
  ]);

describe('applyFixes', () => {
  it('applies every op and returns a new, valid design without mutating the input', () => {
    const design = base();
    const snapshot = structuredClone(design);
    const {
      design: out,
      applied,
      rejected,
    } = applyFixes(design, [
      { op: 'move', elementId: 'box', dx: 10, dy: -5 },
      { op: 'resize', elementId: 'photo', width: 300, height: 225 },
      { op: 'setColor', elementId: 'title', color: '#ff0000' },
      { op: 'setColor', elementId: 'box', color: '#00ff00' },
      { op: 'setFontSize', elementId: 'title', fontSize: 48 },
      { op: 'setFontWeight', elementId: 'title', fontWeight: 700 },
    ]);
    expect(rejected).toEqual([]);
    expect(applied).toHaveLength(6);
    expect(design).toEqual(snapshot);
    expect(DesignSchema.safeParse(out).success).toBe(true);
    const byId = Object.fromEntries(out.elements.map((el) => [el.id, el]));
    expect(byId.box).toMatchObject({ x: 110, y: 95, fill: '#00ff00' });
    expect(byId.photo).toMatchObject({ width: 300, height: 225 });
    expect(byId.title).toMatchObject({ color: '#ff0000', fontSize: 48, fontWeight: 700 });
  });

  it('rejects malformed ops, unknown ids and ops on the wrong element type', () => {
    const { rejected, applied } = applyFixes(base(), [
      { op: 'teleport', elementId: 'box' },
      { op: 'move', elementId: 'nope', dx: 1, dy: 1 },
      { op: 'setFontSize', elementId: 'photo', fontSize: 20 },
      { op: 'setColor', elementId: 'photo', color: '#000000' },
      { op: 'setColor', elementId: 'title', color: 'red' },
      { op: 'move', elementId: 'box', dx: Number.NaN, dy: 0 },
      'not even an object',
    ]);
    expect(applied).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual([
      expect.stringMatching(/./),
      'No element with id "nope"',
      'setFontSize only applies to text',
      'setColor only applies to text and shapes',
      '"red" is not a hex color',
      expect.stringMatching(/expected number, received NaN/), // Zod rejects NaN/Infinity
      expect.stringMatching(/./),
    ]);
  });

  it('clamps out-of-range values instead of failing', () => {
    const { design, rejected } = applyFixes(base(), [
      { op: 'resize', elementId: 'box', width: -50, height: 0 },
      { op: 'setFontSize', elementId: 'title', fontSize: 5000 },
      { op: 'setFontWeight', elementId: 'title', fontWeight: 50 },
      { op: 'setOpacity', elementId: 'box', opacity: 1.7 },
    ]);
    expect(rejected).toEqual([]);
    const byId = Object.fromEntries(design.elements.map((el) => [el.id, el]));
    expect(byId.box).toMatchObject({ width: 1, height: 1, opacity: 1 });
    expect(byId.title).toMatchObject({ fontSize: 1000, fontWeight: 100 });
  });

  it('cannot change text content, font family or image src (no op exists for them)', () => {
    const { applied, rejected } = applyFixes(base(), [
      { op: 'setText', elementId: 'title', content: 'Hacked' },
      { op: 'move', elementId: 'title', dx: 0, dy: 0, content: 'Hacked' },
    ]);
    expect(rejected).toHaveLength(1);
    expect(applied).toHaveLength(1);
    const title = applyFixes(base(), applied).design.elements.find((el) => el.id === 'title');
    expect(title).toMatchObject({ content: 'Hello' });
  });
});

describe('insertShape', () => {
  const backing = {
    op: 'insertShape',
    behindElementId: 'title',
    kind: 'rect',
    x: 90,
    y: 290,
    width: 620,
    height: 120,
    fill: '#000000',
    opacity: 0.6,
    cornerRadius: 12,
  } as const;

  it('adds a decoration shape with a new id, painted directly behind the target', () => {
    const { design, insertedIds } = applyFixes(base(), [backing, backing]);
    expect(insertedIds).toEqual(['title-backing', 'title-backing-2']);
    const inserted = design.elements.find((el) => el.id === 'title-backing');
    expect(inserted).toMatchObject({ type: 'shape', role: 'decoration', opacity: 0.6 });
    const order = paintOrder(design).map((el) => el.id);
    expect(order.indexOf('title-backing')).toBe(order.indexOf('title') - 2);
    expect(order.indexOf('title-backing-2')).toBe(order.indexOf('title') - 1);
  });

  it('clamps opacity and rejects a missing target', () => {
    const { design, rejected } = applyFixes(base(), [
      { ...backing, opacity: 3 },
      { ...backing, behindElementId: 'ghost' },
    ]);
    expect(design.elements.find((el) => el.id === 'title-backing')).toMatchObject({ opacity: 1 });
    expect(rejected[0]!.reason).toBe('No element with id "ghost"');
  });

  it('fixes white text on a pale photo when the checker re-runs', () => {
    const pale: ImageSampler = {
      has: () => true,
      sample: () => ({ r: 235, g: 235, b: 225, a: 1 }),
    };
    const design = makeDesign([
      image({
        id: 'bg',
        x: 0,
        y: 0,
        width: 1080,
        height: 1080,
        naturalWidth: 1080,
        naturalHeight: 1080,
      }),
      text({ id: 'title', x: 100, y: 300, width: 600, height: 100, color: '#ffffff', zIndex: 1 }),
    ]);
    const contrast = (d: unknown) =>
      check(d, { sampler: pale }).issues.filter((i) => i.ruleId === 'text-contrast');
    expect(contrast(design)).toHaveLength(1);
    const fixed = applyFixes(design, [backing]).design;
    expect(contrast(fixed)).toEqual([]);
  });
});

describe('JSON Schema export', () => {
  it('describes the design format and the fix ops', () => {
    const design = designJsonSchema();
    expect(design).toMatchObject({ type: 'object', required: expect.arrayContaining(['version']) });
    const ops = (fixJsonSchema().oneOf as { properties: { op: { const: string } } }[]).map(
      (s) => s.properties.op.const,
    );
    expect(ops).toEqual([
      'move',
      'resize',
      'setColor',
      'setFontSize',
      'setFontWeight',
      'setOpacity',
      'insertShape',
    ]);
  });
});
