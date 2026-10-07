import { describe, expect, it } from 'vitest';
import {
  createTemplateArtDirector,
  headlineFromPrompt,
  templatePlan,
} from '../src/director/template.js';
import { designPlanSchema } from '../src/director/anthropic.js';
import { NO_TEXT, buildImagePrompt, describeTextZones } from '../src/image-prompt.js';
import { parsePlan, toToolPlan, validatePlan } from '../src/plan.js';
import type { DesignPlan } from '../src/plan.js';
import { brief } from './helpers.js';

const ctx = {
  canvas: { width: 1080, height: 1350 },
  fonts: ['Inter'],
  userImageIds: [],
  layouts: 2,
};

function plan(): DesignPlan {
  return structuredClone(templatePlan(brief()));
}

describe('design plan validation', () => {
  it('accepts the template plans for portrait, square, story and banners', () => {
    for (const canvas of [
      { width: 1080, height: 1350 },
      { width: 1080, height: 1080 },
      { width: 1080, height: 1920 },
      { width: 1200, height: 628 },
      { width: 1500, height: 500 },
    ]) {
      const p = templatePlan(brief({ canvas }));
      expect(validatePlan(p, { ...ctx, canvas }), `${canvas.width}x${canvas.height}`).toEqual([]);
    }
  });

  it('explains a missing plan', () => {
    const result = parsePlan(undefined, ctx);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('No plan was returned'),
    });
  });

  it('reports schema mismatches with their path', () => {
    const p = plan() as unknown as { layouts: { elements: { kind: string }[] }[] };
    p.layouts[0]!.elements[1]!.kind = 'video';
    const result = parsePlan(p, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/layouts\.0\.elements\.1/);
  });

  it('refuses briefs that would make the image model render the copy', () => {
    const p = plan();
    p.layouts[0]!.imageSlots[0]!.brief = `A crowd holding a banner that says "${p.copy.headline}"`;
    const problems = validatePlan(p, ctx);
    expect(problems.join('\n')).toMatch(/contains the copy "charity 5k"/);
  });

  it('requires calm areas on backgrounds, a headline, known fonts and slots', () => {
    const p = plan();
    const layout = p.layouts[0]!;
    layout.imageSlots[0]!.calmAreas = ' ';
    const headline = layout.elements.find((e) => e.role === 'headline')!;
    if (headline.kind === 'text') headline.fontFamily = 'Comic Sans';
    const image = layout.elements.find((e) => e.kind === 'image' && e.role === 'product')!;
    if (image.kind === 'image') image.slot = 'nope';
    const problems = validatePlan(p, ctx).join('\n');
    expect(problems).toMatch(/calmAreas is empty/);
    expect(problems).toMatch(/font "Comic Sans" is not available/);
    expect(problems).toMatch(/slot "nope" is not an image slot/);
    expect(problems).toMatch(/image slot "subject" is not used/);
  });

  it('checks boxes, colors, layout count and user image references', () => {
    const p = plan();
    const layout = p.layouts[0]!;
    const cta = layout.elements.find((e) => e.kind === 'shape')!;
    if (cta.kind === 'shape') cta.fill = 'orange';
    layout.elements.find((e) => e.role === 'headline')!.x = 900;
    layout.imageSlots.push({
      id: 'logo',
      kind: 'user',
      brief: '',
      calmAreas: '',
      style: '',
      stockQuery: '',
      userImageId: 'nope',
    });
    const problems = validatePlan(p, { ...ctx, layouts: 1 }).join('\n');
    expect(problems).toMatch(/fill "orange" is not a hex color/);
    expect(problems).toMatch(/outside the 1080x1350 canvas/);
    expect(problems).toMatch(/2 layouts were sent; send exactly 1/);
    expect(problems).toMatch(
      /userImageId "nope" is not one of the supplied images \(none supplied\)/,
    );
  });

  it('accepts the tool format (per-kind arrays) and explains empty layouts', () => {
    const tool = toToolPlan(plan());
    const parsed = parsePlan(tool, ctx);
    expect(parsed.ok).toBe(true);
    tool.layouts[0]!.texts = [];
    tool.layouts[0]!.shapes = [];
    tool.layouts[0]!.images = [];
    const empty = parsePlan(tool, ctx);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatch(/layouts\[0\]: has no elements/);
  });

  it('builds a structured-output schema with every object closed and no unsupported keywords', () => {
    const schema = designPlanSchema();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      for (const banned of ['minimum', 'maximum', 'pattern', 'minLength', 'oneOf', '$schema']) {
        expect(obj).not.toHaveProperty(banned);
      }
      if (obj.type === 'object' && obj.properties) {
        expect(obj.additionalProperties).toBe(false);
        expect(obj.required).toEqual(Object.keys(obj.properties as object));
      }
      Object.values(obj).forEach(walk);
    };
    walk(schema);
    // Per-kind arrays instead of a union: simpler for constrained decoding to follow.
    expect(JSON.stringify(schema)).not.toMatch(/"anyOf"|"oneOf"/);
  });
});

describe('template art director', () => {
  it('derives copy and colors from the prompt', async () => {
    const { plan: p, calls } = await createTemplateArtDirector().plan(brief());
    expect(calls).toBe(0);
    expect(p.copy.headline).toBe('Charity 5K');
    expect(p.palette.primary).toBe('#1d4ed8'); // blue first, as in the prompt
    expect(p.palette.accent).toBe('#f97316');
    expect(p.layouts).toHaveLength(2);
    expect(headlineFromPrompt('Instagram ad announcing our new oat latte, cozy')).toBe(
      'New Oat Latte',
    );
  });

  it('uses a split layout for wide banners and places a supplied logo', () => {
    const p = templatePlan(
      brief({
        canvas: { width: 1200, height: 628 },
        userImages: [{ id: 'logo', use: 'logo', width: 400, height: 100 }],
      }),
    );
    expect(p.layouts).toHaveLength(1);
    expect(p.layouts[0]!.name).toMatch(/split/);
    const logo = p.layouts[0]!.elements.find((e) => e.role === 'logo')!;
    expect(logo.width / logo.height).toBeCloseTo(4, 0);
  });
});

describe('image prompts', () => {
  it('describe where text will sit from the layout geometry', () => {
    const p = plan();
    const zones = describeTextZones(p.layouts[0]!.elements, { width: 1080, height: 1350 });
    expect(zones).toMatch(/^Text will be placed over the top \d+% \(headline, subheading\)/);
    expect(zones).toMatch(/the bottom \d+%, center side \(cta\)/);
    const panel = describeTextZones(p.layouts[1]!.elements, { width: 1080, height: 1350 });
    expect(panel).toMatch(/the bottom \d+% \(headline, subheading/);
  });

  it('always forbid text and keep subjects on a plain backdrop', () => {
    const p = plan();
    const [background, subject] = p.layouts[0]!.imageSlots;
    const bg = buildImagePrompt(background!, p.layouts[0]!.elements, { width: 1080, height: 1350 });
    expect(bg).toContain(background!.calmAreas);
    expect(bg).toContain('Text will be placed over');
    expect(bg.endsWith(NO_TEXT)).toBe(true);
    const sub = buildImagePrompt(subject!, p.layouts[0]!.elements, { width: 1080, height: 1350 });
    expect(sub).toMatch(/plain seamless light grey studio background/);
    expect(sub).not.toContain('Text will be placed over');
    expect(sub.endsWith(NO_TEXT)).toBe(true);
  });
});
