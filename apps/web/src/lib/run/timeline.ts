/**
 * Turns a run record into the frames the player steps through. Pure: the state at any frame
 * depends only on the record and the frame's index, so seeking and stepping always agree.
 */
import type { RunRecord, StepRecord } from '../gallery/types';

export type FrameKind = 'plan' | 'candidate' | 'winner' | 'judge' | 'step' | 'final';

export interface Frame {
  kind: FrameKind;
  /** The design on the stage (a key into record.snapshots). */
  snapshot?: string;
  /** The design this frame changed (edited elements are marked in blue). */
  previous?: string;
  /** Candidates visible in the strip (generate runs). */
  revealed: number;
  /** Index into record.candidates (candidate frames). */
  candidate?: number;
  /** Index into record.judgments (judge frames). */
  judgment?: number;
  /** Index into record.loop.steps (step frames). */
  step?: number;
  /** Short description for the timeline and screen readers. */
  label: string;
  /** How long the player holds this frame at 1×. */
  holdMs: number;
}

export const HOLD_MS: Record<FrameKind, number> = {
  plan: 2600,
  candidate: 1000,
  winner: 1600,
  judge: 3000,
  step: 2600,
  final: 3000,
};

const STATUS_LABEL: Record<StepRecord['status'], string> = {
  initial: 'start',
  accepted: 'accepted',
  'rolled-back': 'rolled back',
  invalid: 'invalid',
  'no-change': 'no change',
};

function stepFrames(record: RunRecord, revealed: number, includeInitial: boolean): Frame[] {
  const frames: Frame[] = [];
  const steps = record.loop.steps;
  let current = steps[0]?.snapshot;
  steps.forEach((step, i) => {
    if (step.status === 'initial') {
      if (includeInitial) {
        frames.push({
          kind: 'step',
          snapshot: step.snapshot,
          revealed,
          step: i,
          label: `Before: ${step.recordedScoreAfter}`,
          holdMs: HOLD_MS.step,
        });
      }
      current = step.snapshot;
      return;
    }
    frames.push({
      kind: 'step',
      snapshot: step.snapshot,
      ...(current ? { previous: current } : {}),
      revealed,
      step: i,
      label: `Fix ${step.iteration}: ${STATUS_LABEL[step.status]}, ${step.recordedScoreBefore} → ${step.recordedScoreAfter}`,
      holdMs: HOLD_MS.step,
    });
    if (step.status === 'accepted') current = step.snapshot;
  });
  return frames;
}

export function buildTimeline(record: RunRecord): Frame[] {
  if (record.kind === 'fix') {
    const frames = stepFrames(record, 0, true);
    const best = record.loop.steps.find((s) => s.snapshot === record.final);
    frames.push({
      kind: 'final',
      snapshot: record.final,
      previous: record.loop.steps[0]!.snapshot,
      revealed: 0,
      label: `Best: ${best?.recordedScoreAfter ?? record.scores.final}`,
      holdMs: HOLD_MS.final,
    });
    return frames;
  }

  const candidates = record.candidates ?? [];
  const frames: Frame[] = [
    { kind: 'plan', revealed: 0, label: 'Art direction', holdMs: HOLD_MS.plan },
  ];
  candidates.forEach((c, i) => {
    frames.push({
      kind: 'candidate',
      snapshot: c.snapshot,
      revealed: i + 1,
      candidate: i,
      label: `Candidate ${c.index + 1}: ${c.recordedScore}`,
      holdMs: HOLD_MS.candidate,
    });
  });
  const winnerAt = candidates.findIndex((c) => c.index === record.winner);
  const winner = candidates[winnerAt];
  const loopStart = record.loop.steps[0]?.snapshot;
  frames.push({
    kind: 'winner',
    ...(loopStart ? { snapshot: loopStart } : winner ? { snapshot: winner.snapshot } : {}),
    revealed: candidates.length,
    ...(winnerAt >= 0 ? { candidate: winnerAt } : {}),
    label: `Winner: candidate ${(record.winner ?? 0) + 1}`,
    holdMs: HOLD_MS.winner,
  });

  const judgments = record.judgments ?? [];
  const judgeFrame = (j: number, snapshot: string | undefined): Frame => ({
    kind: 'judge',
    ...(snapshot ? { snapshot } : {}),
    revealed: candidates.length,
    judgment: j,
    label: `Judge, review ${judgments[j]!.round + 1}: ${judgments[j]!.verdict}`,
    holdMs: HOLD_MS.judge,
  });
  // Review 0 looks at the winner; later reviews at the loop's result.
  judgments.forEach((j, i) => {
    if (j.round === 0) frames.push(judgeFrame(i, loopStart));
  });
  const steps = stepFrames(record, candidates.length, false);
  frames.push(...steps);
  const loopEnd = steps.length ? steps.at(-1)!.snapshot : loopStart;
  judgments.forEach((j, i) => {
    if (j.round > 0) frames.push(judgeFrame(i, loopEnd));
  });
  frames.push({
    kind: 'final',
    snapshot: record.final,
    ...(loopStart && loopStart !== record.final ? { previous: loopStart } : {}),
    revealed: candidates.length,
    label: `Final: ${record.scores.final}`,
    holdMs: HOLD_MS.final,
  });
  return frames;
}

/** Index of the frame shown at `elapsedMs` into playback at `speed`, and the time into it. */
export function frameAt(frames: Frame[], elapsedMs: number, speed = 1): number {
  let t = elapsedMs * speed;
  for (let i = 0; i < frames.length; i++) {
    t -= frames[i]!.holdMs;
    if (t < 0) return i;
  }
  return frames.length - 1;
}

/** Playback time at which frame `index` starts, at `speed`. */
export function startOf(frames: Frame[], index: number, speed = 1): number {
  let t = 0;
  for (let i = 0; i < index && i < frames.length; i++) t += frames[i]!.holdMs;
  return t / speed;
}
