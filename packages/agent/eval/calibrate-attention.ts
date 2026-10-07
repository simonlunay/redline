/**
 * Calibrates the attention-key-elements thresholds: `npm run calibrate-attention`
 *
 * Runs the real saliency model over every fixture plus the fixed designs saved by a previous
 * eval run (designs that already pass the layout rules), and reports each key role's share
 * of predicted attention. Thresholds are a low percentile of the "clean" set (no layout
 * errors), rounded down to a whole percent, so most already-good designs pass.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAttention, check, parseDesign } from '@simonlunay/redline';
import type { Design } from '@simonlunay/redline';
import { createNodeEnv, getAttentionModel } from '@simonlunay/redline/node';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = join(ROOT, 'fixtures');
const RESULTS = fileURLToPath(new URL('./results/', import.meta.url));
const ROLES = ['headline', 'cta', 'product'] as const;
type KeyRole = (typeof ROLES)[number];

interface Sample {
  source: string;
  clean: boolean;
  shares: Partial<Record<KeyRole, number>>;
}

// Designs: every fixture, plus the best designs from the newest eval results file that has them.
const designs: { source: string; design: Design }[] = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({
    source: `fixture:${f}`,
    design: parseDesign(JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'))),
  }));
const resultFiles = readdirSync(RESULTS)
  .filter((f) => /^\d.*\.json$/.test(f))
  .sort()
  .reverse();
for (const file of resultFiles) {
  const results = JSON.parse(readFileSync(join(RESULTS, file), 'utf8'));
  const fixed = (
    results.fixtures as { fixture: string; llm: Record<string, { bestDesign?: Design }[]> }[]
  ).flatMap((row) =>
    Object.entries(row.llm).flatMap(([model, runs]) =>
      runs.flatMap((run, i) =>
        run.bestDesign
          ? [{ source: `${file}:${row.fixture}:${model}#${i + 1}`, design: run.bestDesign }]
          : [],
      ),
    ),
  );
  if (fixed.length > 0) {
    designs.push(...fixed);
    console.error(`using ${fixed.length} fixed designs from ${file}`);
    break;
  }
}

const model = await getAttentionModel();
const samples: Sample[] = [];
for (const { source, design } of designs) {
  const env = await createNodeEnv({ design, baseDir: FIXTURES }, { saliency: model });
  const layout = check(design, { measurer: env.measurer, sampler: env.sampler });
  const attention = analyzeAttention(design, await model.predict(await env.render(design)));
  const shares: Sample['shares'] = {};
  for (const role of ROLES) {
    if (design.elements.some((el) => el.role === role))
      shares[role] = attention.roleShares[role] ?? 0;
  }
  samples.push({ source, clean: layout.summary.errors === 0, shares });
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (index - lo);
}

const clean = samples.filter((s) => s.clean);
const thresholds = (p: number) =>
  Object.fromEntries(
    ROLES.map((role) => {
      const values = clean.flatMap((s) => (s.shares[role] === undefined ? [] : [s.shares[role]!]));
      return [role, Math.floor(percentile(values, p) * 100) / 100];
    }),
  ) as Record<KeyRole, number>;
const flagged = (set: Sample[], t: Record<KeyRole, number>) =>
  set.filter((s) =>
    ROLES.some((role) => s.shares[role] !== undefined && s.shares[role]! < t[role]),
  );

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
console.log(`\n${samples.length} designs (${clean.length} with no layout errors)\n`);
console.log('role       n    min     p10     p20     median  max');
for (const role of ROLES) {
  const values = clean.flatMap((s) => (s.shares[role] === undefined ? [] : [s.shares[role]!]));
  const row = [0, 0.1, 0.2, 0.5, 1].map((p) => pct(percentile(values, p)).padStart(6));
  console.log(`${role.padEnd(9)} ${String(values.length).padStart(3)}  ${row.join('  ')}`);
}
const report: Record<string, unknown> = {
  createdAt: new Date().toISOString(),
  designs: samples.length,
  clean: clean.length,
};
for (const p of [0.1, 0.2]) {
  const t = thresholds(p);
  const cleanFlagged = flagged(clean, t);
  const originals = samples.filter((s) => s.source.startsWith('fixture:'));
  console.log(
    `\np${p * 100} thresholds ${JSON.stringify(t)}: flags ${cleanFlagged.length}/${clean.length} clean designs, ${flagged(originals, t).length}/${originals.length} original fixtures`,
  );
  report[`p${p * 100}`] = {
    thresholds: t,
    cleanFlagged: cleanFlagged.length,
    originalsFlagged: flagged(originals, t).length,
    flaggedCleanSources: cleanFlagged.map((s) => s.source),
  };
}
report.samples = samples;
writeFileSync(join(RESULTS, 'attention-calibration.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log('\nsaved packages/agent/eval/results/attention-calibration.json');
