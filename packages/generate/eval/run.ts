/**
 * Generation evaluation: `npm run eval:generate -- [options]`
 *
 * For every prompt in prompts.json it runs the whole pipeline (art director -> images ->
 * N candidates -> best-of-N -> fix loop) and reports:
 *   first      score of candidate #1 alone (what you'd get without best-of-N)
 *   best-of-N  score of the winning candidate
 *   final      score after the fix loop (with image regenerations allowed)
 * plus iterations, regenerations, CTA attention before/after the loop and cost.
 * All paid calls go through the persistent spend ledger (results/spend-ledger.json), so the
 * cap holds across runs. Renders go to out/eval-generate/<run>/<prompt>/ (gitignored).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { DEFAULT_ATTENTION_MINIMUMS } from '@simonlunay/redline';
import {
  DEFAULT_MODEL,
  createAnthropicEditor,
  createSuggestedFixesEditor,
} from '@simonlunay/redline-agent';
import type { Effort } from '@simonlunay/redline-agent';
import { loadDotEnv } from '@simonlunay/redline-agent/node';
import pc from 'picocolors';
import { createAnthropicArtDirector } from '../src/director/anthropic.js';
import { createTemplateArtDirector } from '../src/director/template.js';
import { createAutoRemover, createBackdropKeyRemover } from '../src/node/cutout.js';
import { parseSize, renderGenerationSteps } from '../src/node/generate-command.js';
import { createMockImageProvider } from '../src/node/mock-provider.js';
import { generateDesign } from '../src/node/pipeline.js';
import type { GenerationResult } from '../src/node/pipeline.js';
import { createFileLedger } from '../src/node/spend-file.js';
import { createWorkspace } from '../src/node/workspace.js';
import { createReplicateFluxProvider } from '../src/providers/replicate.js';
import { ctaShare } from '../src/select.js';
import { BudgetExceededError, withRunBudget } from '../src/spend.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RESULTS = fileURLToPath(new URL('./results/', import.meta.url));
const PROMPTS = JSON.parse(
  readFileSync(fileURLToPath(new URL('./prompts.json', import.meta.url)), 'utf8'),
) as { id: string; size: string; prompt: string }[];

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    effort: { type: 'string' },
    prompts: { type: 'string' },
    candidates: { type: 'string' },
    target: { type: 'string' },
    'max-iterations': { type: 'string' },
    'max-regenerations': { type: 'string' },
    concurrency: { type: 'string' },
    cap: { type: 'string' },
    budget: { type: 'string' },
    'min-free-mb': { type: 'string' },
    offline: { type: 'boolean' },
    'no-save': { type: 'boolean' },
    label: { type: 'string' },
  },
});

const offline = Boolean(values.offline);
const model = values.model ?? DEFAULT_MODEL;
const effort = (values.effort ?? 'medium') as Effort;
const candidates = Number(values.candidates ?? 4);
const target = Number(values.target ?? 95);
const maxIterations = Number(values['max-iterations'] ?? 4);
const maxRegenerations = Number(values['max-regenerations'] ?? 2);
const concurrency = Number(values.concurrency ?? 2);
const selected = values.prompts
  ? PROMPTS.filter((p) => values.prompts!.split(',').includes(p.id))
  : PROMPTS;

loadDotEnv(join(ROOT, '.env'));
if (!offline && (!process.env.ANTHROPIC_API_KEY || !process.env.REPLICATE_API_TOKEN)) {
  console.error(pc.red('ANTHROPIC_API_KEY and REPLICATE_API_TOKEN are needed (or use --offline).'));
  process.exit(2);
}
const fileLedger = createFileLedger(join(RESULTS, 'spend-ledger.json'), Number(values.cap ?? 15));
/** --budget caps this run on top of the shared ledger (whose stored cap only ever goes down). */
const ledger =
  values.budget === undefined ? fileLedger : withRunBudget(fileLedger, Number(values.budget));
const ledgerAtStart = ledger.spentUsd();
/** Below this much free memory no new prompt is started; the run stops and reports instead. */
const minFreeMb = Number(values['min-free-mb'] ?? 1500);
let stopped: string | undefined;
const remover = offline ? createBackdropKeyRemover() : createAutoRemover();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runLabel = values.label ?? (offline ? 'offline' : model);
const outRoot = join(ROOT, 'out', 'eval-generate', `${stamp}_${runLabel}`);

