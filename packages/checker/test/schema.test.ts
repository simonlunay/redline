import { describe, expect, it } from 'vitest';
import { DesignValidationError, parseDesign } from '../src/core/schema.js';

describe('parseDesign', () => {
  it('fills defaults for optional element fields', () => {
    const design = parseDesign({
      version: '0.1',
      canvas: { width: 1080, height: 1080, background: '#fff' },
      elements: [
        {
          id: 'h',
          type: 'text',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          content: 'Hi',
          fontSize: 32,
          color: '#000',
        },
      ],
    });
    expect(design.elements[0]).toMatchObject({
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      fontWeight: 400,
      lineHeight: 1.2,
      align: 'left',
      fontFamily: 'Inter',
    });
  });

  it('rejects an unknown version, bad colors and duplicate ids with readable paths', () => {
    const bad = {
      version: '9.9',
      canvas: { width: 100, height: 100, background: 'red' },
      elements: [
        { id: 'a', type: 'shape', kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: '#000' },
        { id: 'a', type: 'shape', kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: '#000' },
      ],
    };
    try {
      parseDesign(bad);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DesignValidationError);
      const paths = (err as DesignValidationError).issues.map((i) => i.path);
      expect(paths).toContain('version');
      expect(paths).toContain('canvas.background');
    }
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      parseDesign({
        version: '0.1',
        canvas: { width: 100, height: 100, background: '#fff' },
        elements: [
          { id: 'a', type: 'shape', kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: '#000' },
          { id: 'a', type: 'shape', kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: '#000' },
        ],
      }),
    ).toThrow(/Duplicate element id "a"/);
  });
});
