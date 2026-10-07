import { existsSync } from 'node:fs';
import { attentionRules, builtinRules, checkAsync } from '@simonlunay/redline';
import type { Design, RedlineConfig, Report, SaliencyModel } from '@simonlunay/redline';
import {
  createNodeEnv,
  loadDesign,
  renderAnnotatedPng,
  renderHeatmapPng,
} from '@simonlunay/redline/node';
import type { LoadedDesign, NodeEnv } from '@simonlunay/redline/node';
import type { DesignImage } from '../types.js';

export interface FixSession {
  loaded: LoadedDesign;
  env: NodeEnv;
  /** Whether the attention rules (saliency model) are part of the check. */
  attention: boolean;
  /** The same precise check the CLI uses: real fonts, image pixels, renderer (+ saliency). */
  check: (design: Design) => Promise<Report>;
  /** Images for vision-capable editors: annotated render, plus the heatmap with attention. */
  renderImages: (design: Design, report: Report) => Promise<DesignImage[]>;
  /** Predicted-attention overlay PNG (only with attention). */
  renderHeatmap?: (design: Design) => Promise<Buffer>;
}

/** Scale of the images sent to the model: plenty for layout judgments, fewer tokens. */
const VISION_SCALE = 0.75;

/** Loads a design file and everything needed to check and render edited versions of it. */
export async function createFixSession(
  path: string,
  options: { config?: RedlineConfig; attention?: boolean; saliency?: SaliencyModel } = {},
): Promise<FixSession> {
  const attention = Boolean(options.attention);
  const loaded = await loadDesign(path);
  const env = await createNodeEnv(loaded, {
    attention,
    ...(attention && options.saliency ? { saliency: options.saliency } : {}),
  });
  const saliency = env.saliency;

  const renderHeatmap = saliency
    ? async (design: Design) =>
        renderHeatmapPng(design, await saliency.predict(await env.render(design)), {
          images: env.images,
          modelId: saliency.id,
        })
    : undefined;

  return {
    loaded,
    env,
    attention,
    check: (design) =>
      checkAsync(design, {
        config: options.config,
        rules: attention ? [...builtinRules, ...attentionRules] : builtinRules,
        measurer: env.measurer,
        sampler: env.sampler,
        render: env.render,
        saliency,
      }),
    renderImages: async (design, report) => {
      const images: DesignImage[] = [
        {
          label: 'the current design with issues outlined and numbered',
          png: renderAnnotatedPng(design, report, { images: env.images, scale: VISION_SCALE }),
        },
      ];
      if (renderHeatmap) {
        images.push({
          label:
            "predicted attention heatmap (red = where viewers are predicted to look) with each key element's share",
          png: await renderHeatmap(design),
        });
      }
      return images;
    },
    ...(renderHeatmap ? { renderHeatmap } : {}),
  };
}

/** Loads ./.env if present (Node >= 20.12), so ANTHROPIC_API_KEY never has to be exported. */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  const load = (process as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  load?.(path);
}
