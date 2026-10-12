// Records the README demo from the real player: npm run demo-video -w apps/web
//
// Needs a built site (npm run build -w apps/web) and ffmpeg on the PATH. It serves out/, plays
// the yoga-retreat run (after shadow tuning) in Chromium with Playwright's video capture, turns
// the heatmap on for the final design, then writes docs/media/redline-demo.mp4 (H.264) and
// docs/media/redline-demo.gif (for the README: GitHub only plays GIFs inline from a repo).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const WEB = fileURLToPath(new URL('../', import.meta.url));
const MEDIA = fileURLToPath(new URL('../../../docs/media/', import.meta.url));
const RUN = process.env.DEMO_RUN ?? 'yoga-retreat-tuned';
const PORT = 4175;
const SIZE = { width: 1280, height: 760 };
const GIF_WIDTH = 880;
const GIF_FPS = 12;
const MAX_GIF_BYTES = 10 * 1024 * 1024;

const server = spawn(process.execPath, [join(WEB, 'scripts', 'serve-static.mjs'), String(PORT)], {
  stdio: 'ignore',
});
const tmp = mkdtempSync(join(tmpdir(), 'redline-demo-'));

try {
  await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    recordVideo: { dir: tmp, size: SIZE },
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/runs/${RUN}/?speed=2`, { waitUntil: 'networkidle' });
  // Start where the stage and the timeline are both in view, once fonts and images are in.
  await page.evaluate(() =>
    window.scrollTo(
      0,
      document.querySelector('.player')?.getBoundingClientRect().top + window.scrollY - 16,
    ),
  );
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForFunction(
    () => document.querySelector('.track')?.getAttribute('aria-valuetext')?.startsWith('Final'),
    null,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(900);
  await page.getByLabel('Predicted attention').check();
  await page.waitForTimeout(2600);
  const video = page.video();
  await context.close();
  await browser.close();
  const webm = await video.path();

  mkdirSync(MEDIA, { recursive: true });
  const mp4 = join(MEDIA, 'redline-demo.mp4');
  const gif = join(MEDIA, 'redline-demo.gif');
  // The first ~1.2 s is page load and the scroll; trim it.
  const trim = ['-ss', '1.2'];
  run('ffmpeg', [
    '-y',
    ...trim,
    '-i',
    webm,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '24',
    '-movflags',
    '+faststart',
    '-an',
    mp4,
  ]);
  const palette = join(tmp, 'palette.png');
  const scale = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  run('ffmpeg', [
    '-y',
    ...trim,
    '-i',
    webm,
    '-vf',
    `${scale},palettegen=max_colors=160:stats_mode=diff`,
    palette,
  ]);
  run('ffmpeg', [
    '-y',
    ...trim,
    '-i',
    webm,
    '-i',
    palette,
    '-lavfi',
    `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    gif,
  ]);
  for (const f of [mp4, gif])
    console.log(`${f}: ${(statSync(f).size / 1024 / 1024).toFixed(2)} MB`);
  if (statSync(gif).size > MAX_GIF_BYTES) {
    console.error('The GIF is over 10 MB.');
    process.exitCode = 1;
  }
} finally {
  server.kill();
  for (const f of readdirSync(tmp)) rmSync(join(tmp, f), { force: true });
  rmSync(tmp, { recursive: true, force: true });
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.status !== 0)
    throw new Error(`${cmd} failed: ${result.stderr.toString().slice(-800)}`);
}
