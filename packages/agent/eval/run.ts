/**
 * Fix-loop evaluation: `npm run eval -- [options]`
 *
 * For every fixture it measures four approaches with the same precise checker the CLI uses:
 *   before      the original design
 *   rules once  apply the checker's suggested fixes once (no LLM)
 *   rules loop  the fix loop with the deterministic suggested-fixes editor (no LLM)
 *   <model>     the fix loop with Claude, once per --runs
 * The two rules columns are deterministic; LLM columns vary between runs, so use --runs N and
 * report means. Results are saved as JSON (with git commit and settings) to track over time.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_ATTENTION_MINIMUMS, applyFixes } from '@simonlunay/redline';
import type { Design, Report } from '@simonlunay/redline';
import pc from 'picocolors';
import { DEFAULT_EFFORT, DEFAULT_MODEL, createAnthropicEditor } from '../src/editors/anthropic.js';
import type { Effort } from '../src/editors/anthropic.js';
import { createSuggestedFixesEditor, suggestedEdits } from '../src/editors/suggested.js';
import { toFix } from '../src/edits.js';
import { runFixLoop } from '../src/loop.js';
import { createFixSession, loadDotEnv } from '../src/node/session.js';
import { estimateCostUsd } from '../src/pricing.js';
import type { LoopResult, TokenUsage } from '../src/types.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = join(ROOT, 'fixtures');
const RESULTS = fileURLToPath(new URL('./results/', import.meta.url));

const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    effort: { type: 'string' },
    runs: { type: 'string' },
    target: { type: 'string' },
    'max-iterations': { type: 'string' },
    fixtures: { type: 'string' },
    concurrency: { type: 'string' },
    'no-llm': { type: 'boolean' },
    'no-vision': { type: 'boolean' },
    'no-save': { type: 'boolean' },
    attention: { type: 'boolean' },
    strict: { type: 'boolean' },
  },
});

// --strict: the harder benchmark. Target 100 (every warning counts), attention rules on, and
// one more iteration, so models are separated and rollback gets exercised in real runs.
const strict = Boolean(values.strict);
const attention = strict || Boolean(values.attention);
const target = Number(values.target ?? (strict ? 100 : 90));
const maxIterations = Number(values['max-iterations'] ?? (strict ? 5 : 4));
const runs = Number(values.runs ?? 1);
const effort = (values.effort ?? DEFAULT_EFFORT) as Effort;
const concurrency = Number(values.concurrency ?? 3);
const vision = !values['no-vision'];

loadDotEnv(join(ROOT, '.env'));
let models = values['no-llm']
  ? []
  : (values.models ?? DEFAULT_MODEL).split(',').map((m) => m.trim());
let llmSkipped: string | null = values['no-llm'] ? 'disabled with --no-llm' : null;
if (models.length > 0 && !process.env.ANTHROPIC_API_KEY) {
  llmSkipped = 'ANTHROPIC_API_KEY not set';
  models = [];
}

const fixtureFiles = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .filter((f) => {
    if (!values.fixtures) return true;
    const name = basename(f, '.json');
    // Comma-separated names; a trailing * matches a prefix, e.g. --fixtures 'hard-*'.
    return values.fixtures
      .split(',')
      .some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
  })
  .sort();

// ---------------------------------------------------------------------------------------------

interface Outcome {
  score: number;
  errors: number;
  warnings: number;
  /** Goal from the loop: score >= target and no errors (or no issues at all). */
  reachedGoal: boolean;
  failingRules: string[];
  /** Predicted attention (only with --attention / --strict). */
  attention?: AttentionMetrics;
}

interface AttentionMetrics {
  /** Share of predicted attention per key role, 0-1 (absent roles omitted). */
  cta?: number;
  headline?: number;
  product?: number;
  /** 1-based position of the CTA in the predicted viewing order. */
  ctaRank?: number;
}

function attentionMetrics(report: Report): AttentionMetrics | undefined {
  const details = report.rules.find((r) => r.ruleId === 'attention-key-elements')?.details;
  if (!details) return undefined;
  const shares = details.roleShares as Record<string, number>;
  const order = details.viewingOrder as string[];
  const metrics: AttentionMetrics = {};
  for (const role of ['cta', 'headline', 'product'] as const) {
    if (shares[role] !== undefined) metrics[role] = shares[role];
  }
  if (order.includes('cta')) metrics.ctaRank = order.indexOf('cta') + 1;
  return metrics;
}

