/**
 * Blind pairwise judge eval: `npm run eval:pairwise -w packages/generate -- [options]`
 *
 * Takes the before/after pairs of a fix-loop eval (packages/agent/eval/results/*.json): each
 * fixture as it was, and the fix loop's best design. It renders both and asks the vision judge
 * which it would rather ship, seeing only the two images and the fixture's brief. No labels,
 * issues or scores. Each pair is judged in both orders, and a side wins only when both orders
 * agree. Reports the fixed version's win rate, ties, and how often the verdict flipped with the
 * order (position bias).
 *
 * Controls:
 *   identity    a design against itself: the only right answer is a tie
 *   rules-once  the LLM's fix against the checker's own suggestions applied once (no LLM)
 *
 * All calls go through the phase 5 spend ledger. --dry-run renders everything and prints the
 * plan without calling the API.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { applyFixes, parseDesign } from '@simonlunay/redline';
import type { Design } from '@simonlunay/redline';
import { renderPng } from '@simonlunay/redline/node';
import { suggestedEdits, toFix } from '@simonlunay/redline-agent';
import { createFixSession, loadDotEnv } from '@simonlunay/redline-agent/node';
import pc from 'picocolors';
import { DEFAULT_JUDGE_MODEL, createAnthropicJudge } from '../src/judge/anthropic.js';
import { comparePair, seededRandom } from '../src/judge/pairwise.js';
import type { PairOutcome } from '../src/judge/pairwise.js';
import { createFileLedger } from '../src/node/spend-file.js';
import { BudgetExceededError } from '../src/spend.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = join(ROOT, 'fixtures');
const RESULTS = fileURLToPath(new URL('./results/', import.meta.url));

const { values } = parseArgs({
  options: {
    results: {
      type: 'string',
      default:
        'packages/agent/eval/results/2026-10-07T01-25-38-380Z_strict_claude-sonnet-5-5+claude-opus-5-5.json',
    },
    run: { type: 'string', default: '0' },
    fixtures: { type: 'string' },
    model: { type: 'string', default: DEFAULT_JUDGE_MODEL },
    effort: { type: 'string', default: 'medium' },
    ledger: { type: 'string', default: join(RESULTS, 'spend-ledger-phase5.json') },
    cap: { type: 'string', default: '8' },
    seed: { type: 'string', default: '5' },
    'dry-run': { type: 'boolean' },
    'no-save': { type: 'boolean' },
  },
});

/** Short briefs for the fixtures (they have no prompt of their own). */
const BRIEFS: Record<string, string> = {
  'ad-sneaker-sale': 'social ad for a sneaker sale',
  'banner-saas': 'wide web banner for a SaaS product',
  'clean-poster': 'event poster',
  'competing-headline': 'promotional poster with one clear headline',
  'hard-attention-badge': 'promotional poster with a call to action',
  'hard-attention-burst': 'promotional poster with a call to action',
  'hard-busy-photo-tiny-cta': 'photo ad with a call to action',
  'hard-cluttered-flyer': 'promotional flyer',
  'hard-leaderboard': '728x90 leaderboard web banner ad',
  'hard-skyscraper': '300x1050 skyscraper web banner ad',
  'hard-story-hero': 'vertical social story ad with a call to action',
  'low-contrast-on-image': 'poster with text over a photo',
  misaligned: 'simple poster',
  'off-canvas': 'simple poster',
  'overlap-headline-product': 'product ad',
  'promo-food': 'food delivery promotion',
  'story-concert': 'vertical social story for a concert',
  'stretched-image': 'product ad',
  'text-overflow': 'poster with a headline and a button',
  'tiny-text': 'poster',
  worst: 'promotional poster',
};
const IDENTITY = ['clean-poster', 'promo-food', 'hard-story-hero'];
const RULES_ONCE = [
  'ad-sneaker-sale',
  'promo-food',
  'story-concert',
  'worst',
  'banner-saas',
  'low-contrast-on-image',
];

interface FixtureRow {
  fixture: string;
  llm: Record<string, { bestDesign?: unknown }[]>;
}
const fixResults = JSON.parse(readFileSync(join(ROOT, values.results!), 'utf8')) as {
  fixtures: FixtureRow[];
  settings: Record<string, unknown>;
};
const runIndex = Number(values.run);
const only = values.fixtures?.split(',');
const rows = fixResults.fixtures.filter((f) => !only || only.includes(f.fixture));

