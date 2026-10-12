// Fails the build if the static site contains anything that looks like an API key or calls a
// paid API. The site has no server and no keys; this keeps it that way. Runs after `next build`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../out/', import.meta.url));
const FORBIDDEN = [
  { name: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: 'Replicate API token', pattern: /\br8_[A-Za-z0-9]{20,}/ },
  {
    name: 'Pexels or other bearer key',
    pattern: /Authorization["']?\s*[:=]\s*["']?(Bearer|Token)\s+[A-Za-z0-9]/,
  },
  { name: 'Anthropic API host', pattern: /api\.anthropic\.com/ },
  { name: 'Replicate API host', pattern: /api\.replicate\.com/ },
  { name: 'Anthropic SDK', pattern: /@anthropic-ai\/sdk|anthropic-version/ },
];
const TEXT = /\.(html|js|css|json|txt|map)$/;

const hits = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (TEXT.test(entry)) {
      const text = readFileSync(path, 'utf8');
      for (const f of FORBIDDEN)
        if (f.pattern.test(text)) hits.push(`${relative(out, path)}: ${f.name}`);
    }
  }
}
walk(out);
if (hits.length) {
  console.error(`check-no-secrets: found ${hits.length} problem(s):\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
console.log('check-no-secrets: no keys, no paid API hosts, no SDK in out/');
