/**
 * The judge's verdict on the design that shipped. With a judge, the final pick can keep an earlier
 * round's design (see pickJudged), so the last review isn't always the one that counts.
 */
import { shippedJudgment } from '../src/node/pipeline.js';

/** Row fields for the review of the shipped design; none when no review saw it. */
export function shippedStats(record: Parameters<typeof shippedJudgment>[0]): {
  judgeShippedRound?: number;
  judgeShipped?: string;
} {
  const shipped = shippedJudgment(record);
  return shipped ? { judgeShippedRound: shipped.round, judgeShipped: shipped.verdict } : {};
}

/** Prompts whose shipped design the judge said ship. */
export function countShipped(rows: { judgeShipped?: string }[]): number {
  return rows.filter((r) => r.judgeShipped === 'ship').length;
}
