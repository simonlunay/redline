import { readFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { judgeCutout, measureCutout } from '../src/core/cutout-quality.js';
import type { CutoutProblem } from '../src/core/cutout-quality.js';
import { cutoutQuality } from '../src/core/rules/cutout-quality.js';
import { image, makeDesign, runRule } from './helpers.js';

/** The studio backdrop the subjects were shot on (border median of a FLUX subject image). */
const BACKDROP: [number, number, number] = [233, 229, 227];

async function metricsOf(file: string) {
  const img = await loadImage(readFileSync(new URL(`./fixtures/cutouts/${file}`, import.meta.url)));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return measureCutout(
    {
      width: img.width,
      height: img.height,
      data: ctx.getImageData(0, 0, img.width, img.height).data,
    },
    BACKDROP,
  );
}

/**
 * Real, clean BiRefNet cuts from the phase 5b eval that the keyer-tuned thresholds misread
 * (see fixtures/cutouts/SOURCES.md). Each row: the signal that fires, and its severity when the
 * source isn't known.
 */
const CASES: {
  file: string;
  name: string;
  fires: CutoutProblem;
  unknownSource: 'warning' | 'error';
}[] = [
  {
    file: 'white-cat.png',
    name: 'a white cat',
    fires: 'leftover-backdrop',
    unknownSource: 'warning',
  },
  {
    file: 'white-laptop-screen.png',
    name: 'a white laptop screen',
    fires: 'leftover-backdrop',
    unknownSource: 'warning',
  },
  {
    file: 'cream-clothing.png',
    name: 'cream clothing',
    fires: 'leftover-backdrop',
    unknownSource: 'warning',
  },
  {
    file: 'white-dropper.png',
    name: 'a white dropper bulb',
    fires: 'leftover-backdrop',
    unknownSource: 'error',
  },
  {
    file: 'dropper-bottle-steps.png',
    name: "a dropper bottle's collar steps",
    fires: 'bites',
    unknownSource: 'error',
  },
  {
    file: 'laptop-hinge.png',
    name: "a laptop's hinge step",
    fires: 'bites',
    unknownSource: 'warning',
  },
];

describe('cutout-quality on segmentation-model cuts', () => {
  for (const c of CASES) {
    it(`${c.name}: flagged as ${c.fires}, but only ever a warning on a model cut`, async () => {
      const metrics = await metricsOf(c.file);

      // What the keyer-tuned thresholds say when the source isn't known (the false alarm).
      const raw = judgeCutout(metrics);
      expect(raw.problems.map((p) => p.kind)).toContain(c.fires);
      expect(raw.severity).toBe(c.unknownSource);

      // A model cut: reported, never an error, so it can't outvote the judge.
      const model = judgeCutout(metrics, { source: 'model' });
      expect(model.source).toBe('model');
      expect(model.severity).toBe('warning');
      expect(model.problems.every((p) => p.severity === 'warning')).toBe(true);
      expect(model.problems.map((p) => p.kind)).toEqual(raw.problems.map((p) => p.kind));

      const issues = runRule(
        cutoutQuality,
        makeDesign([image({ id: 'product', src: 'cut.png', role: 'product' })]),
        {},
        { images: { get: () => ({ origin: 'generated', cutout: model }) } },
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ severity: 'warning', elementIds: ['product'] });
      expect(issues[0]!.message).toMatch(/segmentation model.*only a warning/);
    });
  }

  it('keeps keyed cuts at full severity', async () => {
    const metrics = await metricsOf('dropper-bottle-steps.png');
    expect(judgeCutout(metrics, { source: 'keyer' }).severity).toBe('error');
  });
});
