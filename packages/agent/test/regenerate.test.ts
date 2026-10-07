import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDesign } from '@simonlunay/redline';
import type { Design, Report } from '@simonlunay/redline';
import { describe, expect, it } from 'vitest';
import { submitEditsTool } from '../src/editors/anthropic.js';
import { createScriptedEditor } from '../src/editors/scripted.js';
import { parseEditResponse, protectedFieldViolations } from '../src/edits.js';
import { runFixLoop } from '../src/loop.js';
import type { RegenerateOptions } from '../src/loop.js';
import { runFixCommand } from '../src/node/fix-command.js';
import { buildSystemPrompt, buildUserMessage } from '../src/prompt.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

const design: Design = parseDesign({
  version: '0.1',
  canvas: { width: 1000, height: 1000, background: '#000000' },
  elements: [
    {
      id: 'bg',
      type: 'image',
      role: 'background',
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
      src: 'busy.png',
      naturalWidth: 1000,
      naturalHeight: 1000,
      fit: 'cover',
    },
    {
      id: 'headline',
      type: 'text',
      role: 'headline',
      x: 100,
      y: 100,
      width: 800,
      height: 120,
      content: 'Hello',
      fontSize: 100,
      color: '#ffffff',
    },
  ],
});

/** A check that only cares about the background: "calm" images pass, anything else has an error. */
const checkBySrc =
  (scores: Record<string, number>) =>
  async (d: Design): Promise<Report> => {
    const bg = d.elements.find((e) => e.id === 'bg');
    const src = bg?.type === 'image' ? bg.src : '';
    const score = scores[src] ?? 60;
    const failing = score < 100;
    return {
      score,
      passed: !failing,
      summary: { errors: failing ? 1 : 0, warnings: 0, infos: 0 },
      rules: [],
      issues: failing
        ? [
            {
              ruleId: 'text-contrast',
              severity: 'error',
              elementIds: ['headline'],
              message: 'busy behind the headline',
              measured: 2,
              threshold: 3,
            },
          ]
        : [],
    };
  };

const regen = (srcs: string[], max?: number) => {
  const calls: { elementId: string; brief: string; reason: string; iteration: number }[] = [];
  const options: RegenerateOptions = {
    ...(max !== undefined ? { max } : {}),
    images: (d) =>
      d.elements
        .filter((e) => e.id === 'bg')
        .map(() => ({
          elementId: 'bg',
          kind: 'background' as const,
          role: 'background',
          brief: 'a busy street',
        })),
    run: async ({ elementId, brief, reason, iteration }) => {
      calls.push({ elementId, brief, reason, iteration });
      const src = srcs[calls.length - 1];
      if (!src) throw new Error('provider down');
      return { src, naturalWidth: 1200, naturalHeight: 1000, costUsd: 0.003 };
    },
  };
  return { options, calls };
};

const regenerateBg = (brief = 'a calm street, top third plain') => ({
  summary: 'The photo is busy behind the headline; regenerate it.',
  edits: [
    { op: 'regenerateImage', elementId: 'bg', brief, reason: 'contrast fails on the busy sky' },
  ],
});

