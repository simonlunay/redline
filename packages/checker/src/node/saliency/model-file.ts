import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A model file pinned by exact size and SHA-256, downloaded on first use. */
export interface PinnedModelFile {
  fileName: string;
  url: string;
  bytes: number;
  sha256: string;
}

/**
 * Per-user cache folder for downloaded weights (never inside the repo):
 * REDLINE_CACHE_DIR, else %LOCALAPPDATA%\redline on Windows, else $XDG_CACHE_HOME/redline or
 * ~/.cache/redline.
 */
export function cacheDir(): string {
  if (process.env.REDLINE_CACHE_DIR) return process.env.REDLINE_CACHE_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'redline');
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'redline');
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class ModelChecksumError extends Error {}

export interface EnsureOptions {
  dir?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  onProgress?: (message: string) => void;
}

/**
 * Returns a local path to the pinned file, downloading and verifying it if needed.
 * The download goes to a temp file and is only renamed into place after the size and SHA-256
 * match, so an interrupted or tampered download never ends up being used. A cached file that
 * fails verification (e.g. corrupted disk) is deleted and fetched again.
 */
export async function ensureModelFile(
  pinned: PinnedModelFile,
  options: EnsureOptions = {},
): Promise<string> {
  const dir = join(options.dir ?? cacheDir(), 'models');
  const path = join(dir, pinned.fileName);
  if (existsSync(path)) {
    if (statSync(path).size === pinned.bytes && (await sha256File(path)) === pinned.sha256) {
      return path;
    }
    rmSync(path, { force: true });
  }

  mkdirSync(dir, { recursive: true });
  options.onProgress?.(
    `Downloading ${pinned.fileName} (${(pinned.bytes / 1e6).toFixed(0)} MB) to ${dir}`,
  );
  const response = await (options.fetchImpl ?? fetch)(pinned.url);
  if (!response.ok) {
    throw new Error(`Download of ${pinned.url} failed: HTTP ${response.status}`);
  }
  const tmp = `${path}.download-${process.pid}`;
  try {
    await writeFile(tmp, Buffer.from(await response.arrayBuffer()));
    const size = statSync(tmp).size;
    const digest = await sha256File(tmp);
    if (size !== pinned.bytes || digest !== pinned.sha256) {
      throw new ModelChecksumError(
        `Checksum mismatch for ${pinned.fileName}: got ${size} bytes / sha256 ${digest}, expected ${pinned.bytes} bytes / ${pinned.sha256}`,
      );
    }
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return path;
}