interface LoopOutcome extends Outcome {
  iterations: number;
  calls: number;
  stopReason: string;
  rolledBack: number;
  usage: TokenUsage;
  costUsd: number | null;
  durationMs: number;
  /** Model ids the API reported; must equal the requested model (no fallbacks). */
  modelsSeen: string[];
  steps: { iteration: number; status: string; score: number; edits: number; note?: string }[];
  edits: { iteration: number; op: string; reason: string }[];
  /** The best design the loop produced, so results can be inspected/rendered without rerunning. */
  bestDesign: Design;
  error?: string;
}

function outcome(report: Report): Outcome {
  return {
    score: report.score,
    errors: report.summary.errors,
    warnings: report.summary.warnings,
    reachedGoal:
      report.issues.length === 0 || (report.score >= target && report.summary.errors === 0),
    failingRules: [
      ...new Set(report.issues.filter((i) => i.severity !== 'info').map((i) => i.ruleId)),
    ].sort(),
    ...(attention ? { attention: attentionMetrics(report) } : {}),
  };
}

function loopOutcome(result: LoopResult, model?: string): LoopOutcome {
  const accepted = result.history.filter((h) => h.status === 'accepted');
  return {
    ...outcome(result.best.report),
    iterations: result.totals.iterations,
    calls: result.totals.calls,
    stopReason: result.stopReason,
    rolledBack: result.history.filter((h) => h.status === 'rolled-back').length,
    usage: result.totals.usage,
    costUsd: model ? estimateCostUsd(model, result.totals.usage) : null,
    durationMs: result.totals.durationMs,
    modelsSeen: [...new Set(result.history.flatMap((h) => (h.model ? [h.model] : [])))],
    steps: result.history.map((h) => ({
      iteration: h.iteration,
      status: h.status,
      score: h.scoreAfter,
      edits: h.edits.length,
      ...(h.note ? { note: h.note } : {}),
    })),
    edits: accepted.flatMap((h) =>
      h.edits.map((e) => ({ iteration: h.iteration, op: e.op, reason: e.reason })),
    ),
    bestDesign: result.best.design,
    ...(result.error ? { error: result.error } : {}),
  };
}

interface FixtureRow {
  fixture: string;
  before: Outcome;
  rulesOnce: Outcome;
  rulesLoop: LoopOutcome;
  llm: Record<string, LoopOutcome[]>;
}

/** Runs `tasks` with at most `limit` in flight, keeping result order. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

const client = models.length > 0 ? new Anthropic({ maxRetries: 6 }) : undefined;

async function evalFixture(file: string): Promise<FixtureRow> {
  const name = basename(file, '.json');
  const session = await createFixSession(join(FIXTURES, file), { attention });
  const design = session.loaded.design;
  const initial = await session.check(design);

  const once = applyFixes(design, suggestedEdits(initial).map(toFix)).design;
  const rulesOnce = outcome(await session.check(once));
  const loopOptions = { check: session.check, target, maxIterations };
  const rulesLoop = loopOutcome(
    await runFixLoop(design, { ...loopOptions, editor: createSuggestedFixesEditor() }),
  );

  const llm: Record<string, LoopOutcome[]> = {};
  for (const model of models) {
    llm[model] = [];
    for (let run = 1; run <= runs; run++) {
      const editor = createAnthropicEditor({ model, effort, client });
      const result = await runFixLoop(design, {
        ...loopOptions,
        editor,
        renderImages: vision ? session.renderImages : undefined,
      });
      llm[model]!.push(loopOutcome(result, model));
      const line = `  ${name} · ${model} run ${run}: ${initial.score} → ${result.best.report.score}`;
      process.stderr.write(`${pc.dim(line)}\n`);
    }
  }
  if (models.length === 0) process.stderr.write(`${pc.dim(`  ${name} done`)}\n`);
  return { fixture: name, before: outcome(initial), rulesOnce, rulesLoop, llm };
}

// ---------------------------------------------------------------------------------------------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt1 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const round1 = (n: number) => Number(n.toFixed(1));

function summarize(outcomes: Outcome[]) {
  const withAttention = outcomes.flatMap((o) => (o.attention ? [o.attention] : []));
  const shares = (role: 'cta' | 'headline') =>
    withAttention.flatMap((a) => (a[role] === undefined ? [] : [a[role]! * 100]));
  const ranked = withAttention.filter((a) => a.ctaRank !== undefined);
  return {
    meanScore: round1(mean(outcomes.map((o) => o.score))),
    totalErrors: outcomes.reduce((s, o) => s + o.errors, 0),
    reachedGoal: outcomes.filter((o) => o.reachedGoal).length,
    ...(withAttention.length > 0
      ? {
          attention: {
            /** Mean share of predicted attention, in percent. */
            meanCtaShare: round1(mean(shares('cta'))),
            meanHeadlineShare: round1(mean(shares('headline'))),
            /** Designs where the CTA is predicted to be seen first or second. */
            ctaInTopTwo: ranked.filter((a) => a.ctaRank! <= 2).length,
            withCta: ranked.length,
            /** Designs whose CTA / headline is below the attention-key-elements minimum. */
            ctaBelowMinimum: withAttention.filter(
              (a) => a.cta !== undefined && a.cta < DEFAULT_ATTENTION_MINIMUMS.cta!,
            ).length,
            headlineBelowMinimum: withAttention.filter(
              (a) => a.headline !== undefined && a.headline < DEFAULT_ATTENTION_MINIMUMS.headline!,
            ).length,
          },
        }
      : {}),
  };
}

