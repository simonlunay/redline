import { applyFixes, parseDesign } from '@simonlunay/redline';
import type { Design, Issue, Report } from '@simonlunay/redline';
import { parseEditResponse, protectedFieldViolations, toFix } from './edits.js';
import type { EditResponse } from './edits.js';
import type {
  AttemptFeedback,
  DesignEditor,
  DesignImage,
  EditorResponse,
  IterationRecord,
  LoopResult,
  StopReason,
  TokenUsage,
} from './types.js';

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
      };
      response = await options.editor.proposeEdits(request);
      stepCalls++;
      addUsage(stepUsage, response.usage);
      parsed = parseEditResponse(response.raw);
      if (!parsed.ok) {
        response = await options.editor.proposeEdits({ ...request, validationError: parsed.error });
        stepCalls++;
        addUsage(stepUsage, response.usage);
        parsed = parseEditResponse(response.raw);
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
    const finish = (r: StepOutcome) =>
      record({ ...common, ...r, summary: response.summary, durationMs: Date.now() - stepStarted });

    if (edits.length === 0) {
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

    const applied = applyFixes(current.design, edits.map(toFix));
    const violations = protectedFieldViolations(initialDesign, applied.design);
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
    if (applied.applied.length === 0) {
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
      usage: totalUsage,
      durationMs: Date.now() - started,
    },
  };
}
