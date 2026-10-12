'use client';

import type { ImageAnalysis } from '@simonlunay/redline';
import { useEffect, useState } from 'react';
import { createDesignEnv } from '@/lib/env/design-env';
import type { DesignEnv } from '@/lib/env/design-env';
import { checkDesignFonts, setGeometricText } from '@/lib/env/font-check';
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

export interface DesignEnvState {
  env: DesignEnv<ImageBitmap> | null;
  /** Images that failed to load, by src. */
  errors: Map<string, string>;
  /**
   * Why this browser's text measurement doesn't match the CLI's, if it doesn't. The page shows
   * it: scores would otherwise differ silently (a wrapped label is a text-overflow error).
   */
  fontProblems: string[];
}

/**
 * Loads the design fonts and a run's (or sample's, or upload's) images, and builds the
 * environment the checker and renderer share. `env` is null until everything is ready.
 */
export function useDesignEnv(
  key: string | null,
  srcs: string[],
  url: (src: string) => string,
  analyses?: Record<string, { analysis?: ImageAnalysis }>,
): DesignEnvState {
  const [state, setState] = useState<{
    key: string;
    env: DesignEnv<ImageBitmap>;
    errors: Map<string, string>;
    fontProblems: string[];
  } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    (async () => {
      await pageLoaded();
      await loadDesignFonts();
      await document.fonts.ready;
      const { images, errors } = await loadImages(srcs, url);
      measureCanvas ??= new OffscreenCanvas(1, 1);
      const measureContext = measureCanvas.getContext('2d')!;
      setGeometricText(measureContext);
      const env = createDesignEnv({
        measureContext,
        images: new Map(
          [...images].map(([src, img]) => [src, { drawable: img.bitmap, pixels: img.pixels }]),
        ),
        ...(analyses ? { analyses } : {}),
      });
      const fonts = checkDesignFonts(env.measurer, (css) => document.fonts.check(css));
      if (!fonts.ok)
        console.error(`Design fonts don't measure like the CLI: ${fonts.problems.join(' ')}`);
      if (live) setState({ key, env, errors, fontProblems: fonts.problems });
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
  if (!state || state.key !== key) return { env: null, errors: new Map(), fontProblems: [] };
  return { env: state.env, errors: state.errors, fontProblems: state.fontProblems };
}
