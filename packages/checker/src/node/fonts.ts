import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GlobalFonts } from '@napi-rs/canvas';
import type { FontSpec } from '../core/text-measure.js';

/** Bundled font; used for any family that has not been registered. */
export const DEFAULT_FAMILY = 'Inter';

// Works from both src/node (tests via tsx) and dist/node (published package).
const FONTS_DIR = fileURLToPath(new URL('../../fonts/', import.meta.url));
const BUNDLED = ['Inter-Regular.ttf', 'Inter-SemiBold.ttf', 'Inter-Bold.ttf', 'Inter-Black.ttf'];

let bundledRegistered = false;

export function registerBundledFonts(): void {
  if (bundledRegistered) return;
  for (const file of BUNDLED) {
    const path = FONTS_DIR + file;
    if (!existsSync(path) || !GlobalFonts.registerFromPath(path, DEFAULT_FAMILY)) {
      throw new Error(`Could not load bundled font ${path}`);
    }
  }
  bundledRegistered = true;
}

/** Registers a .ttf/.otf/.woff2 file under `family` so designs can use it. */
export function registerFont(path: string, family: string): void {
  if (!GlobalFonts.registerFromPath(path, family)) {
    throw new Error(`Could not register font ${path} as "${family}"`);
  }
}

/**
 * Unregistered families would silently fall back to some system font, which differs per
 * machine. Mapping them to the bundled font keeps results identical on every OS and in CI.
 */
export function resolveFamily(family: string): string {
  return GlobalFonts.has(family) ? family : DEFAULT_FAMILY;
}

export function cssFont(font: FontSpec): string {
  return `${font.weight} ${font.size}px "${resolveFamily(font.family)}"`;
}