loadDotEnv(join(ROOT, '.env'));
const dry = Boolean(values['dry-run']);
if (!dry && !process.env.ANTHROPIC_API_KEY) {
  console.error(pc.red('ANTHROPIC_API_KEY is needed (or use --dry-run).'));
  process.exit(2);
}
const ledger = createFileLedger(values.ledger!, Number(values.cap));
const judge = createAnthropicJudge({
  model: values.model,
  effort: values.effort as 'low' | 'medium' | 'high',
  ledger,
  tag: 'pairwise',
});
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(ROOT, 'out', 'eval-pairwise', stamp);
mkdirSync(outDir, { recursive: true });

/** Render scaled so the long side is at most 1024 px (about 1.4k image tokens). */
function render(
  design: Design,
  images: NonNullable<Parameters<typeof renderPng>[1]>['images'],
): Uint8Array {
  const long = Math.max(design.canvas.width, design.canvas.height);
  return new Uint8Array(renderPng(design, { images, scale: Math.min(1, 1024 / long) }));
}

/** Both renders side by side, for looking at the pairs afterwards (A left, B right). */
async function sideBySide(file: string, a: Uint8Array, b: Uint8Array) {
  const [ia, ib] = [await loadImage(Buffer.from(a)), await loadImage(Buffer.from(b))];
  const c = createCanvas(ia.width + ib.width + 20, Math.max(ia.height, ib.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(ia, 0, 0);
  ctx.drawImage(ib, ia.width + 20, 0);
  writeFileSync(file, await c.encode('png'));
}

interface Pair {
  kind: 'fix' | 'identity' | 'rules-once';
  fixture: string;
  model?: string;
  /** What A and B are. For kind "fix": A = before, B = after. */
  a: string;
  b: string;
  aPng: Uint8Array;
  bPng: Uint8Array;
}

const pairs: Pair[] = [];
for (const row of rows) {
  const session = await createFixSession(join(FIXTURES, `${row.fixture}.json`));
  const images = session.env.images;
  const before = session.loaded.design;
  const beforePng = render(before, images);
  for (const [model, runs] of Object.entries(row.llm)) {
    const best = runs[runIndex]?.bestDesign;
    if (!best) continue;
    const afterPng = render(parseDesign(best), images);
    pairs.push({
      kind: 'fix',
      fixture: row.fixture,
      model,
      a: 'before',
      b: 'after',
      aPng: beforePng,
      bPng: afterPng,
    });
    await sideBySide(join(outDir, `${row.fixture}__${model}.png`), beforePng, afterPng);
    if (RULES_ONCE.includes(row.fixture) && model === Object.keys(row.llm)[0]) {
      const report = await session.check(before);
      const once = applyFixes(before, suggestedEdits(report).map(toFix)).design;
      const oncePng = render(once, images);
      pairs.push({
        kind: 'rules-once',
        fixture: row.fixture,
        model,
        a: 'rules-once',
        b: 'after',
        aPng: oncePng,
        bPng: afterPng,
      });
      await sideBySide(
        join(outDir, `${row.fixture}__rules-once-vs-${model}.png`),
        oncePng,
        afterPng,
      );
    }
  }
  if (IDENTITY.includes(row.fixture)) {
    pairs.push({
      kind: 'identity',
      fixture: row.fixture,
      a: 'same',
      b: 'same',
      aPng: beforePng,
      bPng: beforePng,
    });
  }
}

console.error(
  pc.bold(
    `redline eval:pairwise: ${pairs.length} pairs (${pairs.filter((p) => p.kind === 'fix').length} before/after, ${pairs.filter((p) => p.kind === 'identity').length} identity, ${pairs.filter((p) => p.kind === 'rules-once').length} rules-once) · ${pairs.length * 2} judge calls`,
  ) +
    pc.dim(
      ` · ${values.model} (${values.effort}) · ledger $${ledger.spentUsd().toFixed(2)} of $${ledger.capUsd.toFixed(2)} · renders in ${outDir.replace(ROOT, '')}`,
    ),
);
if (dry) process.exit(0);

const random = seededRandom(Number(values.seed));
const results: (Omit<Pair, 'aPng' | 'bPng'> & { outcome?: PairOutcome; error?: string })[] = [];
let stopped: string | undefined;
for (const pair of pairs) {
  const { aPng, bPng, ...meta } = pair;
  if (stopped) {
    results.push({ ...meta, error: stopped });
    continue;
  }
  try {
    const outcome = await comparePair(
      judge,
      BRIEFS[pair.fixture] ?? 'graphic design',
      aPng,
      bPng,
      random,
    );
    results.push({ ...meta, outcome });
    process.stderr.write(
      pc.dim(
        `  ${pair.kind} ${pair.fixture}${pair.model ? ` (${pair.model})` : ''}: ${outcome.winner === 'a' ? pair.a : outcome.winner === 'b' ? pair.b : 'tie'}${outcome.agreed ? '' : ' (orders disagreed)'} · $${outcome.costUsd.toFixed(3)} · ledger $${ledger.spentUsd().toFixed(2)}\n`,
      ),
    );
  } catch (err) {
    if (err instanceof BudgetExceededError) stopped = err.message;
    results.push({ ...meta, error: (err as Error).message });
  }
}

const judged = results.filter((r) => r.outcome);
const of = (kind: Pair['kind']) => judged.filter((r) => r.kind === kind);
const count = (rs: typeof judged, w: 'a' | 'b' | 'tie') =>
  rs.filter((r) => r.outcome!.winner === w).length;
const calls = judged.flatMap((r) => r.outcome!.orders);
const firstPicks = calls.filter((o) => o.better === o.shownFirst).length;
const secondPicks = calls.filter((o) => o.better !== 'tie' && o.better !== o.shownFirst).length;
const fix = of('fix');
const byModel = Object.fromEntries(
  [...new Set(fix.map((r) => r.model!))].map((m) => {
    const rs = fix.filter((r) => r.model === m);
    return [
      m,
      {
        pairs: rs.length,
        afterWins: count(rs, 'b'),
        beforeWins: count(rs, 'a'),
        ties: count(rs, 'tie'),
      },
    ];
  }),
);
const summary = {
  pairs: judged.length,
  failed: results.length - judged.length,
  fix: {
    pairs: fix.length,
    afterWins: count(fix, 'b'),
    beforeWins: count(fix, 'a'),
    ties: count(fix, 'tie'),
    afterWinRate: fix.length ? Number((count(fix, 'b') / fix.length).toFixed(3)) : null,
    /** Excluding pairs where both versions are identical (fixtures the loop didn't change). */
    afterWinRateOfDecided:
      count(fix, 'a') + count(fix, 'b')
        ? Number((count(fix, 'b') / (count(fix, 'a') + count(fix, 'b'))).toFixed(3))
        : null,
    byModel,
  },
  identity: { pairs: of('identity').length, ties: count(of('identity'), 'tie') },
  rulesOnce: {
    pairs: of('rules-once').length,
    llmWins: count(of('rules-once'), 'b'),
    rulesOnceWins: count(of('rules-once'), 'a'),
    ties: count(of('rules-once'), 'tie'),
  },
  ordersDisagreed: judged.filter((r) => !r.outcome!.agreed).length,
  /** Of all single-order calls that picked a side: share that picked the image shown first. */
  firstShownPickRate:
    firstPicks + secondPicks ? Number((firstPicks / (firstPicks + secondPicks)).toFixed(3)) : null,
  costUsd: Number(judged.reduce((s, r) => s + r.outcome!.costUsd, 0).toFixed(4)),
  ledgerTotalUsd: Number(ledger.spentUsd().toFixed(4)),
  stopped: stopped ?? null,
};

console.log(
  `\n${pc.bold('Before/after (fix loop)')}  after wins ${summary.fix.afterWins}/${summary.fix.pairs} · before wins ${summary.fix.beforeWins} · ties ${summary.fix.ties}`,
);
for (const [m, s] of Object.entries(byModel))
  console.log(
    pc.dim(`  ${m}: after ${s.afterWins} · before ${s.beforeWins} · tie ${s.ties} of ${s.pairs}`),
  );
console.log(
  `${pc.bold('Identity controls')}  ties ${summary.identity.ties}/${summary.identity.pairs}`,
);
console.log(
  `${pc.bold('LLM fix vs rules once')}  LLM wins ${summary.rulesOnce.llmWins}/${summary.rulesOnce.pairs} · rules-once ${summary.rulesOnce.rulesOnceWins} · ties ${summary.rulesOnce.ties}`,
);
console.log(
  pc.dim(
    `  orders disagreed on ${summary.ordersDisagreed}/${summary.pairs} pairs · first-shown pick rate ${summary.firstShownPickRate} · cost $${summary.costUsd} · ledger $${summary.ledgerTotalUsd}${stopped ? ` · ${stopped}` : ''}`,
  ),
);

if (!values['no-save']) {
  const file = join(RESULTS, `${stamp}_pairwise_${values.model}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), source: basename(values.results!), run: runIndex, judge: { model: values.model, effort: values.effort }, seed: Number(values.seed), renders: outDir.replace(ROOT, ''), summary, pairs: results }, null, 2)}\n`,
  );
  console.log(pc.dim(`  saved ${file.replace(ROOT, '')}`));
}
