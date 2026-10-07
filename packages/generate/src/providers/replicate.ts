import { closestAspectRatio } from './types.js';
import type { FetchLike, GeneratedImage, ImageProvider, ImageRequest } from './types.js';

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

export interface ReplicateOptions {
  token: string;
  fetchImpl?: FetchLike;
  /** Poll interval while a prediction is still running (ms). */
  pollMs?: number;
  /** Give up after this long (ms). */
  timeoutMs?: number;
  /** Retries on 429 / 5xx (default 10). */
  maxRetries?: number;
  /**
   * Minimum time between prediction requests (ms). Default 0, but after the first 429 it is
   * raised to the server's retry_after (Replicate allows 6 per minute, burst 1, on accounts with
   * under $5 credit), so a run adapts instead of failing.
   */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Prediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string[] | string | null;
  error?: string | null;
  urls?: { get?: string };
}

const API = 'https://api.replicate.com/v1';
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Text-to-image with FLUX.1 [schnell] on Replicate. The token is only ever sent as a header. */
export function createReplicateFluxProvider(options: ReplicateOptions): ImageProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxRetries = options.maxRetries ?? 10;
  let interval = options.minIntervalMs ?? 0;
  let nextSlot = 0;
  /** Spaces prediction requests `interval` apart, in call order. */
  async function waitForSlot() {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + interval;
    if (at > now) await sleep(at - now);
  }
  const headers = {
    Authorization: `Bearer ${options.token}`,
    'Content-Type': 'application/json',
  };

  async function request(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(url, init);
      } catch (err) {
        // Network-level failure ("fetch failed": reset, DNS, TLS). Retried like a 5xx. A retried
        // POST can create a second prediction; at $0.003 that beats failing the whole design.
        if (attempt >= maxRetries) {
          throw new Error(
            `Replicate request failed after ${attempt + 1} attempts: ${(err as Error).message}`,
            { cause: err },
          );
        }
        await sleep(Math.min(30_000, 2000 * 2 ** attempt));
        continue;
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= maxRetries) return response;
      let retryAfter = Number(response.headers.get('retry-after'));
      if (response.status === 429) {
        // Replicate puts retry_after (seconds) in the JSON body.
        const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
        if (!(retryAfter > 0) && typeof body.retry_after === 'number')
          retryAfter = body.retry_after;
        interval = Math.max(interval, (retryAfter > 0 ? retryAfter : 10) * 1000);
      }
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000 + 250
          : Math.min(30_000, 2000 * 2 ** attempt),
      );
      if (init.method === 'POST') await waitForSlot();
    }
  }

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
      await waitForSlot();
      const created = await request(`${API}/models/${FLUX_SCHNELL.model}/predictions`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'wait=60' },
        body: JSON.stringify({ input }),
      });
      if (!created.ok) {
        throw new Error(
          `Replicate request failed: HTTP ${created.status} ${(await created.text()).slice(0, 300)}`,
        );
      }
      let prediction = (await created.json()) as Prediction;
      const started = Date.now();
      while (prediction.status === 'starting' || prediction.status === 'processing') {
        if (Date.now() - started > timeoutMs)
          throw new Error(`Replicate prediction ${prediction.id} timed out`);
        if (!prediction.urls?.get) throw new Error('Replicate prediction has no polling URL');
        await sleep(pollMs);
        const polled = await request(prediction.urls.get, { headers });
        if (!polled.ok) throw new Error(`Replicate polling failed: HTTP ${polled.status}`);
        prediction = (await polled.json()) as Prediction;
      }
      if (prediction.status !== 'succeeded') {
        throw new Error(
          `Replicate prediction ${prediction.id} ${prediction.status}: ${prediction.error ?? 'no output'}`,
        );
      }
      const url = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
      if (!url) throw new Error(`Replicate prediction ${prediction.id} returned no image`);
      const image = await request(url, {});
      if (!image.ok)
        throw new Error(`Downloading the generated image failed: HTTP ${image.status}`);
      return {
        bytes: new Uint8Array(await image.arrayBuffer()),
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
