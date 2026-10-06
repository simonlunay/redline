import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { check } from '../src/core/check.js';
import { checkFile, loadDesign } from '../src/node/index.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));

/** Which rule each bad fixture was designed to trigger. */
const EXPECTED: Record<string, string[]> = {
  'competing-headline.json': ['hierarchy'],
  'low-contrast-on-image.json': ['text-contrast'],
  'misaligned.json': ['alignment'],
  'off-canvas.json': ['off-canvas'],
  'overlap-headline-product.json': ['unintended-overlap'],
  'stretched-image.json': ['image-aspect-ratio'],
  'text-overflow.json': ['text-overflow'],
  'tiny-text.json': ['min-text-size'],
};

describe('fixtures (Node env: real fonts + image pixels)', () => {
  it('has at least the clean poster, the worst case and one fixture per targeted rule', () => {
    expect(files).toEqual(
      expect.arrayContaining(['clean-poster.json', 'worst.json', ...Object.keys(EXPECTED)]),
    );
  });

  for (const file of files) {
    it(`${file} matches its report snapshot`, async () => {
      const { report, env } = await checkFile(FIXTURES + file);
      expect(env.warnings).toEqual([]);
      expect(report).toMatchSnapshot();
    });
  }

  it('the clean poster passes with a high score', async () => {
    const { report } = await checkFile(FIXTURES + 'clean-poster.json');
    expect(report.passed).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(90);
  });

  for (const [file, ruleIds] of Object.entries(EXPECTED)) {
    it(`${file} triggers ${ruleIds.join(', ')} and scores lower than the clean poster`, async () => {
      const { report } = await checkFile(FIXTURES + file);
      const triggered = new Set(report.issues.map((i) => i.ruleId));
      for (const id of ruleIds) expect(triggered).toContain(id);
      expect(report.score).toBeLessThan(100);
    });
  }

  it('the worst fixture fails most rules and scores very low', async () => {
    const { report } = await checkFile(FIXTURES + 'worst.json');
    const triggered = new Set(report.issues.map((i) => i.ruleId));
    expect(triggered.size).toBeGreaterThanOrEqual(8);
    expect(report.score).toBeLessThan(30);
  });
});

describe('fixtures (core only, no sampler)', () => {
  it('reports that contrast over an image cannot be verified', async () => {
    const { design } = await loadDesign(FIXTURES + 'low-contrast-on-image.json');
    const report = check(design);
    const contrast = report.issues.filter((i) => i.ruleId === 'text-contrast');
    expect(contrast.length).toBeGreaterThan(0);
    expect(contrast.every((i) => i.measured === 'unknown' && i.severity === 'warning')).toBe(true);
  });
});
