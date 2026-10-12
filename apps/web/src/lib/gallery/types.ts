/**
 * The gallery's data format: one RunRecord per replayable run, written by scripts/build-gallery.ts
 * and read by the player. Generate runs and fix runs share it, so one player replays both, and a
 * live backend could later stream the same steps (see lib/run/source.ts).
 */
import type { Design, ImageAnalysis, Issue, Report, RuleIssue } from '@simonlunay/redline';

export const GALLERY_SCHEMA_VERSION = 1;

/** What the stored attention rules returned for one snapshot (replayed by frozen rules). */
export interface FrozenRuleOutput {
  issues: RuleIssue[];
  elementScores?: Record<string, number>;
  details?: Record<string, unknown>;
}

/** A design at one point of a run, with everything needed to show and re-check it. */
/**
 * Which rules a snapshot is checked with. Candidates are scored before a winner exists, so the
 * key-element rule (a planned key element must stay visible) only applies from the fix loop on.
 */
export type RuleSet = 'candidate' | 'loop';

export interface Snapshot {
  /** Key into RunRecord.snapshots: a hash of the design plus its rule set, stored once. */
  id: string;
  ruleSet: RuleSet;
  design: Design;
  /** The rules' report, re-checked by the gallery build with today's checker (no judge). */
  report: Report;
  /** Attention rule outputs for this exact design, so the browser can replay them. */
  attention?: Record<string, FrozenRuleOutput>;
  /** Heatmap of predicted attention: an 8-bit grayscale PNG, relative to the run folder. */
  heatmap?: string;
}

export interface JudgeFindingRecord {
  category: string;
  severity: 'high' | 'medium' | 'low';
  elementId?: string;
  box?: { x: number; y: number; width: number; height: number };
  description: string;
  suggestion?: string;
}

export interface JudgmentRecord {
  round: number;
  verdict: 'ship' | 'fix' | 'reject';
  summary: string;
  findings: JudgeFindingRecord[];
  /** The rules score the judge saw, as recorded during the run. */
  rulesScore: number;
}

export interface EditRecord {
  op: string;
  elementId?: string;
  reason?: string;
  /** Everything else the op carried (dx/dy, color, size, brief...). */
  params: Record<string, unknown>;
}

export interface StepRecord {
  iteration: number;
  status: 'initial' | 'accepted' | 'rolled-back' | 'invalid' | 'no-change';
  /** Scores as recorded during the run (generate runs: including the judge's findings). */
  recordedScoreBefore: number;
  recordedScoreAfter: number;
  summary?: string;
  edits: EditRecord[];
  /**
   * The strict eval kept each edit's op and reason but not its element or values. The player
   * then shows the reasons as recorded and the changes it computes from the two designs.
   */
  editValuesMissing?: boolean;
  durationMs?: number;
  note?: string;
  snapshot: string;
}

export interface LoopRecord {
  editor: string;
  stopReason: string;
  steps: StepRecord[];
  bestIteration: number;
}

export interface CandidateRecord {
  index: number;
  layoutName: string;
  recordedScore: number;
  errors: number;
  warnings: number;
  ctaShare?: number;
  snapshot: string;
}

export interface PlanRecord {
  concept: string;
  palette: Record<string, string>;
  copy: Record<string, string>;
  layouts: { name: string; rationale?: string }[];
}

/** How a run ended, in plain words. Drives the gallery's honest labels and its order. */
export type Outcome =
  | 'shipped' // generate: the judge would ship the final design
  | 'judge-fix' // generate: the judge still asked for fixes
  | 'judge-reject'
  | 'solved' // fix: reached the target with no errors
  | 'unsolved'; // fix: stopped short of the target

export interface RunRecord {
  schemaVersion: typeof GALLERY_SCHEMA_VERSION;
  id: string;
  kind: 'generate' | 'fix';
  title: string;
  /** Generate: the user's prompt. */
  prompt?: string;
  /** Fix: the fixture the run started from (also a sample on /check). */
  fixture?: string;
  canvas: { width: number; height: number };
  outcome: Outcome;
  /** One sentence on what still looks wrong, in the judge's or the loop's own terms. */
  outcomeNote?: string;
  /** Where the data came from (results file), and anything a reader should know about it. */
  provenance: { source: string; model?: string; recordedAt: string; notes: string[] };
  /** Gallery order: lower first. */
  rank: number;
  plan?: PlanRecord;
  candidates?: CandidateRecord[];
  /** Candidate indexes, best first. */
  ranking?: number[];
  winner?: number;
  loop: LoopRecord;
  /** Fix runs: the rules-only loop on the same design, for the side-by-side comparison. */
  rulesLoop?: LoopRecord;
  judgments?: JudgmentRecord[];
  final: string;
  /** Recorded first, best-of-N and final scores, for the card and the summary. */
  scores: { first: number; bestOfN?: number; final: number };
  /** Rules the build checked with, so the browser checks with the same ones. */
  rules: RunRules;
  /** Per image src (relative to the run folder): its analysis, for the image rules. */
  images: Record<string, { width: number; height: number; analysis?: ImageAnalysis }>;
  snapshots: Record<string, Snapshot>;
  durationMs?: number;
}

export interface RunRules {
  attention: boolean;
  imageChecks: boolean;
  /** Generate runs: copy may only state facts the prompt gives (copy-grounded). */
  copyGrounded?: { sources: string[] };
  /** Generate runs: the winner's key elements must stay visible (key-element-visible). */
  keyElements?: { snapshot: string };
}

/** A sample design on /check, with its precomputed attention and heatmap. */
export interface SampleRecord {
  schemaVersion: typeof GALLERY_SCHEMA_VERSION;
  id: string;
  title: string;
  snapshot: Snapshot;
  rules: RunRules;
  images: RunRecord['images'];
  /** The gallery run that started from this design, if any. */
  run?: string;
}

/** The small index the gallery page loads. */
export interface GalleryEntry {
  id: string;
  kind: RunRecord['kind'];
  title: string;
  prompt?: string;
  fixture?: string;
  canvas: RunRecord['canvas'];
  outcome: Outcome;
  outcomeNote?: string;
  scores: RunRecord['scores'];
  rank: number;
  /** Final design's thumbnail (WebP), relative to the gallery folder. */
  thumbnail: string;
}

export interface GalleryIndex {
  schemaVersion: typeof GALLERY_SCHEMA_VERSION;
  builtAt: string;
  runs: GalleryEntry[];
  /** Sample fixtures on /check, and the gallery run (if any) that started from each. */
  samples: { id: string; title: string; canvas: RunRecord['canvas']; run?: string }[];
}

export type { Design, Issue, Report };
