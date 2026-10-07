import { attentionRules, builtinRules, checkAsync } from '@simonlunay/redline';
import type { Design, RedlineConfig, Report, SaliencyModel } from '@simonlunay/redline';
import {
  createFontMeasurer,
  createImageSampler,
  getAttentionModel,
  renderAnnotatedPng,
  renderHeatmapPng,
  renderRaster,
} from '@simonlunay/redline/node';
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
  /** Loads any image of the design that isn't loaded yet. */
  ensure(design: Design): Promise<void>;
  check(design: Design): Promise<Report>;
  renderImages(design: Design, report: Report): Promise<DesignImage[]>;
  renderAnnotated(design: Design, report: Report, scale?: number): Promise<Buffer>;
  renderHeatmap?(design: Design): Promise<Buffer>;
}

const VISION_SCALE = 0.75;

export async function createWorkspace(
  baseDir: string,
  options: { attention?: boolean; saliency?: SaliencyModel; config?: RedlineConfig } = {},
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

  async function ensure(design: Design) {
    for (const el of design.elements) {
      if (el.type !== 'image' || images.has(el.src)) continue;
      const path = isAbsolute(el.src) ? el.src : resolve(baseDir, el.src);
      const image = await loadImage(path);
      images.set(el.src, image);
      samplers.set(el.src, createImageSampler(new Map([[el.src, image]])));
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
    ensure,
    async check(design) {
      await ensure(design);
      return checkAsync(design, {
        config: options.config,
        rules: attention ? [...builtinRules, ...attentionRules] : builtinRules,
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
