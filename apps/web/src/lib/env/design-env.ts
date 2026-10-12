import {
  check,
  createContextMeasurer,
  createRasterSampler,
  paintDesign,
} from '@simonlunay/redline';
import type {
  Design,
  ImageAnalysis,
  ImageSampler,
  MeasureContext,
  PaintContext,
  RasterImage,
  Report,
  TextMeasurer,
} from '@simonlunay/redline';
import { browserRules } from '../rules';
import type { RuleSetup } from '../rules';
import { cssFont } from './fonts';

/** What checking and drawing one design (and its edits) needs: fonts, pixels, image analyses. */
export interface DesignEnv<I extends { width: number; height: number }> {
  measurer: TextMeasurer;
  sampler: ImageSampler;
  /** Drawable images by src. */
  images: Map<string, I>;
  /** Image analyses by src, for the image rules (precomputed by the gallery build). */
  analyses: Map<string, ImageAnalysis>;
}

/**
 * Builds an environment from decoded images and a measuring context. In the browser that's a
 * canvas with the design fonts loaded; tests pass a Skia context, so both paths run this code.
 */
export function createDesignEnv<I extends { width: number; height: number }>(options: {
  measureContext: MeasureContext;
  images: Map<string, { drawable: I; pixels: RasterImage }>;
  analyses?: Record<string, { analysis?: ImageAnalysis }>;
}): DesignEnv<I> {
  const drawables = new Map<string, I>();
  const pixels = new Map<string, RasterImage>();
  for (const [src, image] of options.images) {
    drawables.set(src, image.drawable);
    pixels.set(src, image.pixels);
  }
  const analyses = new Map<string, ImageAnalysis>();
  for (const [src, entry] of Object.entries(options.analyses ?? {})) {
    if (entry.analysis) analyses.set(src, entry.analysis);
  }
  return {
    measurer: createContextMeasurer(options.measureContext, cssFont),
    sampler: createRasterSampler(pixels),
    images: drawables,
    analyses,
  };
}

export interface LiveReport {
  report: Report;
  /** Why the attention rules didn't run, when they didn't. */
  attentionPaused?: 'edited' | 'no-heatmap';
}

/** The browser's check: synchronous, every rule the setup allows (see lib/rules.ts). */
export function checkDesign<I extends { width: number; height: number }>(
  design: Design,
  env: DesignEnv<I>,
  setup: RuleSetup,
): LiveReport {
  const { rules, attentionPaused } = browserRules(setup);
  const report = check(design, {
    rules,
    measurer: env.measurer,
    sampler: env.sampler,
    ...(setup.rules.imageChecks ? { images: { get: (src: string) => env.analyses.get(src) } } : {}),
  });
  return { report, ...(attentionPaused ? { attentionPaused } : {}) };
}

/** Draws a design at `scale` with the shared renderer (the same code as the CLI's PNGs). */
export function drawDesign<I extends { width: number; height: number }>(
  ctx: PaintContext<I> & {
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  },
  design: Design,
  env: DesignEnv<I>,
  scale = 1,
): void {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  paintDesign(ctx, design, { images: env.images, measurer: env.measurer, cssFont });
}
