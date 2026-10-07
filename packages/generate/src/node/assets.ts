import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { loadImage } from '@napi-rs/canvas';
import type { SlotImage } from '../assemble.js';
import type { GeneratedImage } from '../providers/types.js';

/** One image file and where it came from. Written to <name>.assets/manifest.json. */
export interface ManifestEntry {
  file: string;
  /** e.g. "layout1/background/v2", "layout1/subject", "regen/background/1" */
  key: string;
  slotId: string;
  kind: 'background' | 'subject' | 'user';
  prompt?: string;
  provider: string;
  model: string;
  seed: number | null;
  costUsd: number;
  license: string;
  width: number;
  height: number;
  sourceUrl?: string;
  attribution?: string;
  /** For subjects: how the background was removed. */
  cutout?: { remover: string; model: string; license: string; coverage: number } | null;
  /** Set on images made by a fix-loop regeneration. */
  regeneration?: { reason: string; replaces: string };
  createdAt: string;
}

export interface Manifest {
  prompt: string;
  createdAt: string;
  images: ManifestEntry[];
}

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/**
 * Stores images next to the design (`<name>.assets/`) and keeps the manifest in sync. `src`
 * values are relative to the design file's directory, so the design folder can be moved.
 */
export class AssetStore {
  readonly dir: string;
  readonly manifest: Manifest;
  private readonly manifestPath: string;

  constructor(
    readonly designDir: string,
    name: string,
    prompt: string,
  ) {
    this.dir = resolve(designDir, `${name}.assets`);
    mkdirSync(this.dir, { recursive: true });
    this.manifestPath = join(this.dir, 'manifest.json');
    this.manifest = { prompt, createdAt: new Date().toISOString(), images: [] };
  }

  private src(file: string): string {
    return relative(this.designDir, join(this.dir, file)).split('\\').join('/');
  }

  private unique(base: string, ext: string): string {
    const taken = new Set(this.manifest.images.map((e) => e.file));
    let file = `${base}${ext}`;
    for (let i = 2; taken.has(file); i++) file = `${base}-${i}${ext}`;
    return file;
  }

  async save(
    bytes: Uint8Array,
    mimeType: string,
    fileBase: string,
    entry: Omit<ManifestEntry, 'file' | 'width' | 'height' | 'createdAt'>,
  ): Promise<SlotImage & { entry: ManifestEntry }> {
    const file = this.unique(fileBase, EXT[mimeType] ?? '.png');
    await writeFile(join(this.dir, file), bytes);
    const image = await loadImage(Buffer.from(bytes));
    const full: ManifestEntry = {
      ...entry,
      file,
      width: image.width,
      height: image.height,
      createdAt: new Date().toISOString(),
    };
    this.manifest.images.push(full);
    this.flush();
    return { src: this.src(file), width: image.width, height: image.height, entry: full };
  }

  async saveGenerated(
    image: GeneratedImage,
    fileBase: string,
    entry: Pick<ManifestEntry, 'key' | 'slotId' | 'kind' | 'prompt' | 'cutout' | 'regeneration'>,
    bytes: Uint8Array = image.bytes,
    mimeType: string = image.mimeType,
  ) {
    return this.save(bytes, mimeType, fileBase, {
      ...entry,
      provider: image.provider,
      model: image.model,
      seed: image.seed,
      costUsd: image.costUsd,
      license: image.license,
      ...(image.sourceUrl ? { sourceUrl: image.sourceUrl } : {}),
      ...(image.attribution ? { attribution: image.attribution } : {}),
    });
  }

  /** Copies a user-supplied file into the assets folder. */
  async importUserFile(path: string, slotId: string, key: string) {
    const ext = extname(path).toLowerCase() || '.png';
    const file = this.unique(basename(path, extname(path)).replace(/[^\w-]+/g, '-'), ext);
    await copyFile(path, join(this.dir, file));
    const image = await loadImage(readFileSync(join(this.dir, file)));
    const entry: ManifestEntry = {
      file,
      key,
      slotId,
      kind: 'user',
      provider: 'user',
      model: 'supplied by user',
      seed: null,
      costUsd: 0,
      license: 'Supplied by the user (their responsibility)',
      width: image.width,
      height: image.height,
      createdAt: new Date().toISOString(),
    };
    this.manifest.images.push(entry);
    this.flush();
    return { src: this.src(file), width: image.width, height: image.height, entry };
  }

  flush(): void {
    writeFileSync(this.manifestPath, `${JSON.stringify(this.manifest, null, 2)}\n`);
  }

  get manifestFile(): string {
    return this.manifestPath;
  }
}
