/**
 * One-time recording of full fix-loop histories for the web gallery (phase 6).
 *
 *   npx tsx --conditions=@simonlunay/source apps/web/scripts/record-fix-runs.ts [--dry-run]
 *
 * The strict eval (packages/agent/eval) keeps only each run's best design, so its runs can't be
 * replayed step by step. This re-runs a few fixtures with the strict settings (target 100,
 * attention on, max 5 iterations, vision on, Sonnet 5.5 at medium effort) and keeps everything
 * the loop records: every step's design, report, edits with values and reasons, and timing.
 * The rules-only loop (no LLM, free) is recorded alongside for the side-by-side comparison.
 *
 * Every Claude call is guarded by and recorded in a file ledger capped at $0.50, so the cap
 * holds even if the script is run twice. --dry-run uses the rules-only editor for both, free.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  createAnthropicEditor,
  createSuggestedFixesEditor,
  runFixLoop,
} from '@simonlunay/redline-agent';
import type { Effort, LoopResult } from '@simonlunay/redline-agent';
import { createFixSession, loadDotEnv } from '@simonlunay/redline-agent/node';
import { budgetedEditor } from '@simonlunay/redline-generate';
import { createFileLedger } from '@simonlunay/redline-generate/node';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = fileURLToPath(new URL('../gallery-src/fix-runs/', import.meta.url));
const LEDGER = fileURLToPath(new URL('../gallery-src/spend-ledger-phase6.json', import.meta.url));
const CAP_USD = 0.5;

/** Chosen for range: worst case, messy ads, an attention problem, and one the eval never solved. */
const FIXTURES = [
  'worst',
  'ad-sneaker-sale',
  'story-concert',
  'hard-story-hero',
  'hard-busy-photo-tiny-cta',
  'banner-saas',
];

const SETTINGS = {
  target: 100,
  maxIterations: 5,
  attention: true,
  vision: true,
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT as Effort,
};

const { values } = parseArgs({
  options: { 'dry-run': { type: 'boolean' }, fixtures: { type: 'string' } },
});
const dryRun = Boolean(values['dry-run']);
const fixtures = values.fixtures ? values.fixtures.split(',') : FIXTURES;

loadDotEnv(join(ROOT, '.env'));
if (!dryRun && !process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

const ledger = createFileLedger(LEDGER, CAP_USD);
const client = dryRun ? undefined : new Anthropic({ maxRetries: 6 });
mkdirSync(OUT, { recursive: true });

function serialize(result: LoopResult, editor: string) {
  return {
    editor,
    stopReason: result.stopReason,
    ...(result.error ? { error: result.error } : {}),
    totals: result.totals,
    initial: result.initial,
    best: result.best,
    history: result.history,
  };
}

for (const name of fixtures) {
  const session = await createFixSession(join(ROOT, 'fixtures', `${name}.json`), {
    attention: SETTINGS.attention,
  });
  const design = session.loaded.design;
  const loop = {
    check: session.check,
    target: SETTINGS.target,
    maxIterations: SETTINGS.maxIterations,
  };

  const rules = await runFixLoop(design, { ...loop, editor: createSuggestedFixesEditor() });
  const aiEditor = dryRun
    ? createSuggestedFixesEditor()
    : budgetedEditor(
        createAnthropicEditor({ model: SETTINGS.model, effort: SETTINGS.effort, client }),
        ledger,
        SETTINGS.model,
        `phase6-fix-runs:${name}`,
      );
  const ai = await runFixLoop(design, {
    ...loop,
    editor: aiEditor,
    renderImages: SETTINGS.vision ? session.renderImages : undefined,
  });

  const record = {
    schemaVersion: 1,
    kind: 'fix',
    fixture: name,
    createdAt: new Date().toISOString(),
    settings: { ...SETTINGS, dryRun },
    modelsSeen: [...new Set(ai.history.flatMap((h) => (h.model ? [h.model] : [])))],
    rules: serialize(rules, 'suggested'),
    ai: serialize(ai, dryRun ? 'suggested' : `anthropic:${SETTINGS.model}`),
  };
  const file = join(OUT, `${name}${dryRun ? '.dry-run' : ''}.json`);
  writeFileSync(file, `${JSON.stringify(record)}\n`);
  console.log(
    `${name}: ${ai.initial.report.score} → rules ${rules.best.report.score}, ` +
      `AI ${ai.best.report.score} (${ai.totals.iterations} it, ${ai.stopReason}) · ` +
      `ledger $${ledger.spentUsd().toFixed(4)} of $${CAP_USD}`,
  );
}
