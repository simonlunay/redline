import { describe, expect, it } from 'vitest';
import { imageAspectRatio } from '../../src/core/rules/image-aspect-ratio.js';
import { image, makeDesign, runRule } from '../helpers.js';

describe('image-aspect-ratio', () => {
  it('passes for an image at its natural ratio (4:3)', () => {
    const design = makeDesign([image({ width: 400, height: 300 })]);
    expect(runRule(imageAspectRatio, design)).toEqual([]);
  });

  it('skips cover/contain images, which crop or letterbox instead of distorting', () => {
    const design = makeDesign([image({ width: 400, height: 400, fit: 'cover' })]);
    expect(runRule(imageAspectRatio, design)).toEqual([]);
  });

  it('errors on a clearly stretched image and suggests the correct height', () => {
    const design = makeDesign([image({ id: 'p', width: 400, height: 200 })]);
    const [issue] = runRule(imageAspectRatio, design);
    expect(issue).toMatchObject({
      severity: 'error',
      measured: 50,
      fix: [{ op: 'resize', elementId: 'p', width: 400, height: 300 }],
    });
    expect(issue!.message).toContain('stretched horizontally');
  });

  it('warns on slight distortion', () => {
    const design = makeDesign([image({ width: 400, height: 290 })]);
    expect(runRule(imageAspectRatio, design)[0]!.severity).toBe('warning');
  });
});
