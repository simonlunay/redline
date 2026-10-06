import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createFontMeasurer,
  createNodeEnv,
  loadDesign,
  renderAnnotatedPng,
  renderPng,
} from '../src/node/index.js';
import { check } from '../src/core/check.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf: Buffer) {
  expect(buf.subarray(1, 4).toString()).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--conditions=@simonlunay/source', '--import', 'tsx', CLI, ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

describe('font measurer', () => {
  it('measures real Inter metrics, wider for heavier weights', () => {
    const m = createFontMeasurer();
    const regular = m.measure('Hello World', { family: 'Inter', size: 40, weight: 400 });
    const black = m.measure('Hello World', { family: 'Inter', size: 40, weight: 900 });
    expect(regular).toBeCloseTo(218.9, 0);
    expect(black).toBeGreaterThan(regular);
  });

  it('falls back to the bundled font for unknown families', () => {
    const m = createFontMeasurer();
    const font = { size: 40, weight: 400 };
    expect(m.measure('Hello', { ...font, family: 'Nonexistent Sans' })).toBe(
      m.measure('Hello', { ...font, family: 'Inter' }),
    );
  });
});

describe('image sampler', () => {
  it('reads pixels from loaded images and reports missing files as warnings', async () => {
    const loaded = await loadDesign(FIXTURES + 'low-contrast-on-image.json');
    const env = await createNodeEnv(loaded);
    expect(env.sampler.has('images/sky.png')).toBe(true);
    // Top of sky.png is the light blue #bfe3ff.
    expect(env.sampler.sample('images/sky.png', 0.05, 0)).toEqual({ r: 191, g: 227, b: 255, a: 1 });

    const broken = { ...loaded, design: structuredClone(loaded.design) };
    const photo = broken.design.elements[0]!;
    if (photo.type === 'image') photo.src = 'images/nope.png';
    const brokenEnv = await createNodeEnv(broken);
    expect(brokenEnv.warnings[0]).toMatch(/Could not load image "images\/nope.png"/);
  });
});

describe('renderer', () => {
  it('renders PNGs at canvas size; annotated adds a header strip', async () => {
    const loaded = await loadDesign(FIXTURES + 'worst.json');
    const env = await createNodeEnv(loaded);
    expect(pngSize(renderPng(loaded.design, { images: env.images }))).toEqual({
      width: 1080,
      height: 1080,
    });
    expect(pngSize(renderPng(loaded.design, { images: env.images, scale: 0.5 }))).toEqual({
      width: 540,
      height: 540,
    });
    const report = check(loaded.design, { measurer: env.measurer, sampler: env.sampler });
    const annotated = pngSize(renderAnnotatedPng(loaded.design, report, { images: env.images }));
    expect(annotated.width).toBe(1080);
    expect(annotated.height).toBeGreaterThan(1080);
  });
});

describe('cli', () => {
  it('exits 0 for a clean design and prints a pretty report', () => {
    const { code, stdout } = runCli(['check', FIXTURES + 'clean-poster.json']);
    expect(code).toBe(0);
    expect(stdout).toContain('Score 100/100');
    expect(stdout).toContain('No errors.');
  });

  it('exits 1 when errors are found, with valid JSON output', () => {
    const { code, stdout } = runCli([
      'check',
      FIXTURES + 'stretched-image.json',
      '--format',
      'json',
    ]);
    expect(code).toBe(1);
    const report = JSON.parse(stdout);
    expect(report.passed).toBe(false);
    expect(report.issues[0].ruleId).toBe('image-aspect-ratio');
  });

  it('applies a config file and writes PNGs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redline-'));
    const config = join(dir, 'redline.json');
    writeFileSync(config, JSON.stringify({ rules: { 'image-aspect-ratio': 'off' } }));
    const out = join(dir, 'out.png');
    const annotated = join(dir, 'annotated.png');
    const { code } = runCli([
      'check',
      FIXTURES + 'stretched-image.json',
      '--config',
      config,
      '--render',
      out,
      '--annotate',
      annotated,
    ]);
    expect(code).toBe(0);
    expect(pngSize(readFileSync(out)).width).toBe(1080);
    expect(pngSize(readFileSync(annotated)).width).toBe(1080);
  });

  it('delegates `redline fix` to the agent package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redline-'));
    const out = join(dir, 'fixed.json');
    const { code, stdout } = runCli([
      'fix',
      FIXTURES + 'stretched-image.json',
      '--editor',
      'suggested',
      '--out',
      out,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('redline fix');
    expect(JSON.parse(readFileSync(out, 'utf8')).version).toBe('0.1');
    expect(runCli(['fix']).code).toBe(2);
  });

  it('exits 2 for invalid designs and usage errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redline-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ version: '0.1', canvas: { width: 0 } }));
    const invalid = runCli(['check', bad]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('Invalid design');
    expect(runCli(['frobnicate']).code).toBe(2);
    expect(runCli(['check', FIXTURES + 'clean-poster.json', '--format', 'xml']).code).toBe(2);
  });
});

describe('render capability', () => {
  it('createNodeEnv provides a raster renderer for checkAsync rules', async () => {
    const loaded = await loadDesign(FIXTURES + 'clean-poster.json');
    const env = await createNodeEnv(loaded);
    const raster = await env.render(loaded.design);
    expect(raster.width).toBe(1080);
    expect(raster.height).toBe(1350);
    expect(raster.data.length).toBe(1080 * 1350 * 4);
    // Top-left pixel is the poster's #0f172a background.
    expect([...raster.data.subarray(0, 4)]).toEqual([15, 23, 42, 255]);
  });
});
