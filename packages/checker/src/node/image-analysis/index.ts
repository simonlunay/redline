import { createCanvas } from '@napi-rs/canvas';
import type { Image } from '@napi-rs/canvas';
import { judgeCutout, measureCutout } from '../../core/cutout-quality.js';
import type { CutoutSource } from '../../core/cutout-quality.js';
import type { ImageAnalysis, ImageAnalysisSource, ImageOrigin } from '../../core/image-analysis.js';
import type { Design } from '../../core/schema.js';
import { createOnnxTextDetector } from './text-detector.js';
import type { TextDetector, TextDetectorOptions } from './text-detector.js';

/** Share of an image's pixels that must be transparent (and opaque) for it to be a cutout. */
const CUTOUT_MIN_SHARE = 0.02;

export interface ImageAnalyzer extends ImageAnalysisSource {
  /**
   * Analyzes one image (once per src; later calls return the cached result). `cutoutSource`
   * says what made a cutout: a segmentation model's verdict is capped at a warning.
   */
  analyze(
    src: string,
    image: Image,
    options: {
      origin: ImageOrigin;
      backdrop?: [number, number, number];
      cutoutSource?: CutoutSource;
    },
  ): Promise<ImageAnalysis>;
  /** Analyzes every image of a design that `originOf` doesn't skip (returns null to skip). */
  analyzeDesign(
    design: Design,
    images: Map<string, Image>,
    originOf?: (src: string) => ImageOrigin | null,
  ): Promise<void>;
  /** The text detector in use, or null when text detection is off or couldn't load. */
  detector(): Promise<TextDetector | null>;
  warnings: string[];
}

let shared: Promise<TextDetector> | undefined;

/** PP-OCRv5 det + rec, loaded once per process. Downloads and verifies the pinned files first. */
export function getTextDetector(options: TextDetectorOptions = {}): Promise<TextDetector> {
  shared ??= createOnnxTextDetector(options).catch((err: unknown) => {
    shared = undefined;
    throw err;
  });
  return shared;
}

function rgba(image: Image) {
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    data: ctx.getImageData(0, 0, image.width, image.height).data,
  };
}

/** True when enough of the image is transparent, and enough opaque, to be a cut-out subject. */
function isCutout(px: { data: Uint8ClampedArray }): boolean {
  let clear = 0;
  const n = px.data.length / 4;
  for (let i = 0; i < n; i++) if (px.data[i * 4 + 3]! < 128) clear++;
  return clear / n >= CUTOUT_MIN_SHARE && clear / n <= 1 - CUTOUT_MIN_SHARE;
}

/**
 * Text-in-image detection and cutout measurement per image, cached by src. The text detector
 * is optional: pass `detector: null` to skip it, or leave it out to load PP-OCRv5 on first use
 * (if that fails, text detection is off and a warning says so; the cutout check still runs).
 */
export function createImageAnalyzer(
  options: { detector?: TextDetector | null | (() => Promise<TextDetector>) } = {},
): ImageAnalyzer {
  const results = new Map<string, Promise<ImageAnalysis>>();
  const settled = new Map<string, ImageAnalysis>();
  const warnings: string[] = [];
  let detector: Promise<TextDetector | null> | undefined;
  const getDetector = () =>
    (detector ??= (async () => {
      if (options.detector === null) return null;
      if (options.detector && typeof options.detector !== 'function') return options.detector;
      try {
        return await (options.detector ?? getTextDetector)();
      } catch (err) {
        warnings.push(`Text-in-image detection is off: ${(err as Error).message}`);
        return null;
      }
    })());

  async function run(
    image: Image,
    origin: ImageOrigin,
    backdrop?: [number, number, number],
    cutoutSource?: CutoutSource,
  ): Promise<ImageAnalysis> {
    const px = rgba(image);
    const det = await getDetector();
    const text = det ? await det.detect(px) : undefined;
    const cutout = isCutout(px)
      ? judgeCutout(measureCutout(px, backdrop), { source: cutoutSource })
      : undefined;
    return { origin, ...(text ? { text } : {}), ...(cutout ? { cutout } : {}) };
  }

  const analyzer: ImageAnalyzer = {
    warnings,
    detector: getDetector,
    get: (src) => settled.get(src),
    analyze(src, image, { origin, backdrop, cutoutSource }) {
      let result = results.get(src);
      if (!result) {
        result = run(image, origin, backdrop, cutoutSource).then((r) => {
          settled.set(src, r);
          return r;
        });
        results.set(src, result);
      }
      return result;
    },
    async analyzeDesign(design, images, originOf = () => 'user') {
      for (const el of design.elements) {
        if (el.type !== 'image') continue;
        const origin = originOf(el.src);
        const image = images.get(el.src);
        if (!origin || !image) continue;
        await analyzer.analyze(el.src, image, { origin });
      }
    },
  };
  return analyzer;
}