interface Row {
  id: string;
  prompt: string;
  size: string;
  ok: boolean;
  error?: string;
  /** Not run: the eval stopped early (low memory, budget). */
  skipped?: string;
  first?: number;
  bestOfN?: number;
  final?: number;
  candidates?: number[];
  finalErrors?: number;
  winnerErrors?: number;
  iterations?: number;
  regenerations?: number;
  regenerationsKept?: number;
  ctaBefore?: number;
  ctaAfter?: number;
  ctaBelowMinimumAfter?: boolean;
  stopReason?: string;
  costUsd?: number;
  llmUsd?: number;
  imageUsd?: number;
  directorRetried?: boolean;
  /** The director's first plan stated facts the prompt didn't give (and was retried). */
  directorRetriedForFacts?: boolean;
  /** Candidate #1 / the best-of-N winner already met the target with no errors. */
  firstAtTarget?: boolean;
  bestOfNAtTarget?: boolean;
  /** copy-grounded issues on the winner and on the final design. */
  copyGroundedWinner?: number;
  copyGroundedFinal?: number;
  copyEditsApplied?: number;
  acceptedIterations?: number;
  cutouts?: string[];
  durationMs?: number;
  out?: string;
  failingRules?: string[];
  warnings?: string[];
}

async function evalPrompt(p: (typeof PROMPTS)[number]): Promise<Row> {
  const skip = (reason: string): Row => ({
    id: p.id,
    prompt: p.prompt,
    size: p.size,
    ok: false,
    skipped: reason,
  });
  if (stopped) return skip(stopped);
  const freeMb = Math.round(freemem() / 1024 ** 2);
  if (freeMb < minFreeMb) {
    stopped = `stopped before ${p.id}: only ${freeMb} MB of memory free (minimum ${minFreeMb} MB)`;
    return skip(stopped);
  }
  const dir = join(outRoot, p.id);
  const canvas = parseSize(p.size);
  try {
    const workspace = await createWorkspace(dir, { attention: true });
    const result: GenerationResult = await generateDesign({
      prompt: p.prompt,
      canvas,
      out: join(dir, `${p.id}.json`),
      director: offline
        ? createTemplateArtDirector()
        : createAnthropicArtDirector({ model, effort, ledger, tag: p.id }),
      provider: offline
        ? createMockImageProvider()
        : createReplicateFluxProvider({
            token: process.env.REPLICATE_API_TOKEN!,
            // Replicate allows 6 predictions/minute (burst 1) on accounts with under $5 credit.
            minIntervalMs: Number(process.env.REPLICATE_MIN_INTERVAL_MS ?? 10_500),
          }),
      remover,
      editor: offline
        ? createSuggestedFixesEditor()
        : createAnthropicEditor({ model, effort, generation: true }),
      ...(offline ? {} : { editorModel: model }),
      candidates,
      target,
      maxIterations,
      maxRegenerations,
      attention: true,
      ledger,
      workspace,
    });
    await renderGenerationSteps(result, join(dir, 'steps'), workspace, p.prompt);
    const winner = result.candidates[result.winner]!;
    const final = result.final.report;
    const ctaAfter = ctaShare(final);
    const regens = result.loop.history.flatMap((h) =>
      (h.regenerations ?? []).map((r) => ({ ...r, kept: h.status === 'accepted' })),
    );
    const manifest = JSON.parse(readFileSync(result.manifestFile, 'utf8')) as {
      images: { cutout?: { remover: string } | null; kind: string }[];
    };
    return {
      id: p.id,
      prompt: p.prompt,
      size: p.size,
      ok: true,
      first: result.candidates[0]!.score,
      bestOfN: winner.score,
      final: final.score,
      candidates: result.candidates.map((c) => c.score),
      winnerErrors: winner.errors,
      finalErrors: final.summary.errors,
      iterations: result.loop.totals.iterations,
      regenerations: result.loop.totals.regenerations ?? 0,
      regenerationsKept: regens.filter((r) => r.status === 'applied' && r.kept).length,
      ...(winner.ctaShare !== undefined ? { ctaBefore: winner.ctaShare } : {}),
      ...(ctaAfter !== undefined
        ? { ctaAfter, ctaBelowMinimumAfter: ctaAfter < DEFAULT_ATTENTION_MINIMUMS.cta! }
        : {}),
      stopReason: result.loop.stopReason,
      costUsd: result.spend.totalUsd,
      llmUsd: result.spend.llmUsd,
      imageUsd: result.spend.imageUsd,
      directorRetried: Boolean(result.director.retriedAfter),
      directorRetriedForFacts: Boolean(
        result.director.retriedAfter?.startsWith("The copy states facts the prompt doesn't give"),
      ),
      firstAtTarget: result.candidates[0]!.score >= target && result.candidates[0]!.errors === 0,
      bestOfNAtTarget: winner.score >= target && winner.errors === 0,
      copyGroundedWinner: winner.report.issues.filter((i) => i.ruleId === 'copy-grounded').length,
      copyGroundedFinal: final.issues.filter((i) => i.ruleId === 'copy-grounded').length,
      copyEditsApplied: result.loop.history
        .filter((h) => h.status === 'accepted')
        .reduce((s, h) => s + (h.copyEdits ?? []).filter((c) => c.status === 'applied').length, 0),
      acceptedIterations: result.loop.history.filter((h) => h.status === 'accepted').length,
      cutouts: manifest.images
        .filter((i) => i.kind === 'subject')
        .map((i) => i.cutout?.remover ?? 'none'),
      durationMs: result.durationMs,
      out: result.out.replace(ROOT, ''),
      failingRules: [
        ...new Set(final.issues.filter((i) => i.severity !== 'info').map((i) => i.ruleId)),
      ],
      warnings: result.warnings,
    };
  } catch (err) {
    if (err instanceof BudgetExceededError) stopped = `stopped at ${p.id}: ${err.message}`;
    return { id: p.id, prompt: p.prompt, size: p.size, ok: false, error: (err as Error).message };
  }
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
        const r = out[i] as Row;
        process.stderr.write(
          pc.dim(
            `  ${r.id}: ${r.ok ? `${r.first} → ${r.bestOfN} → ${r.final} · $${r.costUsd?.toFixed(3)}` : r.skipped ? `skipped (${r.skipped})` : `failed: ${r.error}`} · run $${(ledger.spentUsd() - ledgerAtStart).toFixed(2)} · free ${Math.round(freemem() / 1024 ** 2)} MB · rss ${Math.round(process.memoryUsage.rss() / 1024 ** 2)} MB\n`,
          ),
        );
      }
    }),
  );
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f1 = (n: number | undefined) =>
  n === undefined ? '–' : Number.isInteger(n) ? String(n) : n.toFixed(1);
