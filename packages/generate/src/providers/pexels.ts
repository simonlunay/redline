import type { FetchLike, GeneratedImage, ImageProvider, ImageRequest } from './types.js';

/** pexels.com/license (checked 2026-10-06): free to use, attribution appreciated, not required. */
export const PEXELS_LICENSE =
  'Pexels License (free to use, no attribution required; identifiable people/brands need care)';

export interface PexelsOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
}

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  src: { original: string; large2x: string; large: string };
}

/**
 * Stock photos from the Pexels search API. Uses the slot's short `query`, picks a result whose
 * orientation matches the canvas, and uses the seed to choose among the top results so
 * best-of-N candidates get different photos. Free; cost is 0. Subjects can't be cut out of
 * arbitrary stock photos reliably, so this provider is meant for backgrounds.
 */
export function createPexelsProvider(options: PexelsOptions): ImageProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    id: 'pexels',
    model: 'pexels-search-v1',
    license: PEXELS_LICENSE,
    estimateCostUsd: () => 0,
    async generate(req: ImageRequest): Promise<GeneratedImage> {
      const query = (req.query ?? req.prompt).split(/\s+/).slice(0, 8).join(' ');
      const orientation =
        req.width > req.height * 1.15
          ? 'landscape'
          : req.height > req.width * 1.15
            ? 'portrait'
            : 'square';
      const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=15`;
      const response = await fetchImpl(url, { headers: { Authorization: options.apiKey } });
      if (!response.ok) throw new Error(`Pexels search failed: HTTP ${response.status}`);
      const { photos } = (await response.json()) as { photos: PexelsPhoto[] };
      if (!photos?.length) throw new Error(`Pexels found no photos for "${query}"`);
      const photo = photos[Math.abs(req.seed) % photos.length]!;
      const image = await fetchImpl(photo.src.large2x);
      if (!image.ok)
        throw new Error(`Downloading Pexels photo ${photo.id} failed: HTTP ${image.status}`);
      return {
        bytes: new Uint8Array(await image.arrayBuffer()),
        mimeType: image.headers.get('content-type') ?? 'image/jpeg',
        provider: 'pexels',
        model: 'pexels-search-v1',
        seed: null,
        costUsd: 0,
        license: PEXELS_LICENSE,
        sourceUrl: photo.url,
        attribution: `Photo by ${photo.photographer} on Pexels`,
      };
    },
  };
}
