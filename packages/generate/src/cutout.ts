/** A subject with its background removed: PNG with alpha, trimmed to the visible pixels. */
export interface Cutout {
  png: Uint8Array;
  width: number;
  height: number;
  /** Fraction of the original image area that stayed opaque (sanity check: ~0 or ~1 is suspicious). */
  coverage: number;
  /** Which remover actually made it, when a wrapper (the auto remover) chose between several. */
  remover?: { id: string; model: string; license: string };
  /** Why a fallback remover was used for this cutout (shown as a warning). */
  fallbackReason?: string;
}

/** Removes the background around a subject. BiRefNet locally, or a plain-backdrop keyer. */
export interface BackgroundRemover {
  id: string;
  model: string;
  license: string;
  remove(image: Uint8Array): Promise<Cutout>;
}
