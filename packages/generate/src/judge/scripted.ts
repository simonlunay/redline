import type { JudgeRequest, JudgeVerdict, PairRequest, PairVerdict, VisualJudge } from './types.js';

/**
 * A judge that returns queued answers (or computes them from the request) and records every
 * request: used in tests and offline runs. Answers run out to "ship, no findings" / "tie".
 */
export function createScriptedJudge(
  verdicts: (JudgeVerdict | ((req: JudgeRequest) => JudgeVerdict))[] = [],
  pairs: (PairVerdict | ((req: PairRequest) => PairVerdict))[] = [],
): VisualJudge & { requests: JudgeRequest[]; pairRequests: PairRequest[] } {
  const requests: JudgeRequest[] = [];
  const pairRequests: PairRequest[] = [];
  return {
    name: 'scripted',
    requests,
    pairRequests,
    async judge(req) {
      requests.push(req);
      const next = verdicts.shift();
      const v =
        typeof next === 'function'
          ? next(req)
          : (next ?? { verdict: 'ship' as const, summary: 'Looks fine.', findings: [] });
      return { ...v, calls: 1, costUsd: 0 };
    },
    async compare(req) {
      pairRequests.push(req);
      const next = pairs.shift();
      const v =
        typeof next === 'function'
          ? next(req)
          : (next ?? { better: 'tie' as const, confidence: 'low' as const, reasons: '' });
      return { ...v, calls: 1, costUsd: 0 };
    },
  };
}
