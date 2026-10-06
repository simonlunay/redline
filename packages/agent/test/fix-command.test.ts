import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDesign } from '@simonlunay/redline';
import { describe, expect, it } from 'vitest';
import { createScriptedEditor } from '../src/editors/scripted.js';
import { UsageError, runFixCommand } from '../src/node/fix-command.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

/** Captures output; never reads the real environment or .env, so no test can call the API. */
function io(
  extra: Parameters<typeof runFixCommand>[1] extends infer T ? Partial<NonNullable<T>> : never = {},
) {
  const out: string[] = [];
  return {
    out,
    io: {
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => out.push(t),
      env: {},
      dotenvPath: null,
      ...extra,
    },
  };
}

describe('redline fix', () => {
  it('runs the loop offline with --editor suggested, writes the result and step PNGs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'redline-fix-'));
    const outFile = join(dir, 'fixed.json');
    const steps = join(dir, 'steps');
    const { out, io: testIO } = io();
    const code = await runFixCommand(
      [
        FIXTURES + 'stretched-image.json',
        '--editor',
        'suggested',
        '--out',
        outFile,
        '--render-steps',
        steps,
      ],
      testIO,
    );
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/#0\s+start\s+84/);
    expect(text).toMatch(/#1\s+accepted\s+100/);
    expect(text).toMatch(/resize product to 700x466\.67/);
    expect(text).toContain('stop: no issues left');
    expect(text).not.toContain('LLM call');
    expect(parseDesign(JSON.parse(readFileSync(outFile, 'utf8'))).elements).toHaveLength(9);
    expect(readdirSync(steps)).toEqual(['00-initial.png', '01-accepted.png', 'final.png']);
  });

  it('prints the full result as JSON with --format json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'redline-fix-'));
    const { out, io: testIO } = io();
    const code = await runFixCommand(
      [
        FIXTURES + 'worst.json',
        '--editor',
        'suggested',
        '--format',
        'json',
        '--max-iterations',
        '1',
        '--out',
        join(dir, 'o.json'),
      ],
      testIO,
    );
    expect(code).toBe(1); // errors remain after one rules-only iteration
    const result = JSON.parse(out.join(''));
    expect(result).toMatchObject({ editor: 'suggested-fixes', stopReason: 'max-iterations' });
    expect(result.history).toHaveLength(2);
    expect(result.estimatedCostUsd).toBeNull();
  });

  it('uses an injected editor (how an LLM run is tested without an API)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'redline-fix-'));
    const editor = createScriptedEditor([
      {
        summary: 'Unstretch the photo',
        edits: [
          { op: 'resize', elementId: 'product', width: 600, height: 400, reason: 'natural 3:2' },
        ],
      },
    ]);
    const { out, io: testIO } = io({ editor });
    await runFixCommand([FIXTURES + 'stretched-image.json', '--out', join(dir, 'o.json')], testIO);
    expect(out.join('\n')).toContain('— natural 3:2');
    expect(editor.requests).toHaveLength(1);
  });

  it('fails clearly without an API key, and on bad flags', async () => {
    await expect(runFixCommand([FIXTURES + 'worst.json'], io().io)).rejects.toThrow(
      /ANTHROPIC_API_KEY is not set/,
    );
    await expect(
      runFixCommand([FIXTURES + 'worst.json', '--effort', 'extreme'], io().io),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(runFixCommand([], io().io)).rejects.toThrow(/Missing design file/);
  });
});