const pct = (n: number | undefined) => (n === undefined ? '–' : `${(n * 100).toFixed(1)}%`);
const visible = (s: string) => stripVTControlCharacters(s).length;
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - visible(s)));

console.error(
  pc.bold(
    `redline eval:generate: ${selected.length} prompts · ${candidates} candidates · target ${target} · max ${maxIterations} it · ${maxRegenerations} regen`,
  ) +
    pc.dim(
      ` · ${offline ? 'offline (template + mock + suggested)' : `${model} (${effort}) + FLUX.1 schnell`} · ledger $${ledger.spentUsd().toFixed(2)} of $${ledger.capUsd.toFixed(2)}`,
    ),
);
const started = Date.now();
const rows = await pool(selected, concurrency, evalPrompt);
const ok = rows.filter((r) => r.ok);

const summary = {
  prompts: rows.length,
  failed: rows.length - ok.length,
  meanFirst: Number(mean(ok.map((r) => r.first!)).toFixed(1)),
  meanBestOfN: Number(mean(ok.map((r) => r.bestOfN!)).toFixed(1)),
  meanFinal: Number(mean(ok.map((r) => r.final!)).toFixed(1)),
  skipped: rows.filter((r) => r.skipped).length,
  stopped: stopped ?? null,
  reachedTarget: ok.filter((r) => r.final! >= target && r.finalErrors === 0).length,
  firstAtTarget: ok.filter((r) => r.firstAtTarget).length,
  bestOfNAtTarget: ok.filter((r) => r.bestOfNAtTarget).length,
  /** Best-of-N missed the target and the loop got it there (with accepted edits). */
  loopReachedTarget: ok.filter(
    (r) => !r.bestOfNAtTarget && r.final! >= target && r.finalErrors === 0,
  ).length,
  loopImproved: ok.filter((r) => (r.acceptedIterations ?? 0) > 0).length,
  directorRetriedForFacts: ok.filter((r) => r.directorRetriedForFacts).length,
  copyGroundedWinners: ok.filter((r) => (r.copyGroundedWinner ?? 0) > 0).length,
  copyGroundedFinals: ok.filter((r) => (r.copyGroundedFinal ?? 0) > 0).length,
  copyEditsApplied: ok.reduce((s, r) => s + (r.copyEditsApplied ?? 0), 0),
  runSpentUsd: Number((ledger.spentUsd() - ledgerAtStart).toFixed(4)),
  meanIterations: Number(mean(ok.map((r) => r.iterations!)).toFixed(2)),
  totalRegenerations: ok.reduce((s, r) => s + (r.regenerations ?? 0), 0),
  regenerationsKept: ok.reduce((s, r) => s + (r.regenerationsKept ?? 0), 0),
  meanCtaBefore: Number(
    (mean(ok.flatMap((r) => (r.ctaBefore === undefined ? [] : [r.ctaBefore]))) * 100).toFixed(1),
  ),
  meanCtaAfter: Number(
    (mean(ok.flatMap((r) => (r.ctaAfter === undefined ? [] : [r.ctaAfter]))) * 100).toFixed(1),
  ),
  ctaBelowMinimumAfter: ok.filter((r) => r.ctaBelowMinimumAfter).length,
  totalCostUsd: Number(ok.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(4)),
  meanCostUsd: Number(mean(ok.map((r) => r.costUsd ?? 0)).toFixed(4)),
  ledgerTotalUsd: Number(ledger.spentUsd().toFixed(4)),
};

