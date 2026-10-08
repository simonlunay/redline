import type { TokenUsage } from '@simonlunay/redline-agent';
import { z } from 'zod';

/**
 * The vision judge: a model that looks at the finished render and reports what looks wrong,
 * independently of the rules and of the fixer. It never sees the fixer's reasoning, the edit
 * history, the art director's plan or any score.
 */

export const FINDING_CATEGORIES = [
  'fake-text',
  'cutout',
  'artifact',
  'cropping',
  'color',
  'composition',
  'legibility',
  'other',
] as const;

export const JudgeFindingSchema = z.object({
  category: z.enum(FINDING_CATEGORIES),
  /** high: a client would reject it; medium: clearly visible, should be fixed; low: minor. */
  severity: z.enum(['high', 'medium', 'low']),
  /** The element involved, from the element table, or null for the design as a whole. */
  elementId: z.string().nullable(),
  /** Where it is, in canvas px, or null. */
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(),
  description: z.string(),
  suggestion: z.enum(['regenerate-image', 'recut', 'layout', 'none']),
});
export type JudgeFinding = z.infer<typeof JudgeFindingSchema>;

export const JudgeVerdictSchema = z.object({
  /** ship: fine as is; fix: has problems worth fixing; reject: clearly broken. */
  verdict: z.enum(['ship', 'fix', 'reject']),
  /** One or two sentences. */
  summary: z.string(),
  findings: z.array(JudgeFindingSchema),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export const PairVerdictSchema = z.object({
  /** Which image is the better finished design: "1", "2", or "tie". */
  better: z.enum(['1', '2', 'tie']),
  confidence: z.enum(['low', 'medium', 'high']),
  reasons: z.string(),
});
export type PairVerdict = z.infer<typeof PairVerdictSchema>;

/** One row of the element table the judge gets, so findings can name an element. */
export interface JudgeElement {
  id: string;
  type: 'text' | 'image' | 'shape';
  role?: string;
  box: { x: number; y: number; width: number; height: number };
  /** Text content (texts only). */
  text?: string;
}

/** An issue the rules already report, so the judge reports what they missed instead. */
export interface JudgeKnownIssue {
  ruleId: string;
  severity: string;
  message: string;
  elementIds: string[];
}

export interface JudgeRequest {
  /** The user's prompt: what the design is for. */
  prompt: string;
  canvas: { width: number; height: number };
  /** The clean render (no annotations), PNG. */
  png: Uint8Array;
  elements: JudgeElement[];
  issues: JudgeKnownIssue[];
}

export interface PairRequest {
  prompt: string;
  /** Shown as "Image 1" and "Image 2", in this order. Callers shuffle. */
  first: Uint8Array;
  second: Uint8Array;
}

export interface JudgeCallInfo {
  model?: string;
  usage?: TokenUsage;
  costUsd?: number;
  /** Calls made (2 when the first answer was invalid). */
  calls: number;
}

export interface VisualJudge {
  name: string;
  judge(request: JudgeRequest): Promise<JudgeVerdict & JudgeCallInfo>;
  compare(request: PairRequest): Promise<PairVerdict & JudgeCallInfo>;
}
