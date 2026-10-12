/**
 * The committed gallery data, checked the way the site checks it. For every stored snapshot of
 * every run and sample, the browser's rule set (lib/rules.ts) with the shared sampler and
 * measurer must reproduce the stored report exactly. Here the measuring context is Skia with the
 * same Inter files; tests/e2e repeats this in a real browser.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import type { RasterImage } from '@simonlunay/redline';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDesignEnv, checkDesign } from '../src/lib/env/design-env';
import { DESIGN_FONT_FAMILY, DESIGN_FONT_FILES } from '../src/lib/env/fonts';
import type { GalleryIndex, RunRecord, SampleRecord } from '../src/lib/gallery/types';
import { buildTimeline } from '../src/lib/run/timeline';

const WEB = fileURLToPath(new URL('../', import.meta.url));
const GALLERY = join(WEB, 'public', 'gallery');
const SAMPLES = join(WEB, 'public', 'samples');
const FONTS = fileURLToPath(new URL('../../../packages/checker/fonts/', import.meta.url));

const index = JSON.parse(readFileSync(join(GALLERY, 'index.json'), 'utf8')) as GalleryIndex;
const runs = index.runs.map(
  (r) => JSON.parse(readFileSync(join(GALLERY, r.id, 'run.json'), 'utf8')) as RunRecord,
);
const samples = index.samples.map(
  (s) => JSON.parse(readFileSync(join(SAMPLES, s.id, 'sample.json'), 'utf8')) as SampleRecord,
);

beforeAll(() => {
  for (const file of Object.values(DESIGN_FONT_FILES)) {
    GlobalFonts.registerFromPath(join(FONTS, file), DESIGN_FONT_FAMILY);
  }
});

async function envFor(dir: string, images: RunRecord['images']) {
  const decoded = new Map<
    string,
    { drawable: { width: number; height: number }; pixels: RasterImage }
  >();
  for (const src of Object.keys(images)) {
    const image = await loadImage(join(dir, src));
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, image.width, image.height);
    decoded.set(src, {
      drawable: image,
      pixels: { width: image.width, height: image.height, data },
    });
  }
  return createDesignEnv({
    measureContext: createCanvas(1, 1).getContext('2d'),
    images: decoded,
    analyses: images,
  });
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    total += st.isDirectory() ? dirBytes(path) : /\.(webp|png)$/.test(entry) ? st.size : 0;
  }
  return total;
}

describe('gallery data', () => {
  it('has the approved runs, strongest first', () => {
    expect(runs.length).toBeGreaterThanOrEqual(20);
    const tierOf = (o: string) => (o === 'shipped' || o === 'solved' ? 0 : 1);
    const tiers = index.runs.map((r) => tierOf(r.outcome));
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(index.runs.map((r) => r.rank)).toEqual(index.runs.map((_, i) => i));
  });

  it('labels every run the judge did not ship or the loop did not solve', () => {
    for (const r of index.runs) {
      if (r.outcome !== 'shipped' && r.outcome !== 'solved')
        expect(r.outcomeNote, r.id).toBeTruthy();
    }
  });

  it('stays under the 15 MB image budget', () => {
    expect(dirBytes(GALLERY) + dirBytes(SAMPLES)).toBeLessThan(15 * 1024 * 1024);
  });

  it('references only files that exist, and no local paths', () => {
    for (const run of runs) {
      const dir = join(GALLERY, run.id);
      for (const src of Object.keys(run.images)) expect(existsSync(join(dir, src)), src).toBe(true);
      for (const snap of Object.values(run.snapshots)) {
        if (snap.heatmap) expect(existsSync(join(dir, snap.heatmap))).toBe(true);
        for (const el of snap.design.elements) {
          if (el.type === 'image') expect(run.images[el.src], `${run.id} ${el.src}`).toBeDefined();
        }
      }
      const text = readFileSync(join(dir, 'run.json'), 'utf8');
      expect(text).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
    }
  });

  it('builds a timeline that ends on the final design', () => {
    for (const run of runs) {
      const frames = buildTimeline(run);
      expect(frames.at(-1)!.snapshot).toBe(run.final);
      for (const f of frames)
        if (f.snapshot) expect(run.snapshots[f.snapshot], run.id).toBeDefined();
    }
  });

  it('shows fix runs next to the rules-only loop on the same design', () => {
    for (const run of runs.filter((r) => r.kind === 'fix')) {
      expect(run.rulesLoop?.steps.length).toBeGreaterThan(0);
      expect(index.samples.find((s) => s.id === run.fixture)?.run).toBe(run.id);
    }
  });
});

describe("the browser's check reproduces every stored report", () => {
  for (const run of runs) {
    it(run.id, async () => {
      const env = await envFor(join(GALLERY, run.id), run.images);
      const planned = run.rules.keyElements
        ? run.snapshots[run.rules.keyElements.snapshot]!.design
        : undefined;
      for (const snap of Object.values(run.snapshots)) {
        const { report, attentionPaused } = checkDesign(snap.design, env, {
          rules: run.rules,
          ...(snap.attention ? { frozenAttention: snap.attention } : {}),
          ...(snap.ruleSet === 'loop' && planned ? { plannedDesign: planned } : {}),
        });
        expect(attentionPaused).toBeUndefined();
        expect(report, `${run.id} ${snap.id}`).toEqual(snap.report);
      }
    });
  }

  it('samples', async () => {
    for (const sample of samples) {
      const env = await envFor(join(SAMPLES, sample.id), sample.images);
      const { report } = checkDesign(sample.snapshot.design, env, {
        rules: sample.rules,
        ...(sample.snapshot.attention ? { frozenAttention: sample.snapshot.attention } : {}),
      });
      expect(report, sample.id).toEqual(sample.snapshot.report);
    }
  });

  it('pauses the attention rules once a design is edited', async () => {
    const sample = samples.find((s) => s.id === 'hard-story-hero')!;
    const env = await envFor(join(SAMPLES, sample.id), sample.images);
    const live = checkDesign(sample.snapshot.design, env, {
      rules: sample.rules,
      frozenAttention: sample.snapshot.attention!,
      edited: true,
    });
    expect(live.attentionPaused).toBe('edited');
    expect(live.report.rules.map((r) => r.ruleId)).not.toContain('attention-key-elements');
  });
});
