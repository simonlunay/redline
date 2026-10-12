import { closestAspectRatio } from './types.js';
import { createReplicateClient } from './replicate-client.js';
import type { ReplicateClient, ReplicateOptions } from './replicate-client.js';
import type { GeneratedImage, ImageProvider, ImageRequest } from './types.js';

export type { ReplicateOptions } from './replicate-client.js';

/** Aspect ratios black-forest-labs/flux-schnell accepts on Replicate (checked 2026-10-06). */
export const FLUX_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '21:9',
  '3:2',
  '2:3',
  '4:5',
  '5:4',
  '3:4',
  '4:3',
  '9:16',
  '9:21',
] as const;

/**
 * FLUX.1 [schnell]: Apache-2.0 weights (commercial use allowed), $0.003 per output image on
 * Replicate (replicate.com/pricing, checked 2026-10-06). Verified in README and NOTICE.
 */
export const FLUX_SCHNELL = {
  model: 'black-forest-labs/flux-schnell',
  license: 'Apache-2.0 (FLUX.1 [schnell] weights; outputs usable commercially)',
  costPerImageUsd: 0.003,
};

/**
 * Text-to-image with FLUX.1 [schnell] on Replicate. Pass `client` to share one client (and its
 * learned rate limit) with the hosted cutout.
 */
export function createReplicateFluxProvider(
  options: ReplicateOptions & { client?: ReplicateClient },
): ImageProvider {
  const client = options.client ?? createReplicateClient(options);
  return {
    id: 'replicate',
    model: FLUX_SCHNELL.model,
    license: FLUX_SCHNELL.license,
    estimateCostUsd: () => FLUX_SCHNELL.costPerImageUsd,
    async generate(req: ImageRequest): Promise<GeneratedImage> {
      const outputFormat = req.kind === 'subject' ? 'png' : 'jpg';
      const input = {
        prompt: req.prompt,
        aspect_ratio: closestAspectRatio(req.width, req.height, FLUX_ASPECT_RATIOS),
        seed: req.seed,
        num_outputs: 1,
        megapixels: '1',
        output_format: outputFormat,
        output_quality: 95,
        num_inference_steps: 4,
      };
      const { prediction, output } = await client.run(`/models/${FLUX_SCHNELL.model}/predictions`, {
        input,
      });
      return {
        bytes: output,
        mimeType: outputFormat === 'png' ? 'image/png' : 'image/jpeg',
        provider: 'replicate',
        model: FLUX_SCHNELL.model,
        seed: req.seed,
        costUsd: FLUX_SCHNELL.costPerImageUsd,
        license: FLUX_SCHNELL.license,
        sourceUrl: `https://replicate.com/p/${prediction.id}`,
      };
    },
  };
}