/** "CTA 4.2% · H 31%" (single) or "CTA 9.1% (6.0–12.3) · H 27%" (several runs). */
function attentionCell(outcomes: Outcome[]): string {
  const values = (role: 'cta' | 'headline') =>
    outcomes.flatMap((o) => (o.attention?.[role] === undefined ? [] : [o.attention[role]! * 100]));
  const part = (label: string, xs: number[]) => {
    if (xs.length === 0) return `${label} –`;
    const m = `${label} ${fmt1(round1(mean(xs)))}%`;
    return xs.length === 1
      ? m
      : `${m} (${fmt1(round1(Math.min(...xs)))}–${fmt1(round1(Math.max(...xs)))})`;
  };
  return `${part('CTA', values('cta'))} · ${part('H', values('headline'))}`;
}

function cell(o: Outcome): string {
  const text = `${o.score}/${o.errors}`;
  return o.reachedGoal ? pc.green(text) : o.errors > 0 ? text : pc.yellow(text);
}

/** "mean (min-max)" for multiple runs. */
function llmCell(outcomes: LoopOutcome[]): string {
  if (outcomes.length === 1)
    return `${cell(outcomes[0]!)} ${pc.dim(`${outcomes[0]!.iterations}it`)}`;
  const scores = outcomes.map((o) => o.score);
  return `${fmt1(mean(scores))} (${Math.min(...scores)}-${Math.max(...scores)}) /${fmt1(mean(outcomes.map((o) => o.errors)))}`;
}

const visibleLength = (s: string) => stripVTControlCharacters(s).length;
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - visibleLength(s)));

function printTable(rows: FixtureRow[]) {
  const headers = ['Fixture', 'Before', 'Rules once', 'Rules loop', ...models];
  const body = rows.map((r) => [
    r.fixture,
    cell(r.before),
    cell(r.rulesOnce),
    `${cell(r.rulesLoop)} ${pc.dim(`${r.rulesLoop.iterations}it`)}`,
    ...models.map((m) => llmCell(r.llm[m]!)),
  ]);
  const allLlm = (m: string) => rows.flatMap((r) => r.llm[m]!);
  const summaryCell = (s: ReturnType<typeof summarize>) =>
    `${s.meanScore}/${s.totalErrors} ${pc.dim(`${s.reachedGoal}✓`)}`;
  const summaryRow = [
    pc.bold('mean score / errors, ✓ = goal'),
    summaryCell(summarize(rows.map((r) => r.before))),
    summaryCell(summarize(rows.map((r) => r.rulesOnce))),
    summaryCell(summarize(rows.map((r) => r.rulesLoop))),
    ...models.map((m) => summaryCell(summarize(allLlm(m)))),
  ];
  const widths = headers.map((h, i) =>
    Math.max(visibleLength(h), ...[...body, summaryRow].map((row) => visibleLength(row[i]!))),
  );
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join('  ');
  console.log('');
  console.log(pc.bold(line(headers)));
  console.log(pc.dim(widths.map((w) => '─'.repeat(w)).join('  ')));
  body.forEach((row) => console.log(line(row)));
  console.log(pc.dim(widths.map((w) => '─'.repeat(w)).join('  ')));
  console.log(line(summaryRow));
  console.log(
    pc.dim(`\n  cells: score/errors · it = iterations · goal = score ≥ ${target} with no errors`),
  );

  for (const m of models) {
    const outcomes = allLlm(m);
    const cost = outcomes.reduce((s, o) => s + (o.costUsd ?? 0), 0);
    const calls = outcomes.reduce((s, o) => s + o.calls, 0);
    const rolled = outcomes.reduce((s, o) => s + o.rolledBack, 0);
    const mismatched = outcomes.filter((o) => o.modelsSeen.some((seen) => seen !== m)).length;
    console.log(
      `\n  ${pc.bold(m)}: ${calls} calls · ${rolled} rolled-back iterations · ≈ $${cost.toFixed(2)}` +
        pc.dim(` · ${(rolled / outcomes.length).toFixed(2)} rollbacks/run`) +
        (mismatched ? pc.red(` · ${mismatched} runs answered by another model!`) : ''),
    );
    for (const r of rows) {
      const failing = [...new Set(r.llm[m]!.flatMap((o) => o.failingRules))];
      if (failing.length)
        console.log(pc.dim(`    ${r.fixture}: still failing ${failing.join(', ')}`));
    }
  }
  if (attention) printAttentionTable(rows);

  const rulesFailing = rows.filter((r) => r.rulesLoop.failingRules.length > 0);
  console.log(pc.bold('\n  rules loop') + pc.dim(' still failing:'));
  for (const r of rulesFailing) {
    console.log(pc.dim(`    ${r.fixture}: ${r.rulesLoop.failingRules.join(', ')}`));
  }
}

