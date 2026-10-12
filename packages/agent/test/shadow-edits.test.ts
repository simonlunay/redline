import { parseDesign } from '@simonlunay/redline';
import type { Design, Report } from '@simonlunay/redline';
import { describe, expect, it } from 'vitest';
import { submitEditsTool } from '../src/editors/anthropic.js';
import { createScriptedEditor } from '../src/editors/scripted.js';
import { parseEditResponse } from '../src/edits.js';
import { runFixLoop } from '../src/loop.js';
import type { ShadowOptions } from '../src/loop.js';
import { buildSystemPrompt, buildUserMessage } from '../src/prompt.js';

const design: Design = parseDesign({
  version: '0.1',
  canvas: { width: 1000, height: 1000, background: '#ffffff' },
  elements: [
    {
      id: 'product',
      type: 'image',
      role: 'product',
      x: 300,
      y: 400,
      width: 400,
      height: 400,
      src: 'cut.png',
      naturalWidth: 400,
      naturalHeight: 400,
      fit: 'contain',
    },
  ],
});

const shadowOpacity = (d: Design) => d.elements.find((e) => e.id === 'product-shadow')?.opacity;

/** A stand-in for the pipeline: the shadow is an ellipse under the product's bottom edge. */
function shadowOptions(): ShadowOptions & { applied: number } {
  const options = {
    applied: 0,
    subjects: (d: Design) => [{ elementId: 'product', opacity: shadowOpacity(d) ?? 0 }],
    apply: (d: Design, edit: { elementId: string; opacity: number }) => {
      if (edit.elementId !== 'product') return `"${edit.elementId}" is not a cut-out subject.`;
      options.applied++;
      const p = d.elements.find((e) => e.id === 'product')!;
      const rest = d.elements.filter((e) => e.id !== 'product-shadow');
      return parseDesign({
        ...d,
        elements: [
          {
            id: 'product-shadow',
            type: 'shape',
            role: 'decoration',
            kind: 'ellipse',
            x: p.x,
            y: p.y + p.height - 20,
            width: p.width,
            height: 40,
            fill: '#000000',
            opacity: edit.opacity,
            blur: 18,
          },
          ...rest,
        ],
      });
    },
  };
  return options;
}

/** The judge's "floating" finding stands in as an error until the product has a shadow. */
const floatsUntilShadowed = async (d: Design): Promise<Report> => {
  const grounded = (shadowOpacity(d) ?? 0) > 0;
  return {
    score: grounded ? 100 : 80,
    passed: grounded,
    summary: { errors: grounded ? 0 : 1, warnings: 0, infos: 0 },
    issues: grounded
      ? []
      : [
          {
            ruleId: 'visual-judge',
            severity: 'error',
            elementIds: ['product'],
            message: 'The product floats with no contact shadow.',
          },
        ],
    rules: [],
  } as unknown as Report;
};

const setShadow = (opacity: number, elementId = 'product') => ({
  summary: 'Ground the product.',
  edits: [{ op: 'setShadow', elementId, opacity, reason: 'it floats' }],
});

describe('setShadow in generation mode', () => {
  it('adds a contact shadow, records it and accepts the better score', async () => {
    const shadows = shadowOptions();
    const editor = createScriptedEditor([setShadow(0.4)]);
    const result = await runFixLoop(design, {
      editor,
      check: floatsUntilShadowed,
      target: 95,
      shadows,
    });
    expect(result.history[1]).toMatchObject({
      status: 'accepted',
      shadowEdits: [{ elementId: 'product', opacity: 0.4, reason: 'it floats', status: 'applied' }],
    });
    expect(shadowOpacity(result.best.design)).toBe(0.4);
    expect(result.stopReason).toBe('no-issues');
    // The editor was told which subjects can have a shadow.
    expect(editor.requests[0]!.shadows).toEqual([{ elementId: 'product', opacity: 0 }]);
    expect(buildUserMessage(editor.requests[0]!)).toMatch(
      /# Cut-out subjects \(setShadow\)\n- product: no contact shadow/,
    );
  });

  it('refuses subjects the pipeline does not know, and counts a step with only those as not applied', async () => {
    const shadows = shadowOptions();
    const result = await runFixLoop(design, {
      editor: createScriptedEditor([setShadow(0.4, 'headline')]),
      check: floatsUntilShadowed,
      target: 95,
      maxIterations: 1,
      shadows,
    });
    expect(result.history[1]).toMatchObject({
      status: 'rolled-back',
      note: 'None of the edits could be applied.',
      shadowEdits: [{ elementId: 'headline', status: 'rejected' }],
    });
    expect(shadows.applied).toBe(0);
  });

  it('re-derives dependent elements after the edits, before the check (normalize)', async () => {
    const seen: number[] = [];
    const result = await runFixLoop(design, {
      editor: createScriptedEditor([
        {
          summary: 'Move the product down.',
          edits: [{ op: 'move', elementId: 'product', dx: 0, dy: 50, reason: 'sit on the table' }],
        },
      ]),
      check: async (d) => {
        seen.push(d.elements.find((e) => e.id === 'product')!.y);
        return floatsUntilShadowed(d);
      },
      target: 95,
      maxIterations: 1,
      normalize: (d) => ({
        ...d,
        elements: d.elements.map((e) => (e.id === 'product' ? { ...e, y: e.y + 1 } : e)),
      }),
    });
    expect(seen).toEqual([400, 451]);
    expect(result.history[1]!.design.elements[0]!.y).toBe(451);
  });

  it('only exists in generation mode', async () => {
    expect(parseEditResponse(setShadow(0.4)).ok).toBe(false);
    expect(parseEditResponse(setShadow(0.4), { shadow: true }).ok).toBe(true);
    const generation = JSON.stringify(submitEditsTool({ generation: true }).input_schema);
    expect(generation).toContain('setShadow');
    expect(JSON.stringify(submitEditsTool().input_schema)).not.toContain('setShadow');
    expect(buildSystemPrompt({ generation: true })).toMatch(/setShadow \{elementId, opacity/);
    expect(buildSystemPrompt()).not.toMatch(/setShadow/);

    // Without shadow options the loop treats setShadow as an invalid response.
    const result = await runFixLoop(design, {
      editor: createScriptedEditor([setShadow(0.4), setShadow(0.4)]),
      check: floatsUntilShadowed,
      target: 95,
      maxIterations: 1,
    });
    expect(result.history[1]!.status).toBe('invalid');
  });
});
