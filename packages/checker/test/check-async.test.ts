import { describe, expect, it, vi } from 'vitest';
import { check, checkAsync } from '../src/core/check.js';
import { builtinRules } from '../src/core/rules/index.js';
import { defineRule } from '../src/core/types.js';
import type { RasterImage } from '../src/core/types.js';
import { makeDesign, text } from './helpers.js';

/** Stand-in for the future attention rule: async, needs a render, reports per-element scores. */
const fakeAttention = defineRule({
  id: 'fake-attention',
  description: 'Test rule shaped like a saliency check.',
  defaultSeverity: 'warning',
  weight: 2,
  requires: ['render'],
  defaultOptions: {},
  async check({ design, render }) {
    const image = await render!();
    return {
      issues: [
        { elementIds: ['h'], message: `rendered ${image.width}px`, measured: 0.1, threshold: 0.2 },
      ],
      elementScores: Object.fromEntries(design.elements.map((el) => [el.id, 0.5])),
    };
  },
});

const design = makeDesign([text({ id: 'h' })]);
const raster: RasterImage = { width: 1080, height: 1080, data: new Uint8ClampedArray(4) };

describe('async rules and render capability', () => {
  it('check() skips async/render rules and says why', () => {
    const report = check(design, { rules: [...builtinRules, fakeAttention] });
    expect(report.skipped).toEqual([
      { ruleId: 'fake-attention', reason: expect.stringMatching(/renderer/) },
    ]);
    expect(report.rules.map((r) => r.ruleId)).not.toContain('fake-attention');
  });

  it('checkAsync() renders lazily once and reports per-element scores', async () => {
    const render = vi.fn(async () => raster);
    const report = await checkAsync(design, { rules: [fakeAttention, fakeAttention], render });
    expect(render).toHaveBeenCalledTimes(1);
    expect(report.skipped).toBeUndefined();
    expect(report.rules[0]).toMatchObject({ ruleId: 'fake-attention', elementScores: { h: 0.5 } });
    expect(report.issues[0]!.message).toBe('rendered 1080px');
  });

  it('checkAsync() without a renderer skips the rule but still runs the rest', async () => {
    const report = await checkAsync(design, { rules: [...builtinRules, fakeAttention] });
    expect(report.skipped?.[0]?.ruleId).toBe('fake-attention');
    expect(report).toMatchObject(check(design));
  });

  it('gives identical reports to check() for the built-in sync rules', async () => {
    expect(await checkAsync(design)).toEqual(check(design));
  });
});
