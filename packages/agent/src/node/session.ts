import { existsSync } from 'node:fs';
import { checkAsync } from '@simonlunay/redline';
import type { Design, RedlineConfig, Report } from '@simonlunay/redline';
import { createNodeEnv, loadDesign, renderAnnotatedPng } from '@simonlunay/redline/node';
import type { LoadedDesign, NodeEnv } from '@simonlunay/redline/node';

export interface FixSession {
  loaded: LoadedDesign;
  env: NodeEnv;
  /** The same precise check the CLI uses: real fonts, image pixels, renderer. */
  check: (design: Design) => Promise<Report>;
  /** Annotated PNG (scaled down) for vision-capable editors. */
  renderImage: (design: Design, report: Report) => Promise<Uint8Array>;
}

/** Scale of the image sent to the model: plenty for layout judgments, fewer tokens. */
const VISION_SCALE = 0.75;

/** Loads a design file and everything needed to check and render edited versions of it. */
export async function createFixSession(
  path: string,
  options: { config?: RedlineConfig } = {},
): Promise<FixSession> {
  const loaded = await loadDesign(path);
  const env = await createNodeEnv(loaded);
  return {
    loaded,
    env,
    check: (design) =>
      checkAsync(design, {
        config: options.config,
        measurer: env.measurer,
        sampler: env.sampler,
        render: env.render,
      }),
    renderImage: async (design, report) =>
      renderAnnotatedPng(design, report, { images: env.images, scale: VISION_SCALE }),
  };
}

/** Loads ./.env if present (Node >= 20.12), so ANTHROPIC_API_KEY never has to be exported. */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  const load = (process as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  load?.(path);
}
