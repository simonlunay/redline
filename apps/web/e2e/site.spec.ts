import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GalleryIndex, SampleRecord } from '../src/lib/gallery/types';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const index = JSON.parse(readFileSync(`${PUBLIC}gallery/index.json`, 'utf8')) as GalleryIndex;
const sample = (id: string) =>
  JSON.parse(readFileSync(`${PUBLIC}samples/${id}/sample.json`, 'utf8')) as SampleRecord;

/** Fails the test on console errors and on any request that leaves the site. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) &&
      !url.protocol.startsWith('data') &&
      !url.protocol.startsWith('blob')
    ) {
      problems.push(`external request: ${r.url()}`);
    }
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  return problems;
}

async function liveScore(page: Page): Promise<number> {
  const text = await page.locator('.player-side .score-number').first().innerText();
  return Number(text.replace(/\/100.*/s, '').trim());
}

test('landing page: real numbers, the demo plays, nothing leaves the site', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Redline checks a design');
  await expect(page.getByText('62.1 → 98.8')).toBeVisible();
  await expect(page.getByText('40 of 42')).toBeVisible();
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  // The demo advances on its own.
  const label = page.locator('.hero-demo .track').first();
  const first = await label.getAttribute('aria-valuenow');
  await expect
    .poll(async () => label.getAttribute('aria-valuenow'), { timeout: 15_000 })
    .not.toBe(first);
  expect(problems).toEqual([]);
});

test('the hero plays the generate pipeline, from the typed prompt to the candidates', async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto('/');
  const hero = page.locator('.hero-demo');
  await expect(hero.locator('.prompt-line')).toContainText('ad for a weekend yoga retreat', {
    timeout: 20_000,
  });
  await expect(hero.getByText(/4 candidates, scored by the rules/)).toBeVisible({
    timeout: 20_000,
  });
  // The heatmap is on while the candidates are scored.
  await expect(hero.locator('.stage .heat')).toHaveCSS('opacity', /0\.8/);
  await expect(hero.getByText(/Vision judge/)).toBeVisible({ timeout: 20_000 });
  expect(problems).toEqual([]);
});

test('How it works: every stage opens the replay at its moment', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  const stages = page.locator('.pipeline > li');
  await expect(stages).toHaveCount(8);
  const expected: [number, RegExp][] = [
    [0, /^The prompt$/],
    [1, /^Art director/],
    [3, /^Best of 4$/],
    [5, /^Vision judge, review 1/],
    [6, /^Fix 1 of 1$/],
    [7, /^Result$/],
  ];
  // Collect the links first: following one leaves the landing page.
  const hrefs = await stages
    .locator('.pipeline-link')
    .evaluateAll((links) => links.map((a) => a.getAttribute('href')));
  expect(hrefs).toHaveLength(8);
  for (const [i, label] of expected) {
    const href = hrefs[i]!;
    expect(href).toMatch(/^\/runs\/yoga-retreat-tuned\/\?frame=\d+/);
    await page.goto(href);
    await expect(page.locator('.player-side .label').first()).toHaveText(label);
  }
  expect(problems).toEqual([]);
});

test('gallery lists every run, strongest first, with honest labels', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/gallery/');
  const cards = page.locator('.run-card');
  await expect(cards).toHaveCount(index.runs.length);
  await expect(cards.first().locator('.run-title')).toHaveText(index.runs[0]!.title);
  await expect(page.getByText('Judge: needs fixes').first()).toBeVisible();
  expect(problems).toEqual([]);
});

test('a run replays: seek with the keyboard, the panel follows, the heatmap draws', async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto('/runs/yoga-retreat-tuned/');
  const track = page.getByRole('slider', { name: 'Run timeline' });
  await expect(track).toHaveAttribute('aria-valuenow', '1');
  await expect(page.locator('.player-side .label').first()).toHaveText('The prompt');
  await track.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: 'The plan' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: /Candidate 1 of 4/ })).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('heading', { name: 'The judge would ship it' })).toBeVisible();
  await page.getByLabel('Predicted attention').check();
  await expect(page.locator('.stage .heat')).toHaveCSS('opacity', /0\.8/);
  // Seeking back lands on the same frame as stepping did.
  await track.focus();
  await page.keyboard.press('Home');
  await expect(track).toHaveAttribute('aria-valuenow', '1');
  expect(problems).toEqual([]);
});

