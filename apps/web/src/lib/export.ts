import type { Design } from '@simonlunay/redline';
import { drawDesign } from './env/design-env';
import type { DesignEnv } from './env/design-env';

/** Renders a design at full resolution with the shared renderer. */
export async function designPng(design: Design, env: DesignEnv<ImageBitmap>): Promise<Blob> {
  const canvas = new OffscreenCanvas(design.canvas.width, design.canvas.height);
  const ctx = canvas.getContext('2d')!;
  drawDesign<ImageBitmap>(ctx, design, env, 1);
  return canvas.convertToBlob({ type: 'image/png' });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * The design as a self-contained file: every image embedded as a data URL, so `redline check`
 * and `redline fix` work on it anywhere and this site can open it again.
 */
export async function designJson(design: Design, url: (src: string) => string): Promise<Blob> {
  const embedded = new Map<string, string>();
  for (const el of design.elements) {
    if (el.type !== 'image' || embedded.has(el.src)) continue;
    if (el.src.startsWith('data:')) {
      embedded.set(el.src, el.src);
      continue;
    }
    const response = await fetch(url(el.src));
    if (!response.ok) throw new Error(`Couldn't load ${el.src} (HTTP ${response.status}).`);
    embedded.set(el.src, await blobToDataUrl(await response.blob()));
  }
  const out: Design = {
    ...design,
    elements: design.elements.map((el) =>
      el.type === 'image' ? { ...el, src: embedded.get(el.src) ?? el.src } : el,
    ),
  };
  return new Blob([`${JSON.stringify(out, null, 2)}\n`], { type: 'application/json' });
}

export function download(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
