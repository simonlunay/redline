// Build-time only: server components read the committed gallery files to prerender pages.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GalleryIndex, RunRecord } from './types';

const PUBLIC = join(process.cwd(), 'public');

export function readGalleryIndex(): GalleryIndex {
  return JSON.parse(readFileSync(join(PUBLIC, 'gallery', 'index.json'), 'utf8')) as GalleryIndex;
}

export function readRun(id: string): RunRecord {
  return JSON.parse(readFileSync(join(PUBLIC, 'gallery', id, 'run.json'), 'utf8')) as RunRecord;
}