test('every run page loads without errors', async ({ page }) => {
  // 22 pages in one test: more than the default 60 s when the machine is busy.
  test.setTimeout(180_000);
  const problems = watch(page);
  for (const run of index.runs) {
    // Frame 3 has a design on the stage in every run (generate runs open on the prompt and plan).
    await page.goto(`/runs/${run.id}/?frame=3`);
    await expect(page.locator('.player-side .score-number').first()).toBeVisible();
  }
  expect(problems).toEqual([]);
});

test.describe("the browser's checker matches the stored reports", () => {
  for (const s of index.samples) {
    test(s.id, async ({ page }) => {
      const problems = watch(page);
      await page.goto(`/check/?sample=${s.id}`);
      await expect(page.locator('.player-side .score-number')).toBeVisible();
      // The design fonts loaded and measure like the CLI (hinting would fail this).
      await expect(page.locator('.font-warning')).toHaveCount(0);
      const stored = sample(s.id).snapshot.report;
      await expect.poll(() => liveScore(page)).toBe(stored.score);
      const live = await page.locator('.issues .issue').allInnerTexts();
      expect(live).toHaveLength(stored.issues.length);
      stored.issues.forEach((issue, i) => expect(live[i]).toContain(issue.message));
      expect(problems).toEqual([]);
    });
  }
});

test('editing re-checks, undo restores, and the rules-only fix runs offline', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/check/?sample=worst');
  await expect.poll(() => liveScore(page)).toBe(sample('worst').snapshot.report.score);

  // Drag the headline far off the canvas: the score must change.
  const stage = page.locator('.stage.editable');
  const box = (await stage.boundingBox())!;
  const headline = sample('worst').snapshot.design.elements.find((e) => e.role === 'headline')!;
  const W = sample('worst').snapshot.design.canvas.width;
  const sx = box.x + ((headline.x + headline.width / 2) / W) * box.width;
  const sy = box.y + ((headline.y + headline.height / 2) / W) * box.width;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx - box.width * 0.9, sy, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByText(/Layout rules only now/)).toBeVisible();
  const afterDrag = await liveScore(page);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => liveScore(page)).toBe(sample('worst').snapshot.report.score);
  expect(afterDrag).not.toBe(sample('worst').snapshot.report.score);

  await page.getByRole('button', { name: 'Fix it with the rules (no AI)' }).click();
  await expect(page.getByRole('status')).toContainText('Rules only:');
  expect(await liveScore(page)).toBeGreaterThan(sample('worst').snapshot.report.score);
  expect(problems).toEqual([]);
});

test('upload: a design with embedded images opens; a file path is refused with a reason', async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto('/check/?sample=clean-poster');
  const design = sample('clean-poster').snapshot.design;
  const image = design.elements.find((e) => e.type === 'image');
  if (image?.type !== 'image') throw new Error('clean-poster has no image');
  const png = readFileSync(`${PUBLIC}samples/clean-poster/${image.src}`);
  const embedded = {
    ...design,
    elements: design.elements.map((el) =>
      el.type === 'image' ? { ...el, src: `data:image/png;base64,${png.toString('base64')}` } : el,
    ),
  };
  const input = page.locator('input[type=file]');
  await input.setInputFiles({
    name: 'mine.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(embedded)),
  });
  await expect(page.getByLabel('Design mine, editable')).toBeVisible();
  await expect.poll(() => liveScore(page)).toBeGreaterThan(0);

  await input.setInputFiles({
    name: 'paths.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(design)),
  });
  await expect(page.locator('.alert')).toContainText('data URLs');
  expect(problems).toEqual([]);
});

test('export: PNG at full size and self-contained JSON', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/check/?sample=worst');
  await expect.poll(() => liveScore(page)).toBe(sample('worst').snapshot.report.score);
  const [png] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export PNG' }).click(),
  ]);
  const pngBytes = readFileSync((await png.path())!);
  expect(pngBytes.readUInt32BE(16)).toBe(1080);
  expect(pngBytes.readUInt32BE(20)).toBe(1080);
  const [json] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export JSON' }).click(),
  ]);
  const exported = JSON.parse(readFileSync((await json.path())!, 'utf8')) as {
    elements: { type: string; src?: string }[];
  };
  for (const el of exported.elements)
    if (el.type === 'image') expect(el.src).toMatch(/^data:image\//);
  expect(problems).toEqual([]);
});
