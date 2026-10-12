import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Design } from '@simonlunay/redline';
import { describe, expect, it } from 'vitest';
import { countShipped, shippedStats } from '../eval/shipped.js';
import type { Judgment } from '../src/node/pipeline.js';
import { reviewedDesign, shippedJudgment } from '../src/node/pipeline.js';

const design = (x: number): Design =>
  ({
    version: '0.1',
    canvas: { width: 100, height: 100, background: '#ffffff' },
    elements: [
      {
        id: 'box',
        type: 'shape',
        kind: 'rect',
        x,
        y: 0,
        width: 10,
        height: 10,
        fill: '#000000',
      },
    ],
  }) as Design;
const judgment = (round: number, verdict: Judgment['verdict']): Judgment => ({
  round,
  verdict,
  summary: '',
  findings: [],
  rulesScore: 100,
  rulesErrors: 0,
});
const step = (status: string, x: number) => ({ status, design: design(x) });

describe('the judge verdict on the shipped design', () => {
  // Two loops: x 0 → 1, then x 1 → 2. Round 0 saw x 0, round 1 x 1, round 2 x 2.
  const history = [
    step('initial', 0),
    step('accepted', 1),
    step('initial', 1),
    step('accepted', 2),
  ];
  const judgments = [judgment(0, 'fix'), judgment(1, 'ship'), judgment(2, 'fix')];

  it('recovers each round’s reviewed design from the loop history', () => {
    const loop = { history, bestIteration: 3 };
    expect(reviewedDesign(loop, 0)).toEqual(design(0));
    expect(reviewedDesign(loop, 1)).toEqual(design(1));
    expect(reviewedDesign(loop, 2)).toEqual(design(2));
  });

  it('counts the round the final pick kept, not the last review', () => {
    // The final pick kept round 1's design; the last review (round 2) said fix.
    const record = { judgments, finalJudgeRound: 1, final: { design: design(1) } };
    const loop = { history, bestIteration: 3 };
    expect(shippedJudgment({ ...record, loop })?.round).toBe(1);
    // Without finalJudgeRound (older records), the shipped design is matched to the reviews.
    expect(shippedJudgment({ ...record, finalJudgeRound: null, loop })?.round).toBe(1);
    expect(shippedStats({ ...record, loop })).toEqual({
      judgeShippedRound: 1,
      judgeShipped: 'ship',
    });
  });

  it('has no verdict when no review saw the shipped design', () => {
    const loop = { history: history.slice(0, 2), bestIteration: 1 };
    const record = { judgments: [judgment(0, 'ship')], final: { design: design(1) }, loop };
    expect(shippedJudgment(record)).toBeUndefined();
    expect(shippedStats(record)).toEqual({});
  });

  it('takes the latest review when several saw the same design', () => {
    // The loop changed nothing and the judge looked twice: ship, then fix.
    const loop = { history: [step('initial', 0)], bestIteration: 0 };
    const record = {
      judgments: [judgment(0, 'ship'), judgment(1, 'fix')],
      final: { design: design(0) },
      loop,
    };
    expect(shippedJudgment(record)?.round).toBe(1);
    // With finalJudgeRound, the pick's own choice wins.
    expect(shippedJudgment({ ...record, finalJudgeRound: 0 })?.verdict).toBe('ship');
  });

  it('counts only shipped designs the judge said ship', () => {
    // ship → fix with round 0 kept counts; the old last-verdict counter missed it.
    const rows = [{ judgeShipped: 'ship' }, { judgeShipped: 'fix' }, {}, { judgeShipped: 'ship' }];
    expect(countShipped(rows)).toBe(2);
  });
});

describe('saved generate eval results', () => {
  const dir = fileURLToPath(new URL('../eval/results/', import.meta.url));
  const files = readdirSync(dir).filter((f) => /_generate_.*\.json$/.test(f));
  interface Saved {
    summary: { judge?: { finalShip: number } };
    prompts: { ok: boolean; judgeVerdicts?: string[]; judgeShipped?: string }[];
  }
  const load = (f: string) => JSON.parse(readFileSync(dir + f, 'utf8')) as Saved;

  it('every judged row records its shipped verdict, and finalShip counts them', () => {
    let checked = 0;
    for (const f of files) {
      const saved = load(f);
      if (!saved.summary.judge) continue;
      const judged = saved.prompts.filter((r) => r.ok && r.judgeVerdicts?.length);
      for (const r of judged) expect(r.judgeShipped, f).toBeDefined();
      expect(saved.summary.judge.finalShip, f).toBe(countShipped(saved.prompts));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('matches the ship counts in docs/evaluation.md', () => {
    const count = (...names: string[]) =>
      names.reduce(
        (s, n) => s + load(files.find((f) => f.includes(n))!).summary.judge!.finalShip,
        0,
      );
    expect(count('T18-00-25-677Z', 'T18-28-47-917Z')).toBe(6); // run 2
    expect(count('T01-50-47-382Z', 'T01-57-32-671Z')).toBe(8); // run 3
    expect(count('T03-00-16-784Z', 'T03-32-59-260Z')).toBe(9); // run 4
  });
});
