import type { Design, Fix, RejectedFix, Report } from '@simonlunay/redline';

/** A fix op plus a short explanation from whoever proposed it (LLM or rules). */
export type Edit = Fix & { reason: string };

/** Generation mode only: ask for a new image for an element, from a revised brief. */
export interface RegenerateEdit {
  op: 'regenerateImage';
  elementId: string;
  brief: string;
  reason: string;
}

/**
 * Generation mode only: replace part of a text's content, e.g. an invented date with a
 * placeholder. Which replacements are allowed is decided by LoopOptions.copy.
 */
export interface ReplaceTextEdit {
  op: 'replaceText';
  elementId: string;
  find: string;
  replace: string;
  reason: string;
}

/** One replaceText attempt, recorded in history. */
export interface CopyEditRecord {
  elementId: string;
  find: string;
  replace: string;
  reason: string;
  status: 'applied' | 'rejected';
  note?: string;
}

/** An image the editor may regenerate (generation mode), with the brief it was made from. */
export interface RegenerableImage {
  elementId: string;
  role?: string;
  kind: 'background' | 'subject';
  brief: string;
}

/** What a regeneration produced. The loop swaps it into the element. */
export interface RegeneratedImage {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  costUsd?: number;
}

/** One regeneration attempt, recorded in history whether or not it stuck. */
export interface RegenerationRecord {
  elementId: string;
  brief: string;
  reason: string;
  status: 'applied' | 'rejected' | 'failed';
  previousSrc?: string;
  src?: string;
  costUsd?: number;
  note?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** What the loop tells the editor about a previous attempt that did not stick. */
export interface AttemptFeedback {
  iteration: number;
  outcome: 'rolled-back' | 'invalid' | 'no-edits' | 'rejected-edits';
  message: string;
}

/** A labeled image of the current design for vision-capable editors. */
export interface DesignImage {
  /** Short caption telling the model what it is looking at. */
  label: string;
  png: Uint8Array;
}

export interface EditRequest {
  design: Design;
  report: Report;
  target: number;
  iteration: number;
  /** Earlier attempts that were rolled back or invalid, oldest first. */
  attempts: AttemptFeedback[];
  /** Set on the retry after an invalid response: what was wrong with it. */
  validationError?: string;
  /** Optional PNGs of the current design, e.g. the annotated render and an attention heatmap. */
  images?: DesignImage[];
  /** Generation mode: images the editor may regenerate, and how many regenerations are left. */
  regeneration?: { images: RegenerableImage[]; remaining: number; max: number };
  /** Generation mode: replaceText is available (for the copy problems the checker reports). */
  copyEdits?: boolean;
}

export interface EditorResponse {
  /** Unvalidated output, e.g. a tool call's input. The loop validates it. */
  raw: unknown;
  usage?: TokenUsage;
  /** Model that actually produced the response, for reproducible results. */
  model?: string;
}

/**
 * Anything that can propose edits: an LLM provider, the deterministic "apply the checker's
 * suggestions" editor, or a scripted editor in tests. Providers return raw output; validation
 * and guardrails live in the loop, so every provider gets exactly the same treatment.
 */
export interface DesignEditor {
  name: string;
  proposeEdits(request: EditRequest): Promise<EditorResponse>;
}

export type IterationStatus = 'initial' | 'accepted' | 'rolled-back' | 'invalid' | 'no-edits';

/** One step of the loop. Full design snapshots make history trivially replayable. */
export interface IterationRecord {
  iteration: number;
  status: IterationStatus;
  /** The design after this step's edits (for rolled-back steps: the discarded candidate). */
  design: Design;
  report: Report;
  scoreBefore: number;
  scoreAfter: number;
  edits: Edit[];
  /** The editor's one-line summary of its plan, if it gave one. */
  summary?: string;
  /** Edits applyFixes skipped (unknown id, wrong element type, ...). */
  rejected: RejectedFix[];
  /** Ids of shapes created by insertShape in this step. */
  insertedIds: string[];
  /** Generation mode: image regenerations requested in this step (they cost money even if rolled back). */
  regenerations?: RegenerationRecord[];
  /** Generation mode: text replacements requested in this step. */
  copyEdits?: CopyEditRecord[];
  /** Why a step was rolled back or invalid. */
  note?: string;
  usage?: TokenUsage;
  model?: string;
  /** LLM calls made in this step (2 when the first response was invalid). */
  calls: number;
  durationMs: number;
}

export type StopReason =
  'target-reached' | 'no-issues' | 'max-iterations' | 'no-improvement' | 'editor-error';

export interface LoopResult {
  initial: { design: Design; report: Report };
  /** The best design seen (highest score, then fewest errors). */
  best: { design: Design; report: Report; iteration: number };
  history: IterationRecord[];
  stopReason: StopReason;
  /** Set when stopReason is 'editor-error'. */
  error?: string;
  totals: {
    iterations: number;
    calls: number;
    /** Generation mode: regenerations attempted (each one costs an image). */
    regenerations?: number;
    usage: TokenUsage;
    durationMs: number;
  };
}
