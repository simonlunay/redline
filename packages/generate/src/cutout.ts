/** A subject with its background removed: PNG with alpha, trimmed to the visible pixels. */
export interface Cutout {
  png: Uint8Array;
  width: number;
  height: number;
  /** Fraction of the original image area that stayed opaque (sanity check: ~0 or ~1 is suspicious). */
  coverage: number;
  /** Which remover actually made it, when a wrapper (the auto remover) chose between several. */
  remover?: { id: string; model: string; license: string; kind?: RemoverKind };
  /** Why a fallback remover was used for this cutout (shown as a warning). */
  fallbackReason?: string;
}

/**
 * What a remover is: a segmentation model (BiRefNet, local or hosted) or the plain-backdrop
 * keyer. A model cut is never replaced by a keyed re-cut, and its cutout-quality verdict is
 * capped at a warning.
 */
export type RemoverKind = 'model' | 'keyer';

/** Removes the background around a subject. BiRefNet locally, or a plain-backdrop keyer. */
export interface BackgroundRemover {
  id: string;
  model: string;
  license: string;
  /** Unset for wrappers that choose per cut (the auto remover); each cut's `remover` says. */
  kind?: RemoverKind;
  remove(image: Uint8Array): Promise<Cutout>;
}