describe('regenerateImage in generation mode', () => {
  it('replaces the image, records the regeneration and accepts a better score', async () => {
    const { options, calls } = regen(['calm.png']);
    const editor = createScriptedEditor([regenerateBg()]);
    const result = await runFixLoop(design, {
      editor,
      check: checkBySrc({ 'calm.png': 100 }),
      target: 95,
      regenerate: options,
    });

    expect(calls).toEqual([
      {
        elementId: 'bg',
        brief: 'a calm street, top third plain',
        reason: 'contrast fails on the busy sky',
        iteration: 1,
      },
    ]);
    const step = result.history[1]!;
    expect(step.status).toBe('accepted');
    expect(step.regenerations).toEqual([
      {
        elementId: 'bg',
        brief: 'a calm street, top third plain',
        reason: 'contrast fails on the busy sky',
        status: 'applied',
        previousSrc: 'busy.png',
        src: 'calm.png',
        costUsd: 0.003,
      },
    ]);
    const bg = result.best.design.elements.find((e) => e.id === 'bg')!;
    expect(bg).toMatchObject({ src: 'calm.png', naturalWidth: 1200, fit: 'cover' });
    expect(result.totals.regenerations).toBe(1);
    expect(result.stopReason).toBe('no-issues');
    // The editor saw the regenerable images and the remaining budget.
    expect(editor.requests[0]!.regeneration).toEqual({
      images: [{ elementId: 'bg', kind: 'background', role: 'background', brief: 'a busy street' }],
      remaining: 2,
      max: 2,
    });
  });

  it('caps regenerations per run and rejects the rest with a reason', async () => {
    const { options, calls } = regen(['b.png', 'c.png', 'd.png'], 2);
    const editor = createScriptedEditor([
      regenerateBg('one'),
      regenerateBg('two'),
      regenerateBg('three'),
    ]);
    // Every new image is a bit better, but never good enough to stop.
    const result = await runFixLoop(design, {
      editor,
      check: checkBySrc({ 'b.png': 70, 'c.png': 80, 'd.png': 90 }),
      target: 95,
      maxIterations: 3,
      maxStaleIterations: 5,
      regenerate: options,
    });
    expect(calls.map((c) => c.brief)).toEqual(['one', 'two']);
    expect(result.totals.regenerations).toBe(2);
    const third = result.history[3]!;
    expect(third.regenerations).toEqual([
      expect.objectContaining({
        status: 'rejected',
        note: expect.stringMatching(/cap reached \(2 per run\)/),
      }),
    ]);
    expect(third.status).toBe('rolled-back'); // nothing could be applied
    expect(editor.requests[2]!.regeneration?.remaining).toBe(0);
    expect(buildUserMessage(editor.requests[2]!)).toContain(
      'No regenerations left; use layout edits only.',
    );
  });

  it('counts a regeneration that made things worse, and rolls the image back', async () => {
    const { options } = regen(['worse.png']);
    const result = await runFixLoop(design, {
      editor: createScriptedEditor([regenerateBg()]),
      check: checkBySrc({ 'busy.png': 70, 'worse.png': 40 }),
      maxIterations: 1,
      regenerate: options,
    });
    expect(result.history[1]).toMatchObject({
      status: 'rolled-back',
      regenerations: [{ status: 'applied', src: 'worse.png' }],
    });
    expect(result.best.design.elements.find((e) => e.id === 'bg')).toMatchObject({
      src: 'busy.png',
    });
    expect(result.totals.regenerations).toBe(1);
  });

  it('records failed regenerations and refuses images that are not regenerable', async () => {
    const { options } = regen([]);
    const editor = createScriptedEditor([
      {
        summary: 's',
        edits: [
          { op: 'regenerateImage', elementId: 'headline', brief: 'x', reason: 'r' },
          { op: 'regenerateImage', elementId: 'bg', brief: 'y', reason: 'r' },
        ],
      },
    ]);
    const result = await runFixLoop(design, {
      editor,
      check: checkBySrc({}),
      maxIterations: 1,
      regenerate: options,
    });
    expect(result.history[1]!.regenerations).toEqual([
      expect.objectContaining({
        elementId: 'headline',
        status: 'rejected',
        note: expect.stringMatching(/not a regenerable image/),
      }),
      expect.objectContaining({ elementId: 'bg', status: 'failed', note: 'provider down' }),
    ]);
  });

  it('only exists in the generation tool schema and prompt', () => {
    const plain = JSON.stringify(submitEditsTool().input_schema);
    const generation = JSON.stringify(submitEditsTool({ generation: true }).input_schema);
    expect(plain).not.toContain('regenerateImage');
    expect(generation).toContain('regenerateImage');
    expect(buildSystemPrompt()).not.toContain('regenerateImage');
    expect(buildSystemPrompt({ generation: true })).toContain(
      'regenerateImage {elementId, brief, reason}',
    );
  });
});

describe('redline fix still refuses image changes', () => {
  it('rejects regenerateImage outside generation mode', () => {
    const result = parseEditResponse(regenerateBg());
    expect(result.ok).toBe(false);
    expect(parseEditResponse(regenerateBg(), { regenerate: true }).ok).toBe(true);
  });

  it('treats a regeneration request in the plain loop as an invalid response', async () => {
    const editor = createScriptedEditor([regenerateBg(), regenerateBg()]);
    const result = await runFixLoop(design, { editor, check: checkBySrc({}), maxIterations: 1 });
    expect(result.history[1]!.status).toBe('invalid');
    expect(result.best.design).toEqual(design);
  });

  it('still flags any src change in the guardrail unless explicitly allowed', () => {
    const changed = {
      ...design,
      elements: design.elements.map((e) => (e.type === 'image' ? { ...e, src: 'other.png' } : e)),
    };
    expect(protectedFieldViolations(design, changed)).toEqual(['"bg".src changed']);
    expect(protectedFieldViolations(design, changed, new Set(['bg']))).toEqual([]);
  });

  it('redline fix on a user design keeps every image src, even if the editor asks to regenerate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'redline-fix-regen-'));
    const out = join(dir, 'fixed.json');
    const editor = createScriptedEditor([
      {
        summary: 'regen',
        edits: [{ op: 'regenerateImage', elementId: 'photo', brief: 'calmer', reason: 'contrast' }],
      },
      {
        summary: 'regen',
        edits: [{ op: 'regenerateImage', elementId: 'photo', brief: 'calmer', reason: 'contrast' }],
      },
    ]);
    const lines: string[] = [];
    await runFixCommand(
      [FIXTURES + 'low-contrast-on-image.json', '--out', out, '--max-iterations', '1'],
      {
        stdout: (t) => lines.push(t),
        stderr: (t) => lines.push(t),
        editor,
        env: {},
        dotenvPath: null,
      },
    );
    const original = JSON.parse(readFileSync(FIXTURES + 'low-contrast-on-image.json', 'utf8'));
    const fixed = JSON.parse(readFileSync(out, 'utf8'));
    const srcs = (d: { elements: { type: string; src?: string }[] }) =>
      d.elements.filter((e) => e.type === 'image').map((e) => e.src);
    expect(srcs(fixed)).toEqual(srcs(original));
    expect(lines.join('\n')).toMatch(/invalid/);
    expect(editor.requests[0]!.regeneration).toBeUndefined();
  });
});
