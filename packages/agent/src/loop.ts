import { applyFixes, parseDesign } from '@simonlunay/redline';
import type { Design, Issue, Report } from '@simonlunay/redline';
import { parseEditResponse, protectedFieldViolations, toFix } from './edits.js';
import type { EditResponse } from './edits.js';
import type {
  AttemptFeedback,
  CopyEditRecord,
  DesignEditor,
  DesignImage,
  EditorResponse,
  IterationRecord,
  LoopResult,
  RegenerableImage,
  RegeneratedImage,
  RegenerationRecord,
  ReplaceTextEdit,
  StopReason,
  TokenUsage,
} from './types.js';

/** Default cap on image regenerations per run (generation mode). */
export const DEFAULT_MAX_REGENERATIONS = 2;

/**
 * Generation mode: lets the editor replace generated images with new ones made from a revised
 * brief. Without this option (`redline fix` on user designs) the regenerateImage op doesn't
 * exist in the edit schema and the src guardrail never allows an image change.
 */
export interface RegenerateOptions {
  /** Max regenerations per run, counted when attempted (they cost money). Default 2. */
  max?: number;
  /** The images of `design` that may be regenerated, with their current briefs. */
  images: (design: Design) => RegenerableImage[];
  /** Makes the new image. Throwing marks the attempt as failed; the loop carries on. */
  run: (request: {
    design: Design;
    elementId: string;
    brief: string;
    reason: string;
    iteration: number;
  }) => Promise<RegeneratedImage>;
}

/**
 * Generation mode: lets the editor replace parts of the (generated) copy, e.g. an invented date
 * with a placeholder. `redline fix` never sets it, so user copy stays untouchable there.
 */
export interface CopyEditOptions {
  /** Why this replacement isn't allowed, or null to allow it. Called on the current design. */
  check: (edit: ReplaceTextEdit, design: Design) => string | null;
}

export interface LoopOptions {
  editor: DesignEditor;
  /** Checks a design. Async so slow rules (e.g. a future saliency model) fit in. */
  check: (design: Design) => Promise<Report>;
  /** Stop once the score reaches this AND no errors remain. Default 90. */
  target?: number;
  /** Max editor iterations (not counting the initial check). Default 4. */
  maxIterations?: number;
  /** Stop after this many iterations in a row without improvement. Default 2. */
  maxStaleIterations?: number;
  /** Optional: images of the current design for vision-capable editors. */
  renderImages?: (design: Design, report: Report) => Promise<DesignImage[]>;
  /** Called after every iteration (including the initial check), e.g. for live output. */
  onIteration?: (record: IterationRecord) => void;
  /** Generation mode only: allow regenerateImage edits. */
  regenerate?: RegenerateOptions;
  /** Generation mode only: allow replaceText edits that pass this check. */
  copy?: CopyEditOptions;
}

/** Fields every iteration record shares, known before the edits are applied. */
type StepCommon = Pick<IterationRecord, 'iteration' | 'scoreBefore' | 'usage' | 'model' | 'calls'>;
/** Fields that depend on what happened when the edits were applied. */
type StepOutcome = Pick<
  IterationRecord,
  'status' | 'design' | 'report' | 'scoreAfter' | 'edits' | 'rejected' | 'insertedIds'
> & { note?: string };

const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function addUsage(total: TokenUsage, usage?: TokenUsage): void {
  if (!usage) return;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
}

/** Done = good enough (score at target and no errors) or nothing left to fix. */
export function goalReached(report: Report, target: number): StopReason | null {
  if (report.issues.length === 0) return 'no-issues';
  if (report.score >= target && report.summary.errors === 0) return 'target-reached';
  return null;
}

/** Higher score wins; ties go to fewer errors. */
function isBetter(a: Report, b: Report): boolean {
  if (a.score !== b.score) return a.score > b.score;
  return a.summary.errors < b.summary.errors;
}

const issueKey = (i: Issue) => `${i.ruleId}:${i.elementIds.join(',')}`;

