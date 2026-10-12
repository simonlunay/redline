// Next 16's static export writes route-segment prefetch data as nested files
// (gallery/__next.gallery/__PAGE__.txt), while the client requests the dotted name
// (gallery/__next.gallery.__PAGE__.txt). A plain static host like GitHub Pages can't rewrite
// URLs, so every prefetch would 404 and links would fall back to full page loads. This writes a
// copy of each nested file under the dotted name.
import { copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../out/', import.meta.url));
let copied = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!statSync(path).isDirectory()) continue;
    if (entry === '_next') continue;
    if (entry.startsWith('__next.')) flatten(path, dir);
    else walk(path);
  }
}

function flatten(segmentDir, parent) {
  for (const entry of readdirSync(segmentDir, { recursive: true })) {
    const file = join(segmentDir, entry);
    if (statSync(file).isDirectory()) continue;
    const dotted = relative(parent, file).split(sep).join('.');
    copyFileSync(file, join(parent, dotted));
    copied++;
  }
}

walk(out);
console.log(`flatten-segments: ${copied} prefetch files`);
