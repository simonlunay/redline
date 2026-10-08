import type { JudgeCallInfo, PairVerdict, VisualJudge } from './types.js';

export interface PairOutcome {
  /** "a" or "b" when both orders agree on it, otherwise "tie". */
  winner: 'a' | 'b' | 'tie';
  /** Both orders gave the same answer (including both "tie"). */
  agreed: boolean;
  /** Each order's answer mapped back to a/b, in the order they were asked. */
  orders: {
    shownFirst: 'a' | 'b';
    better: 'a' | 'b' | 'tie';
    confidence: string;
    reasons: string;
  }[];
  costUsd: number;
  calls: number;
}

/** Small seeded PRNG (mulberry32) so a run's shuffling is reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Blind pairwise comparison of two renders, A and B. The judge sees only the two images, as
 * "Image 1" and "Image 2", and the prompt: no labels like before/after, no issues, no scores.
 * Each pair is judged in both orders (which one goes first is shuffled with `random`), and a
 * side only wins when both orders pick it, which cancels the judge's position bias.
 */
export async function comparePair(
  judge: VisualJudge,
  prompt: string,
  a: Uint8Array,
  b: Uint8Array,
  random: () => number,
): Promise<PairOutcome> {
  const firstShown: 'a' | 'b' = random() < 0.5 ? 'a' : 'b';
  const orders: PairOutcome['orders'] = [];
  let costUsd = 0;
  let calls = 0;
  for (const shownFirst of [firstShown, firstShown === 'a' ? 'b' : 'a'] as const) {
    const [first, second] = shownFirst === 'a' ? [a, b] : [b, a];
    const v: PairVerdict & JudgeCallInfo = await judge.compare({ prompt, first, second });
    const other = shownFirst === 'a' ? 'b' : 'a';
    orders.push({
      shownFirst,
      better: v.better === 'tie' ? 'tie' : v.better === '1' ? shownFirst : other,
      confidence: v.confidence,
      reasons: v.reasons,
    });
    costUsd += v.costUsd ?? 0;
    calls += v.calls;
  }
  const agreed = orders[0]!.better === orders[1]!.better;
  return { winner: agreed ? orders[0]!.better : 'tie', agreed, orders, costUsd, calls };
}
