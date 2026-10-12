// Puts the checker's bundled Inter files into public/fonts as WOFF2, so the browser measures and
// draws designs with exactly the fonts the CLI uses. WOFF2 is a lossless repackaging of the same
// font tables (glyph advances are identical), at about a third of the TTF's size; the end-to-end
// parity test checks that browser scores still match the CLI's. Runs before dev and build.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import wawoff2 from 'wawoff2';

const from = fileURLToPath(new URL('../../../packages/checker/fonts/', import.meta.url));
const to = fileURLToPath(new URL('../public/fonts/', import.meta.url));
mkdirSync(to, { recursive: true });
for (const file of readdirSync(from)) {
  if (file.endsWith('.txt')) copyFileSync(from + file, to + file);
  if (!file.endsWith('.ttf')) continue;
  const out = to + file.replace(/\.ttf$/, '.woff2');
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(from + file).mtimeMs) continue;
  writeFileSync(out, await wawoff2.compress(readFileSync(from + file)));
}
