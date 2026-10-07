import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createScriptedEditor, createSuggestedFixesEditor } from '@simonlunay/redline-agent';
import { loadDesign } from '@simonlunay/redline/node';
import { describe, expect, it } from 'vitest';
import { createTemplateArtDirector } from '../src/director/template.js';
import { createBackdropKeyRemover } from '../src/node/cutout.js';
import { createMockImageProvider } from '../src/node/mock-provider.js';
import { generateDesign } from '../src/node/pipeline.js';
import type { GenerateEvent } from '../src/node/pipeline.js';
import { createWorkspace } from '../src/node/workspace.js';
import type { ImageProvider } from '../src/providers/types.js';
import { createMemoryLedger } from '../src/spend.js';
import { brightnessSaliency, tempDir } from './helpers.js';

async function run(dir: string, overrides: Partial<Parameters<typeof generateDesign>[0]> = {}) {
  const events: GenerateEvent[] = [];
  const result = await generateDesign({
    prompt: 'poster for a charity 5K, energetic, blue and orange',
    canvas: { width: 1080, height: 1350 },
    out: join(dir, 'charity.json'),
    director: createTemplateArtDirector(),
    provider: createMockImageProvider({ megapixels: 0.1 }),
    remover: createBackdropKeyRemover(),
    editor: createSuggestedFixesEditor(),
    workspace: await createWorkspace(dir, { attention: true, saliency: brightnessSaliency() }),
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { result, events };
}

describe('generateDesign (template director, mock images, offline editor)', () => {
  it('builds N candidates, scores each, picks the best and runs the fix loop on it', async () => {
    const dir = tempDir();
    const { result, events } = await run(dir);

    expect(result.candidates).toHaveLength(4);
    expect(result.candidates.map((c) => [c.layout, c.variant])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    const best = Math.max(...result.candidates.map((c) => c.score));
    expect(result.candidates[result.winner]!.score).toBe(best);
    expect(result.ranking[0]).toBe(result.winner);
    for (const c of result.candidates) {
      expect(c.ctaShare).toBeGreaterThan(0); // attention rules ran
      expect(c.report.rules.some((r) => r.ruleId === 'attention-competition')).toBe(true);
    }
    // The loop starts from the winner and never ends worse.
    expect(result.loop.history[0]!.design).toEqual(result.candidates[result.winner]!.design);
    expect(result.final.report.score).toBeGreaterThanOrEqual(
      result.candidates[result.winner]!.score,
    );

    expect(events.map((e) => e.type).filter((t) => t !== 'image' && t !== 'iteration')).toEqual([
      'plan',
      'candidate',
      'candidate',
      'candidate',
      'candidate',
      'winner',
    ]);
    expect(result.spend).toMatchObject({ totalUsd: 0, llmUsd: 0, imageUsd: 0 });
  });

  it('writes the design, every candidate, the record and a manifest with provenance for each image', async () => {
    const dir = tempDir();
    const { result } = await run(dir);

    const written = await loadDesign(result.out);
    expect(written.design).toEqual(result.final.design);
    for (const el of written.design.elements) {
      if (el.type === 'image') expect(existsSync(join(dir, el.src))).toBe(true); // relative srcs resolve
    }
    expect(readdirSync(join(dir, 'charity.candidates')).sort()).toEqual([
      'candidate-1.json',
      'candidate-2.json',
      'candidate-3.json',
      'candidate-4.json',
    ]);
    const candidate = await loadDesign(join(dir, 'charity.candidates', 'candidate-1.json'));
    for (const el of candidate.design.elements) {
      if (el.type === 'image')
        expect(existsSync(join(dir, 'charity.candidates', el.src))).toBe(true);
    }

    const manifest = JSON.parse(readFileSync(result.manifestFile, 'utf8'));
    // 2 layouts x 2 backgrounds, plus 1 subject (layout 1 only; reused by both its candidates).
    expect(manifest.images).toHaveLength(5);
    for (const entry of manifest.images) {
      expect(entry).toMatchObject({
        provider: 'mock',
        model: 'mock-gradient-v1',
        costUsd: 0,
        license: expect.any(String),
      });
      expect(entry.prompt).toMatch(/No text, no letters/);
      expect(typeof entry.seed).toBe('number');
      expect(existsSync(join(result.assetsDir, entry.file))).toBe(true);
    }
    const subject = manifest.images.find((e: { kind: string }) => e.kind === 'subject');
    expect(subject.cutout).toMatchObject({ remover: 'backdrop-key' });

    const record = JSON.parse(readFileSync(result.generationFile, 'utf8'));
    expect(record).toMatchObject({
      prompt: result.prompt,
      winner: result.winner,
      ranking: result.ranking,
    });
    expect(record.candidates).toHaveLength(4);
    expect(record.loop.history.length).toBeGreaterThan(0);
  });

  it('is reproducible: same prompt, same seeds, same scores', async () => {
    const a = await run(tempDir());
    const b = await run(tempDir());
    expect(b.result.candidates.map((c) => c.score)).toEqual(
      a.result.candidates.map((c) => c.score),
    );
  });

  it('switches to the mock provider when a paid image would break the spend cap', async () => {
    const mock = createMockImageProvider({ megapixels: 0.1 });
    const paid: ImageProvider = {
      ...mock,
      id: 'paid',
      estimateCostUsd: () => 0.5,
      generate: async (r) => ({ ...(await mock.generate(r)), provider: 'paid', costUsd: 0.5 }),
    };
    const ledger = createMemoryLedger(1);
    const { result } = await run(tempDir(), { provider: paid, ledger, candidates: 2, layouts: 1 });
    const manifest = JSON.parse(readFileSync(result.manifestFile, 'utf8'));
    const providers = manifest.images.map((e: { provider: string }) => e.provider);
    expect(providers.filter((p: string) => p === 'paid')).toHaveLength(2);
    expect(providers).toContain('mock');
    expect(ledger.spentUsd()).toBe(1);
    expect(result.warnings.join('\n')).toMatch(/Spend cap reached.*mock image provider/);
  });

  it('uses supplied images (a logo) without generating or changing them', async () => {
    const dir = tempDir();
    const logo = join(dir, 'logo.png');
    const { createCanvas } = await import('@napi-rs/canvas');
    const c = createCanvas(400, 100);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 100);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(logo, await c.encode('png'));
    const { result } = await run(dir, {
      candidates: 1,
      userImages: [{ id: 'logo', path: logo, use: 'logo' }],
    });
    const el = result.final.design.elements.find((e) => e.role === 'logo');
    expect(el).toMatchObject({ type: 'image', naturalWidth: 400, naturalHeight: 100 });
    const manifest = JSON.parse(readFileSync(result.manifestFile, 'utf8'));
    expect(manifest.images.find((e: { kind: string }) => e.kind === 'user')).toMatchObject({
      provider: 'user',
      costUsd: 0,
    });
  });

  it('lets the fix loop regenerate a generated background, records it and caps it', async () => {
    const dir = tempDir();
    const regen = (brief: string) => ({
      summary: 'Calm the background behind the text.',
      edits: [
        {
          op: 'regenerateImage',
          elementId: 'background',
          brief,
          reason: 'busy behind the headline',
        },
      ],
    });
    const editor = createScriptedEditor([
      regen('calmer one'),
      regen('calmer two'),
      regen('calmer three'),
    ]);
    const { result } = await run(dir, {
      candidates: 1,
      layouts: 1,
      editor,
      maxIterations: 3,
      target: 101, // never reached, so every scripted step runs
      maxRegenerations: 2,
    });
    const regenerations = result.loop.history.flatMap((h) => h.regenerations ?? []);
    expect(regenerations.map((r) => r.status)).toEqual(['applied', 'applied', 'rejected']);
    expect(result.loop.totals.regenerations).toBe(2);
    // The editor was told which images it may regenerate, with their briefs.
    expect(editor.requests[0]!.regeneration?.images).toEqual([
      expect.objectContaining({
        elementId: 'background',
        kind: 'background',
        brief: expect.stringContaining('mood'),
      }),
      expect.objectContaining({ elementId: 'subject', kind: 'subject', role: 'product' }),
    ]);
    const manifest = JSON.parse(readFileSync(result.manifestFile, 'utf8'));
    const regenerated = manifest.images.filter((e: { regeneration?: unknown }) => e.regeneration);
    expect(regenerated).toHaveLength(2);
    expect(regenerated[0]).toMatchObject({
      key: 'regen/background/1',
      regeneration: {
        reason: 'busy behind the headline',
        replaces: expect.stringContaining('layout1-background-v1'),
      },
    });
    expect(regenerated[0].prompt).toMatch(/^calmer one\. Text will be placed over/);
    const record = JSON.parse(readFileSync(result.generationFile, 'utf8'));
    expect(
      record.loop.history.flatMap((h: { regenerations?: unknown[] }) => h.regenerations ?? []),
    ).toHaveLength(3);
  });

  it('never regenerates when maxRegenerations is 0', async () => {
    const editor = createScriptedEditor([
      {
        summary: 's',
        edits: [{ op: 'regenerateImage', elementId: 'background', brief: 'b', reason: 'r' }],
      },
      {
        summary: 's',
        edits: [{ op: 'regenerateImage', elementId: 'background', brief: 'b', reason: 'r' }],
      },
    ]);
    const { result } = await run(tempDir(), {
      candidates: 1,
      layouts: 1,
      editor,
      maxIterations: 1,
      target: 101,
      maxRegenerations: 0,
    });
    expect(result.loop.history[1]!.status).toBe('invalid');
    expect(editor.requests[0]!.regeneration).toBeUndefined();
  });
});