const headers = [
  'Prompt',
  'Size',
  'First',
  'Best-of-N',
  'Final',
  'It',
  'Regen',
  'CTA before → after',
  'Cost',
];
const body = rows.map((r) =>
  r.ok
    ? [
        r.id,
        r.size,
        f1(r.first),
        f1(r.bestOfN),
        f1(r.final),
        f1(r.iterations),
        `${r.regenerations}${r.regenerationsKept ? ` (${r.regenerationsKept} kept)` : ''}`,
        `${pct(r.ctaBefore)} → ${pct(r.ctaAfter)}`,
        `$${r.costUsd!.toFixed(3)}`,
      ]
    : [r.id, r.size, r.skipped ? pc.yellow('skipped') : pc.red('failed'), '', '', '', '', '', ''],
);
const totalRow = [
  pc.bold('mean'),
  '',
  f1(summary.meanFirst),
  f1(summary.meanBestOfN),
  f1(summary.meanFinal),
  f1(summary.meanIterations),
  String(summary.totalRegenerations),
  `${summary.meanCtaBefore}% → ${summary.meanCtaAfter}%`,
  `$${summary.totalCostUsd.toFixed(2)} total`,
];
const widths = headers.map((h, i) =>
  Math.max(visible(h), ...[...body, totalRow].map((row) => visible(row[i]!))),
);
const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join('  ');
console.log(`\n${pc.bold(line(headers))}`);
for (const row of body) console.log(line(row));
console.log(line(totalRow));
console.log(
  pc.dim(
    `\n  at target: first ${summary.firstAtTarget}/${ok.length} · best-of-N ${summary.bestOfNAtTarget}/${ok.length} · final ${summary.reachedTarget}/${ok.length} (loop got ${summary.loopReachedTarget} there; accepted edits on ${summary.loopImproved}) · CTA below 5% after: ${summary.ctaBelowMinimumAfter}` +
      `\n  invented facts: director retried ${summary.directorRetriedForFacts} · in winner ${summary.copyGroundedWinners} · in final ${summary.copyGroundedFinals} · replaced by the loop ${summary.copyEditsApplied}` +
      `\n  this run $${summary.runSpentUsd} · ledger total $${summary.ledgerTotalUsd}${summary.stopped ? ` · ${summary.stopped}` : ''}`,
  ),
);
for (const r of rows.filter((x) => !x.ok && !x.skipped))
  console.log(pc.red(`  ${r.id}: ${r.error}`));
for (const r of ok.filter((x) => x.failingRules?.length))
  console.log(pc.dim(`  ${r.id}: still failing ${r.failingRules!.join(', ')}`));

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

if (!values['no-save']) {
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `${stamp}_generate_${runLabel}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        git: { commit: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])) },
        settings: {
          offline,
          model,
          effort,
          candidates,
          target,
          maxIterations,
          maxRegenerations,
          imageModel: offline ? 'mock' : 'black-forest-labs/flux-schnell',
        },
        durationMs: Date.now() - started,
        outputs: outRoot.replace(ROOT, ''),
        summary,
        prompts: rows,
      },
      null,
      2,
    )}\n`,
  );
  console.log(pc.dim(`  saved ${file.replace(ROOT, '')}`));
}
