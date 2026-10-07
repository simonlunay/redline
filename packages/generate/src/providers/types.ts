export type ImageKind = 'background' | 'subject';

export interface ImageRequest {
  /** Full prompt (for stock providers, `query` is used instead). */
  prompt: string;
  /** Short search query for stock providers. */
  query?: string;
  /** Wanted size in px; providers return the closest size they support. */
  width: number;
  height: number;
  seed: number;
  kind: ImageKind;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  /** e.g. image/png, image/jpeg, image/webp */
  mimeType: string;
  provider: string;
  model: string;
  /** Seed actually used, or null when the provider has no seeds (stock photos). */
  seed: number | null;
  costUsd: number;
  license: string;
  /** Where it came from (stock photo page, prediction URL), if anywhere. */
  sourceUrl?: string;
  attribution?: string;
}

/**
 * Anything that produces an image for a slot: a hosted text-to-image model, a stock photo
 * search, or the deterministic mock used by tests. The cost estimate lets the spend guard
 * refuse a call before any money is spent.
 */
export interface ImageProvider {
  id: string;
  model: string;
  license: string;
  /** Upper-bound cost of one generate() call, in USD. */
  estimateCostUsd(request: ImageRequest): number;
  generate(request: ImageRequest): Promise<GeneratedImage>;
}

export type FetchLike = typeof fetch;

/** Closest of a provider's supported aspect ratios ("4:5") to width/height. */
export function closestAspectRatio(width: number, height: number, supported: readonly string[]): string {
  const target = Math.log(width / height);
  let best = supported[0]!;
  let bestDistance = Infinity;
  for (const ratio of supported) {
    const [w, h] = ratio.split(':').map(Number) as [number, number];
    const distance = Math.abs(Math.log(w / h) - target);
    if (distance < bestDistance) {
      best = ratio;
      bestDistance = distance;
    }
  }
  return best;
}
