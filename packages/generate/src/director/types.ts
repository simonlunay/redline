import type { TokenUsage } from '@simonlunay/redline-agent';
import type { DesignPlan } from '../plan.js';

/** An image the user supplied: a logo, a product shot, a photo to use. */
export interface UserImageInfo {
  id: string;
  /** "logo" images are placed as the logo; others are free for the art director to use. */
  use: 'logo' | 'image';
  width: number;
  height: number;
  /** Optional note from the user, e.g. "our running shoe". */
  description?: string;
  /** Small PNG preview so a vision model can see it. */
  preview?: Uint8Array;
}

export interface CreativeBrief {
  prompt: string;
  canvas: { width: number; height: number };
  /** How many alternative layouts to plan. */
  layouts: number;
  /** Font families that can be rendered (Inter is always bundled). */
  fonts: string[];
  brandColors?: string[];
  userImages?: UserImageInfo[];
}

export interface DirectorResult {
  plan: DesignPlan;
  /** Model that produced it, as reported by the API. */
  model?: string;
  usage?: TokenUsage;
  calls: number;
  costUsd?: number;
  /** Validation errors of a first, rejected answer (if a retry was needed). */
  retriedAfter?: string;
  /** Layouts dropped because they were unusable; the plan kept the others. */
  droppedLayouts?: string;
}

/** The art director couldn't produce a usable plan. `attempts` has each try's problems. */
export class ArtDirectorError extends Error {
  readonly attempts: string[];
  constructor(attempts: string[]) {
    super(
      `The art director's plan was invalid on all ${attempts.length} tries.\n${attempts
        .map((a, i) => `Try ${i + 1}: ${a}`)
        .join('\n')}`,
    );
    this.name = 'ArtDirectorError';
    this.attempts = attempts;
  }
}

/** Turns a creative brief into a design plan: Claude, or the deterministic template director. */
export interface ArtDirector {
  name: string;
  plan(brief: CreativeBrief): Promise<DirectorResult>;
}

/** Inter weights bundled with the checker. */
export const BUNDLED_FONTS = ['Inter'];