/** Predicted attention per fixture: CTA and headline shares before/after each approach. */
function printAttentionTable(rows: FixtureRow[]) {
  const headers = ['Fixture (attention)', 'Before', 'Rules loop', ...models];
  const body = rows.map((r) => [
    r.fixture,
    attentionCell([r.before]),
    attentionCell([r.rulesLoop]),
    ...models.map((m) => attentionCell(r.llm[m]!)),
  ]);
  const summary = (outcomes: Outcome[]) => {
    const a = summarize(outcomes).attention;
    return a
      ? `CTA ${a.meanCtaShare}% · H ${a.meanHeadlineShare}% ${pc.dim(`top2 ${a.ctaInTopTwo}/${a.withCta} · low ${a.ctaBelowMinimum}/${a.headlineBelowMinimum}`)}`
      : '–';
  };
  const summaryRow = [
    pc.bold('mean · CTA seen 1st/2nd'),
    summary(rows.map((r) => r.before)),
    summary(rows.map((r) => r.rulesLoop)),
    ...models.map((m) => summary(rows.flatMap((r) => r.llm[m]!))),
  ];
  const widths = headers.map((h, i) =>
    Math.max(visibleLength(h), ...[...body, summaryRow].map((row) => visibleLength(row[i]!))),
  );
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join('  ');
  console.log('');
  console.log(pc.bold(line(headers)));
  console.log(pc.dim(widths.map((w) => '─'.repeat(w)).join('  ')));
  body.forEach((row) => console.log(line(row)));
  console.log(pc.dim(widths.map((w) => '─'.repeat(w)).join('  ')));
  console.log(line(summaryRow));
  console.log(
    pc.dim(
      '\n  CTA / H = share of predicted attention (MSI-Net) on the CTA / headline of the best design' +
        '\n  top2 = CTA predicted to be seen 1st or 2nd · low = designs whose CTA / headline is below the rule minimum',
    ),
  );
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------

console.error(
  pc.bold(
    `redline eval${strict ? ' --strict' : ''}: ${fixtureFiles.length} fixtures · target ${target} · max ${maxIterations} iterations${attention ? ' · attention on' : ''}`,
  ) +
    pc.dim(
      models.length
        ? ` · ${models.join(', ')} (effort ${effort}, ${runs} run${runs > 1 ? 's' : ''}, vision ${vision ? 'on' : 'off'})`
        : ` · LLM skipped: ${llmSkipped}`,
    ),
);
const started = Date.now();
const rows = await pool(
  fixtureFiles.map((f) => () => evalFixture(f)),
  concurrency,
);
printTable(rows);
if (llmSkipped) console.log(pc.yellow(`\n  LLM columns skipped: ${llmSkipped}.`));

const results = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  git: { commit: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])) },
  node: process.version,
  settings: { strict, attention, target, maxIterations, effort, runs, vision, models, llmSkipped },
  durationMs: Date.now() - started,
  summary: {
    before: summarize(rows.map((r) => r.before)),
    rulesOnce: summarize(rows.map((r) => r.rulesOnce)),
    rulesLoop: summarize(rows.map((r) => r.rulesLoop)),
    ...Object.fromEntries(
      models.map((m) => [
        m,
        {
          ...summarize(rows.flatMap((r) => r.llm[m]!)),
          costUsd: Number(
            rows
              .flatMap((r) => r.llm[m]!)
              .reduce((s, o) => s + (o.costUsd ?? 0), 0)
              .toFixed(4),
          ),
        },
      ]),
    ),
  },
  fixtures: rows,
};

if (!values['no-save']) {
  mkdirSync(RESULTS, { recursive: true });
  const stamp = results.createdAt.replace(/[:.]/g, '-');
  const label = `${strict ? 'strict_' : ''}${models.length ? models.join('+') : 'baselines'}`;
  const file = join(RESULTS, `${stamp}_${label}.json`);
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  console.log(pc.dim(`\n  saved ${file.replace(ROOT, '')}`));
}
