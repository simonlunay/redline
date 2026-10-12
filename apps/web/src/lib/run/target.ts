import type { RunRecord } from '../gallery/types';

/**
 * The score each recorded run was aiming for (with no errors). Not stored in the records, so
 * it's taken from how they were run: the generate eval's default target is 95
 * (packages/generate/eval/run.ts), and every gallery fix run used the strict target of 100
 * (scripts/record-fix-runs.ts, and the strict fix eval).
 */
export function runTarget(record: Pick<RunRecord, 'kind'>): number {
  return record.kind === 'fix' ? 100 : 95;
}
