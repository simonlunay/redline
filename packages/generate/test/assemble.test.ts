import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Report } from '@simonlunay/redline';
import { describe, expect, it } from 'vitest';
import { assembleDesign, fitBox } from '../src/assemble.js';
import { templatePlan } from '../src/director/template.js';
import { createBackdropKeyRemover } from '../src/node/cutout.js';
import { MOCK_BACKDROP, createMockImageProvider } from '../src/node/mock-provider.js';
import { candidateVariant, rankCandidates, seedFrom } from '../src/select.js';
import { brief } from './helpers.js';

const canvas = { width: 1080, height: 1350 };

describe('assembling a plan into the Redline design format', () => {
  const plan = templatePlan(brief());
  const images = new Map([
    ['background', { src: 'a.assets/bg.png', width: 896, height: 1120 }],
    ['subject', { src: 'a.assets/subject.png', width: 400, height: 800 }],
  ]);

  it('builds a valid design: full-bleed cover background, fitted subject, text and shapes', () => {
    const design = assembleDesign(plan, 0, canvas, images);
    expect(design.version).toBe('0.1');
    expect(design.canvas).toEqual({ ...canvas, background: plan.palette.background });
    const bg = design.elements.find((e) => e.id === 'background')!;
    expect(bg).toMatchObject({
      type: 'image',
      x: 0,
      y: 0,
      width: 1080,
      height: 1350,
      fit: 'cover',
      naturalWidth: 896,
      src: 'a.assets/bg.png',
    });
    const subject = design.elements.find((e) => e.id === 'subject')!;
    const planned = plan.layouts[0]!.elements.find((e) => e.id === 'subject')!;
    expect(subject.type).toBe('image');
    expect(subject.width / subject.height).toBeCloseTo(0.5, 2); // the real aspect, never stretched
    expect(subject.height).toBeCloseTo(planned.height, 0); // tall image: limited by height
    expect(subject.x + subject.width / 2).toBeCloseTo(planned.x + planned.width / 2, 1); // centered in the planned box
    const headline = design.elements.find((e) => e.role === 'headline')!;
    expect(headline).toMatchObject({
      type: 'text',
      content: 'Charity 5K',
      fontFamily: 'Inter',
      fontWeight: 900,
    });
    expect(design.elements.find((e) => e.id === 'cta-button')).toMatchObject({
      type: 'shape',
      kind: 'rect',
    });
  });

  it('fails loudly when a slot has no image', () => {
    expect(() =>
      assembleDesign(plan, 0, canvas, new Map([['background', images.get('background')!]])),
    ).toThrow(/No image was produced for slot "subject"/);
    expect(() => assembleDesign(plan, 5, canvas, images)).toThrow(/no layout 5/);
  });

  it('fits boxes in both directions', () => {
    expect(fitBox({ x: 0, y: 0, width: 200, height: 100 }, 1)).toEqual({
      x: 50,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(fitBox({ x: 10, y: 10, width: 100, height: 300 }, 2)).toEqual({
      x: 10,
      y: 135,
      width: 100,
      height: 50,
    });
  });
});

const report = (score: number, errors = 0, warnings = 0, cta?: number): Report => ({
  score,
  passed: errors === 0,
  summary: { errors, warnings, infos: 0 },
  issues: [],
  rules:
    cta === undefined
      ? []
      : [
          {
            ruleId: 'attention-key-elements',
            score: 100,
            weight: 1,
            issues: 0,
            details: { roleShares: { cta } },
          },
        ],
});

describe('best-of-N selection', () => {
  it('ranks by score, then errors, warnings, CTA attention, then original order', () => {
    expect(rankCandidates([report(80), report(95), report(90)])).toEqual([1, 2, 0]);
    expect(rankCandidates([report(90, 1), report(90, 0)])).toEqual([1, 0]);
    expect(rankCandidates([report(90, 0, 2), report(90, 0, 1)])).toEqual([1, 0]);
    expect(rankCandidates([report(90, 0, 0, 0.04), report(90, 0, 0, 0.12)])).toEqual([1, 0]);
    expect(rankCandidates([report(90), report(90), report(90)])).toEqual([0, 1, 2]);
  });

  it('spreads candidates over layouts first, then background variants', () => {
    expect([0, 1, 2, 3].map((i) => candidateVariant(i, 2))).toEqual([
      { layout: 0, variant: 0 },
      { layout: 1, variant: 0 },
      { layout: 0, variant: 1 },
      { layout: 1, variant: 1 },
    ]);
    expect(seedFrom('a')).toBe(seedFrom('a'));
    expect(seedFrom('a')).not.toBe(seedFrom('b'));
  });
});

describe('cutouts', () => {
  it('keys out a plain backdrop, keeps the subject opaque and trims to it', async () => {
    const subject = await createMockImageProvider().generate({
      prompt: 'x',
      width: 600,
      height: 600,
      seed: 3,
      kind: 'subject',
    });
    const cut = await createBackdropKeyRemover().remove(subject.bytes);
    const original = await loadImage(Buffer.from(subject.bytes));
    expect(cut.width).toBeLessThan(original.width);
    expect(cut.height).toBeLessThan(original.height);
    expect(cut.coverage).toBeGreaterThan(0.2);
    expect(cut.coverage).toBeLessThan(0.8);
    const img = await loadImage(Buffer.from(cut.png));
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const center = ctx.getImageData(
      Math.floor(img.width / 2),
      Math.floor(img.height / 2),
      1,
      1,
    ).data;
    expect(center[3]).toBe(255);
    expect(MOCK_BACKDROP).toBe('#e5e7eb');
  });

  it('rejects an image with no subject', async () => {
    const c = createCanvas(64, 64);
    const ctx = c.getContext('2d');
    ctx.fillStyle = MOCK_BACKDROP;
    ctx.fillRect(0, 0, 64, 64);
    await expect(
      createBackdropKeyRemover().remove(new Uint8Array(await c.encode('png'))),
    ).rejects.toThrow(/cutout is empty/);
  });
});

describe('button labels', () => {
  it('centers a CTA label vertically and horizontally in its button', async () => {
    const { centerButtonLabels } = await import('../src/assemble.js');
    const { parseDesign } = await import('@simonlunay/redline');
    const design = parseDesign({
      version: '0.1',
      canvas: { width: 1000, height: 1000, background: '#000000' },
      elements: [
        {
          id: 'btn',
          type: 'shape',
          role: 'cta',
          kind: 'rect',
          x: 100,
          y: 800,
          width: 400,
          height: 100,
          fill: '#ff7a1a',
        },
        {
          id: 'label',
          type: 'text',
          role: 'cta',
          x: 100,
          y: 800,
          width: 300,
          height: 100,
          content: 'Go',
          fontSize: 40,
          lineHeight: 1.2,
          color: '#000000',
        },
        {
          id: 'free',
          type: 'text',
          role: 'cta',
          x: 600,
          y: 100,
          width: 300,
          height: 100,
          content: 'Elsewhere',
          fontSize: 40,
          color: '#ffffff',
        },
      ],
    });
    const out = centerButtonLabels(design);
    const label = out.elements.find((e) => e.id === 'label')!;
    expect(label.height).toBe(52); // one line of 40 x 1.2 + slack
    expect(label.y + label.height / 2).toBeCloseTo(850, 0);
    expect(label.x + label.width / 2).toBeCloseTo(300, 0);
    expect(label).toMatchObject({ align: 'center' });
    expect(out.elements.find((e) => e.id === 'free')).toEqual(
      design.elements.find((e) => e.id === 'free'),
    );
  });
});