/** Issues present in `after` that were not in `before`: what an attempt broke. */
export function newIssues(before: Report, after: Report): Issue[] {
  const seen = new Set(before.issues.map(issueKey));
  return after.issues.filter((i) => !seen.has(issueKey(i)));
}

function describeNewIssues(issues: Issue[]): string {
  if (issues.length === 0) return '';
  const list = issues
    .slice(0, 5)
    .map((i) => `[${i.ruleId}] ${i.message}`)
    .join('; ');
  return ` It introduced: ${list}`;
}

/**
 * The self-critique loop: check -> ask the editor for edits -> apply -> re-check, keeping an
 * iteration only if the score does not drop. Returns the best design seen plus a complete,
 * replayable history (every step stores a full design snapshot and its report).
 */
export async function runFixLoop(input: unknown, options: LoopOptions): Promise<LoopResult> {
  const target = options.target ?? 90;
  const maxIterations = options.maxIterations ?? 4;
  const maxStale = options.maxStaleIterations ?? 2;
  const started = Date.now();
  const regen = options.regenerate;
  const maxRegenerations = regen?.max ?? DEFAULT_MAX_REGENERATIONS;
  let regenerationsUsed = 0;
  /** Elements whose src was changed by an accepted regeneration. */
  const regeneratedIds = new Set<string>();
  /** Text elements whose content was changed by an accepted replaceText. */
  const rewrittenIds = new Set<string>();

  const initialDesign = parseDesign(input);
  const initialReport = await options.check(initialDesign);
  const history: IterationRecord[] = [];
  const totalUsage = emptyUsage();
  let calls = 0;

  const record = (r: IterationRecord) => {
    history.push(r);
    addUsage(totalUsage, r.usage);
    calls += r.calls;
    options.onIteration?.(r);
  };

  record({
    iteration: 0,
    status: 'initial',
    design: initialDesign,
    report: initialReport,
    scoreBefore: initialReport.score,
    scoreAfter: initialReport.score,
    edits: [],
    rejected: [],
    insertedIds: [],
    calls: 0,
    durationMs: 0,
  });

  let current = { design: initialDesign, report: initialReport };
  let best = { ...current, iteration: 0 };
  const attempts: AttemptFeedback[] = [];
  let stale = 0;
  let stopReason: StopReason | null = goalReached(initialReport, target);
  let error: string | undefined;

  for (let iteration = 1; iteration <= maxIterations && !stopReason; iteration++) {
    const stepStarted = Date.now();
    const base = { iteration, scoreBefore: current.report.score };

    // 1. Ask the editor, validating its output; one retry with the validation error.
    let response: EditorResponse;
    let parsed: ReturnType<typeof parseEditResponse>;
    let stepCalls = 0;
    const stepUsage = emptyUsage();
    try {
      const images = options.renderImages
        ? await options.renderImages(current.design, current.report)
        : undefined;
      const request = {
        design: current.design,
        report: current.report,
        target,
        iteration,
        attempts: attempts.slice(-4),
        images,
        ...(regen
          ? {
              regeneration: {
                images: regen.images(current.design),
                remaining: Math.max(0, maxRegenerations - regenerationsUsed),
                max: maxRegenerations,
              },
            }
          : {}),
        ...(options.copy ? { copyEdits: true } : {}),
      };
      const parseOptions = { regenerate: Boolean(regen), copy: Boolean(options.copy) };
      response = await options.editor.proposeEdits(request);
      stepCalls++;
      addUsage(stepUsage, response.usage);
      parsed = parseEditResponse(response.raw, parseOptions);
      if (!parsed.ok) {
        response = await options.editor.proposeEdits({ ...request, validationError: parsed.error });
        stepCalls++;
        addUsage(stepUsage, response.usage);
        parsed = parseEditResponse(response.raw, parseOptions);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      stopReason = 'editor-error';
      break;
    }

    const common = {
      ...base,
      usage: stepUsage,
      model: response.model,
      calls: stepCalls,
    };

    if (!parsed.ok) {
      const note = `Invalid response twice. ${parsed.error}`;
      attempts.push({ iteration, outcome: 'invalid', message: note });
      record({
        ...common,
        status: 'invalid',
        design: current.design,
        report: current.report,
        scoreAfter: current.report.score,
        edits: [],
        rejected: [],
        insertedIds: [],
        note,
        durationMs: Date.now() - stepStarted,
      });
      stale++;
    } else {
      stale = await applyStep(parsed.value, common, stepStarted);
    }

    if (!stopReason) stopReason = goalReached(current.report, target);
    if (!stopReason && stale >= maxStale) stopReason = 'no-improvement';
  }

  /** Applies one validated response; returns the updated stale counter. */
  async function applyStep(
    response: EditResponse,
    common: StepCommon,
    stepStarted: number,
  ): Promise<number> {
    const { iteration } = common;
    const edits = response.edits;
    const regenerations: RegenerationRecord[] = [];
    const copyEdits: CopyEditRecord[] = [];
    const finish = (r: StepOutcome) =>
      record({
        ...common,
        ...r,
        summary: response.summary,
        ...(regenerations.length > 0 ? { regenerations } : {}),
        ...(copyEdits.length > 0 ? { copyEdits } : {}),
        durationMs: Date.now() - stepStarted,
      });

    if (
      edits.length === 0 &&
      response.regenerations.length === 0 &&
      response.copyEdits.length === 0
    ) {
      const note = 'The editor proposed no edits.';
      attempts.push({ iteration, outcome: 'no-edits', message: note });
      finish({
        status: 'no-edits',
        design: current.design,
        report: current.report,
        scoreAfter: current.report.score,
        edits,
        rejected: [],
        insertedIds: [],
        note,
      });
      return stale + 1;
    }

    // Regenerations first: later layout edits may depend on the new image.
    let working = current.design;
    const stepRegenerated = new Set<string>();
    const regenerable = new Set(regen ? regen.images(current.design).map((i) => i.elementId) : []);
    for (const r of response.regenerations) {
      const base = { elementId: r.elementId, brief: r.brief, reason: r.reason };
      const reject = (note: string) => regenerations.push({ ...base, status: 'rejected', note });
      if (!regen) {
        reject('Image regeneration is only available in generation mode.');
        continue;
      }
      if (regenerationsUsed >= maxRegenerations) {
        reject(`Regeneration cap reached (${maxRegenerations} per run); use layout edits instead.`);
        continue;
      }
      if (!regenerable.has(r.elementId) || stepRegenerated.has(r.elementId)) {
        reject(
          `"${r.elementId}" is not a regenerable image (or was already regenerated this step).`,
        );
        continue;
      }
      regenerationsUsed++;
      const target = working.elements.find((el) => el.id === r.elementId);
      const previousSrc = target?.type === 'image' ? target.src : undefined;
      try {
        const image = await regen.run({ design: working, ...base, iteration });
        working = {
          ...working,
          elements: working.elements.map((el) =>
            el.id === r.elementId && el.type === 'image'
              ? {
                  ...el,
                  src: image.src,
                  naturalWidth: image.naturalWidth,
                  naturalHeight: image.naturalHeight,
                }
              : el,
          ),
        };
        stepRegenerated.add(r.elementId);
        regenerations.push({
          ...base,
          status: 'applied',
          ...(previousSrc ? { previousSrc } : {}),
          src: image.src,
          ...(image.costUsd !== undefined ? { costUsd: image.costUsd } : {}),
        });
      } catch (err) {
        regenerations.push({
          ...base,
          status: 'failed',
          note: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const notApplied = regenerations.filter((r) => r.status !== 'applied');
    if (notApplied.length > 0) {
      attempts.push({
        iteration,
        outcome: 'rejected-edits',
        message: `${notApplied.length} regeneration(s) did not run: ${notApplied
          .map((r) => `${r.elementId}: ${r.note}`)
          .join('; ')}`,
      });
    }

    // Copy fixes next (generation mode): exact substring replacements the pipeline allows.
    const stepRewritten = new Set<string>();
    for (const c of response.copyEdits) {
      const base = { elementId: c.elementId, find: c.find, replace: c.replace, reason: c.reason };
      const el = working.elements.find((e) => e.id === c.elementId);
      const problem = !options.copy
        ? 'Text replacement is only available in generation mode.'
        : el?.type !== 'text'
          ? `"${c.elementId}" is not a text element.`
          : !el.content.includes(c.find)
            ? `"${c.find}" does not occur in the text of "${c.elementId}" (match it exactly).`
            : options.copy.check(c, working);
      if (problem || el?.type !== 'text') {
        copyEdits.push({ ...base, status: 'rejected', note: problem ?? 'not a text element' });
        continue;
      }
      const content = el.content.replace(c.find, () => c.replace);
      working = {
        ...working,
        elements: working.elements.map((e) => (e.id === el.id ? { ...el, content } : e)),
      };
      stepRewritten.add(el.id);
      copyEdits.push({ ...base, status: 'applied' });
    }
    const rejectedCopy = copyEdits.filter((c) => c.status === 'rejected');
    if (rejectedCopy.length > 0) {
      attempts.push({
        iteration,
        outcome: 'rejected-edits',
        message: `${rejectedCopy.length} text replacement(s) were refused: ${rejectedCopy
          .map((c) => `${c.elementId} "${c.find}": ${c.note}`)
          .join('; ')}`,
      });
    }

    const applied = applyFixes(working, edits.map(toFix));
    const violations = protectedFieldViolations(
      initialDesign,
      applied.design,
      new Set([...regeneratedIds, ...stepRegenerated]),
      new Set([...rewrittenIds, ...stepRewritten]),
    );
    const candidateReport = await options.check(applied.design);
    const step = {
      design: applied.design,
      report: candidateReport,
      scoreAfter: candidateReport.score,
      edits,
      rejected: applied.rejected,
      insertedIds: applied.insertedIds,
    };

    if (applied.rejected.length > 0) {
      const reasons = applied.rejected
        .slice(0, 5)
        .map((r) => `${JSON.stringify(r.fix)} -> ${r.reason}`)
        .join('; ');
      attempts.push({
        iteration,
        outcome: 'rejected-edits',
        message: `${applied.rejected.length} edit(s) could not be applied: ${reasons}`,
      });
    }

    let rollback: string | null = null;
    if (applied.applied.length === 0 && stepRegenerated.size === 0 && stepRewritten.size === 0) {
      rollback = 'None of the edits could be applied.';
    } else if (violations.length > 0) {
      rollback = `Guardrail violation: ${violations.join('; ')}.`;
    } else if (candidateReport.score < current.report.score) {
      rollback =
        `Score dropped from ${current.report.score} to ${candidateReport.score}, so the attempt was rolled back.` +
        describeNewIssues(newIssues(current.report, candidateReport));
    }

    if (rollback) {
      attempts.push({ iteration, outcome: 'rolled-back', message: rollback });
      finish({ ...step, status: 'rolled-back', note: rollback });
      return stale + 1;
    }

    const improved =
      candidateReport.score > current.report.score ||
      candidateReport.summary.errors < current.report.summary.errors;
    current = { design: applied.design, report: candidateReport };
    for (const id of stepRegenerated) regeneratedIds.add(id);
    for (const id of stepRewritten) rewrittenIds.add(id);
    if (isBetter(candidateReport, best.report)) best = { ...current, iteration };
    finish({ ...step, status: 'accepted' });
    return improved ? 0 : stale + 1;
  }

  return {
    initial: { design: initialDesign, report: initialReport },
    best,
    history,
    stopReason: stopReason ?? 'max-iterations',
    ...(error ? { error } : {}),
    totals: {
      iterations: history.length - 1,
      calls,
      ...(regen ? { regenerations: regenerationsUsed } : {}),
      usage: totalUsage,
      durationMs: Date.now() - started,
    },
  };
}
