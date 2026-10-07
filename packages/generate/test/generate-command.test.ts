import { stripVTControlCharacters } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSuggestedFixesEditor } from '@simonlunay/redline-agent';
import { describe, expect, it } from 'vitest';
import { createTemplateArtDirector } from '../src/director/template.js';
import { createBackdropKeyRemover } from '../src/node/cutout.js';
import {
  GenerateUsageError,
  parseSize,
  runGenerateCommand,
  slugify,
} from '../src/node/generate-command.js';
import type { GenerateCommandIO } from '../src/node/generate-command.js';
import { createMockImageProvider } from '../src/node/mock-provider.js';
import { brightnessSaliency, tempDir } from './helpers.js';

/** Never reads the real environment or .env, and injects offline parts, so nothing can spend money. */
function io(extra: Partial<GenerateCommandIO> = {}) {
  const out: string[] = [];
  return {
    out,
    io: {
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => out.push(t),
      env: {},
      dotenvPath: null,
      saliency: brightnessSaliency(),
      ...extra,
    } satisfies GenerateCommandIO,
  };
}

const offline = () => ({
  director: createTemplateArtDirector(),
  provider: createMockImageProvider({ megapixels: 0.1 }),
  remover: createBackdropKeyRemover(),
  editor: createSuggestedFixesEditor(),
});

describe('redline generate', () => {
  it('prints the plan, candidates, winner and fix loop, and writes the contact sheet', async () => {
    const dir = tempDir();
    const steps = join(dir, 'steps');
    const { out, io: testIO } = io(offline());
    const code = await runGenerateCommand(
      [
        'poster for a charity 5K, energetic, blue and orange',
        '--out',
        join(dir, 'd.json'),
        '--size',
        '1080x1080',
        '--candidates',
        '3',
        '--render-steps',
        steps,
      ],
      testIO,
    );
    const text = stripVTControlCharacters(out.join('\n'));
    expect(text).toContain('redline generate');
    expect(text).toContain('Charity 5K');
    expect(text).toMatch(/Candidates[\s\S]*#1[\s\S]*#2[\s\S]*#3/);
    expect(text).toMatch(/Winner: candidate \d of 3/);
    expect(text).toMatch(/#0\s+start/);
    expect(text).toMatch(/first candidate \d+ → best of 3 \d+ → final \d+/);
    expect(code).toBe(text.includes('✔') ? 0 : 1);
    const files = readdirSync(steps);
    expect(files).toContain('contact-sheet.png');
    expect(files).toContain('candidate-3.png');
    expect(files).toContain('candidate-1.heatmap.png');
    expect(files).toContain('final.png');
    expect(files.some((f) => f.startsWith('fix-00-initial'))).toBe(true);
    expect(existsSync(join(dir, 'd.generation.json'))).toBe(true);
  }, 60_000);

  it('prints the full record as JSON with --format json', async () => {
    const dir = tempDir();
    const { out, io: testIO } = io(offline());
    await runGenerateCommand(
      [
        'banner for a SaaS launch',
        '--out',
        join(dir, 'b.json'),
        '--size',
        '1200x628',
        '--candidates',
        '1',
        '--format',
        'json',
        '--no-attention',
      ],
      testIO,
    );
    const record = JSON.parse(out.join(''));
    expect(record).toMatchObject({
      prompt: 'banner for a SaaS launch',
      canvas: { width: 1200, height: 628 },
      winner: 0,
    });
    expect(record.candidates[0].ctaShare).toBeUndefined(); // attention off
  });

  it('rejects bad usage before doing any work', async () => {
    const { io: testIO } = io();
    await expect(runGenerateCommand([], testIO)).rejects.toThrow(/Missing prompt/);
    await expect(runGenerateCommand(['x', '--size', 'big'], testIO)).rejects.toThrow(
      GenerateUsageError,
    );
    await expect(runGenerateCommand(['x', '--candidates', '0'], testIO)).rejects.toThrow(
      /--candidates/,
    );
    await expect(runGenerateCommand(['x', '--brand-colors', 'blue'], testIO)).rejects.toThrow(
      /not a hex color/,
    );
    // No ANTHROPIC_API_KEY in the injected env: the default director can't run.
    await expect(runGenerateCommand(['x'], testIO)).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
    await expect(
      runGenerateCommand(['x', '--director', 'template', '--provider', 'replicate'], testIO),
    ).rejects.toThrow(/REPLICATE_API_TOKEN is not set/);
  });

  it('parses sizes and slugs', () => {
    expect(parseSize('1080x1920')).toEqual({ width: 1080, height: 1920 });
    expect(parseSize('1200 × 628')).toEqual({ width: 1200, height: 628 });
    expect(() => parseSize('10x10')).toThrow(/between 64 and 8000/);
    expect(slugify('Poster for a charity 5K, energetic!')).toBe(
      'poster-for-a-charity-5k-energetic',
    );
  });
});
