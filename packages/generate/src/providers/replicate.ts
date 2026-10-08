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
  /**
   * Overall deadline for one image (ms, default 5 min), covering the create request, rate-limit
   * waits, polling and the download. Past it the image fails with a timeout naming the stage.
   */
  timeoutMs?: number;
  /**
   * Per-request timeouts (ms). A request that hasn't answered by then is aborted and retried like
   * a network failure. Without these, one hung connection stalled an eval run for two hours.
   */
  requestTimeoutMs?: { create?: number; poll?: number; download?: number };
  /** Clock, for tests. */
  now?: () => number;
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
  const timeoutMs = options.timeoutMs ?? 300_000;
  const now = options.now ?? Date.now;
  const stageTimeout = {
    // The create request asks the server to wait up to 60 s for the result.
    create: options.requestTimeoutMs?.create ?? 90_000,
    poll: options.requestTimeoutMs?.poll ?? 30_000,
    download: options.requestTimeoutMs?.download ?? 60_000,
  };
  const maxRetries = options.maxRetries ?? 10;
  let interval = options.minIntervalMs ?? 0;
  let nextSlot = 0;
  /** Spaces prediction requests `interval` apart, in call order. */
  async function waitForSlot() {
    const t = now();
    const at = Math.max(t, nextSlot);
    nextSlot = at + interval;
    if (at > t) await sleep(at - t);
  }
  const headers = {
    Authorization: `Bearer ${options.token}`,
    'Content-Type': 'application/json',
  };

  type Stage = keyof typeof stageTimeout;

  /** Thrown when the overall deadline for an image has passed. */
  function deadlineError(stage: Stage, deadline: number, id?: string): Error | undefined {
    if (now() < deadline) return undefined;
    return new Error(
      `Replicate ${id ? `prediction ${id} ` : ''}timed out after ${Math.round(timeoutMs / 1000)} s (while ${stage === 'create' ? 'creating the prediction' : stage === 'poll' ? 'waiting for the result' : 'downloading the image'})`,
    );
  }

  /** fetch with a per-request timeout; a hung request rejects instead of stalling forever. */
  async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`no response within ${Math.round(ms / 1000)} s`)),
      ms,
    );
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(
    url: string,
    init: RequestInit,
    stage: Stage,
    deadline: number,
    id?: string,
  ): Promise<Response> {
    /** Sleeps, unless that would cross the deadline. */
    const wait = async (ms: number) => {
      const late = deadlineError(stage, deadline - ms, id);
      if (late) throw late;
      await sleep(ms);
    };
    for (let attempt = 0; ; attempt++) {
      const late = deadlineError(stage, deadline, id);
      if (late) throw late;
      const ms = Math.max(1, Math.min(stageTimeout[stage], deadline - now()));
      let response: Response;
      try {
        response = await fetchWithTimeout(url, init, ms);
      } catch (err) {
        // Network-level failure ("fetch failed": reset, DNS, TLS) or a request that hung past its
        // timeout. Retried like a 5xx. A retried POST can create a second prediction; at $0.003
        // that beats failing the whole design.
        if (attempt >= maxRetries) {
          throw new Error(
            `Replicate request failed after ${attempt + 1} attempts: ${(err as Error).message}`,
            { cause: err },
          );
        }
        await wait(Math.min(30_000, 2000 * 2 ** attempt));
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
      await wait(
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
      // The deadline starts after our own rate-limit slot: queueing isn't the server stalling.
      const deadline = now() + timeoutMs;
      const created = await request(
        `${API}/models/${FLUX_SCHNELL.model}/predictions`,
        {
          method: 'POST',
          headers: { ...headers, Prefer: 'wait=60' },
          body: JSON.stringify({ input }),
        },
        'create',
        deadline,
      );
      if (!created.ok) {
        throw new Error(
          `Replicate request failed: HTTP ${created.status} ${(await created.text()).slice(0, 300)}`,
        );
      }
      let prediction = (await created.json()) as Prediction;
      while (prediction.status === 'starting' || prediction.status === 'processing') {
        const late = deadlineError('poll', deadline - pollMs, prediction.id);
        if (late) throw late;
        if (!prediction.urls?.get) throw new Error('Replicate prediction has no polling URL');
        await sleep(pollMs);
        const polled = await request(
          prediction.urls.get,
          { headers },
          'poll',
          deadline,
          prediction.id,
        );
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
      const image = await request(url, {}, 'download', deadline, prediction.id);
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
