// Copies the checker's bundled Inter files into public/fonts, so the browser measures and draws
// designs with exactly the font files the CLI uses. Runs before `next dev` and `next build`.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../../../packages/checker/fonts/', import.meta.url));
const to = fileURLToPath(new URL('../public/fonts/', import.meta.url));
mkdirSync(to, { recursive: true });
for (const file of readdirSync(from)) {
  if (/\.(ttf|txt)$/.test(file)) copyFileSync(from + file, to + file);
}
