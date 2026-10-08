import { attentionRules, builtinRules, checkAsync, imageRules } from '@simonlunay/redline';
import type {
  AnyRule,
  Design,
  ImageOrigin,
  RedlineConfig,
  Report,
  SaliencyModel,
} from '@simonlunay/redline';
import {
  createFontMeasurer,
  createImageAnalyzer,
  createImageSampler,
  getAttentionModel,
  renderAnnotatedPng,
  renderHeatmapPng,
  renderRaster,
} from '@simonlunay/redline/node';
import type { ImageAnalyzer } from '@simonlunay/redline/node';
import type { ImageSampler } from '@simonlunay/redline';
import type { DesignImage } from '@simonlunay/redline-agent';
import { loadImage } from '@napi-rs/canvas';
import type { Image } from '@napi-rs/canvas';
import { isAbsolute, resolve } from 'node:path';

/**
 * Checking and rendering for designs whose images change over time (candidates with different
 * backgrounds, regenerated images in the fix loop). Unlike the fix session, which loads a
 * design's images once, images are loaded lazily by src and kept, and the pixel sampler is
 * composed per image, so adding an image never re-decodes the others.
 */
export interface Workspace {
  baseDir: string;
  images: Map<string, Image>;
  attention: boolean;
  saliency?: SaliencyModel;
  /**
   * Image analysis for the image rules (text in images, cutout quality), when on. Only images
   * marked with markImage are analyzed: generated and stock images, never the user's own.
   */
  imageAnalysis?: ImageAnalyzer;
  /** Records where an image came from (and a cutout's backdrop color) so it gets analyzed. */
  markImage(src: string, origin: ImageOrigin, backdrop?: [number, number, number]): void;
  /** Loads (and analyzes) any image of the design that isn't loaded yet. */
  ensure(design: Design): Promise<void>;
  /** Checks with the built-in (and attention) rules plus any extra ones, e.g. copy-grounded. */
  check(design: Design, extraRules?: AnyRule[]): Promise<Report>;
  renderImages(design: Design, report: Report): Promise<DesignImage[]>;
  renderAnnotated(design: Design, report: Report, scale?: number): Promise<Buffer>;
  renderHeatmap?(design: Design): Promise<Buffer>;
}

const VISION_SCALE = 0.75;

export async function createWorkspace(
  baseDir: string,
  options: {
    attention?: boolean;
    saliency?: SaliencyModel;
    config?: RedlineConfig;
    /** Turn the image rules on (true: PP-OCRv5 text detector, loaded on first use). */
    imageChecks?: boolean | ImageAnalyzer;
  } = {},
): Promise<Workspace> {
  const attention = Boolean(options.attention);
  const saliency = attention ? (options.saliency ?? (await getAttentionModel())) : undefined;
  const images = new Map<string, Image>();
  const samplers = new Map<string, ImageSampler>();
  const measurer = createFontMeasurer();
  const sampler: ImageSampler = {
    has: (src) => samplers.has(src),
    sample: (src, u, v) => samplers.get(src)?.sample(src, u, v) ?? null,
  };

  const imageAnalysis =
    typeof options.imageChecks === 'object'
      ? options.imageChecks
      : options.imageChecks
        ? createImageAnalyzer()
        : undefined;
  const marks = new Map<string, { origin: ImageOrigin; backdrop?: [number, number, number] }>();

  async function ensure(design: Design) {
    for (const el of design.elements) {
      if (el.type !== 'image') continue;
      let image = images.get(el.src);
      if (!image) {
        const path = isAbsolute(el.src) ? el.src : resolve(baseDir, el.src);
        image = await loadImage(path);
        images.set(el.src, image);
        samplers.set(el.src, createImageSampler(new Map([[el.src, image]])));
      }
      const mark = marks.get(el.src);
      if (imageAnalysis && mark) await imageAnalysis.analyze(el.src, image, mark);
    }
  }

  const render = async (design: Design) => renderRaster(design, { images });
  const renderHeatmap = saliency
    ? async (design: Design) => {
        await ensure(design);
        return renderHeatmapPng(design, await saliency.predict(await render(design)), {
          images,
          modelId: saliency.id,
        });
      }
    : undefined;

  return {
    baseDir,
    images,
    attention,
    ...(saliency ? { saliency } : {}),
    ...(imageAnalysis ? { imageAnalysis } : {}),
    markImage(src, origin, backdrop) {
      marks.set(src, { origin, ...(backdrop ? { backdrop } : {}) });
    },
    ensure,
    async check(design, extraRules = []) {
      await ensure(design);
      return checkAsync(design, {
        config: options.config,
        rules: [
          ...builtinRules,
          ...(attention ? attentionRules : []),
          ...(imageAnalysis ? imageRules : []),
          ...extraRules,
        ],
        ...(imageAnalysis ? { images: imageAnalysis } : {}),
        measurer,
        sampler,
        render,
        saliency,
      });
    },
    async renderImages(design, report) {
      await ensure(design);
      const list: DesignImage[] = [
        {
          label: 'the current design with issues outlined and numbered',
          png: renderAnnotatedPng(design, report, { images, scale: VISION_SCALE }),
        },
      ];
      if (renderHeatmap) {
        list.push({
          label:
            "predicted attention heatmap (red = where viewers are predicted to look) with each key element's share",
          png: await renderHeatmap(design),
        });
      }
      return list;
    },
    async renderAnnotated(design, report, scale) {
      await ensure(design);
      return renderAnnotatedPng(design, report, { images, ...(scale ? { scale } : {}) });
    },
    ...(renderHeatmap ? { renderHeatmap } : {}),
  };
}
