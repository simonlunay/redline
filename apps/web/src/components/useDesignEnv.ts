'use client';

import type { ImageAnalysis } from '@simonlunay/redline';
import { useEffect, useState } from 'react';
import { createDesignEnv } from '@/lib/env/design-env';
import type { DesignEnv } from '@/lib/env/design-env';
import { loadDesignFonts } from '@/lib/env/fonts';
import { loadImages } from '@/lib/env/images';

let measureCanvas: OffscreenCanvas | undefined;

/**
 * Resolves once the page itself has loaded, so the design fonts and images (several hundred KB)
 * don't compete with the page's own text and styles on a slow connection.
 */
async function pageLoaded(): Promise<void> {
  if (document.readyState !== 'complete') {
    await new Promise<void>((resolve) =>
      window.addEventListener('load', () => resolve(), { once: true }),
    );
  }
  // The page's own font first (the headline waits on it), then an idle moment.
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    'requestIdleCallback' in window
      ? window.requestIdleCallback(() => resolve(), { timeout: 600 })
      : setTimeout(resolve, 50),
  );
}

/**
 * Loads the design fonts and a run's (or sample's, or upload's) images, and builds the
 * environment the checker and renderer share. Returns null until everything is ready, plus the
 * images that failed to load.
 */
export function useDesignEnv(
  key: string | null,
  srcs: string[],
  url: (src: string) => string,
  analyses?: Record<string, { analysis?: ImageAnalysis }>,
): { env: DesignEnv<ImageBitmap> | null; errors: Map<string, string> } {
  const [state, setState] = useState<{
    key: string;
    env: DesignEnv<ImageBitmap>;
    errors: Map<string, string>;
  } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    (async () => {
      await pageLoaded();
      await loadDesignFonts();
      const { images, errors } = await loadImages(srcs, url);
      measureCanvas ??= new OffscreenCanvas(1, 1);
      const env = createDesignEnv({
        measureContext: measureCanvas.getContext('2d')!,
        images: new Map(
          [...images].map(([src, img]) => [src, { drawable: img.bitmap, pixels: img.pixels }]),
        ),
        ...(analyses ? { analyses } : {}),
      });
      if (live) setState({ key, env, errors });
    })().catch((err: unknown) => {
      if (live) setState(null);
      console.error(err);
    });
    return () => {
      live = false;
    };
    // The key identifies the image set; srcs/url/analyses are derived from the same record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!state || state.key !== key) return { env: null, errors: new Map() };
  return { env: state.env, errors: state.errors };
}
