/**
 * Replays the phase 5 checks on a finished generate-eval run, where we already know what looks
 * wrong: `npm run eval:replay -w packages/generate -- [options]`
 *
 * For every prompt of the run it re-checks all candidates with the image rules (image-text,
 * cutout-quality) and asks the vision judge about the winner, then scores both against the hand
 * labels in labels-phase4.json (which images are damaged cutouts or have text drawn in).
 * Nothing is regenerated; the only cost is one judge call per winner (--judge none: free).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDesign } from '@simonlunay/redline';
import type { Design, Report } from '@simonlunay/redline';
import { renderPng } from '@simonlunay/redline/node';
import { loadDotEnv } from '@simonlunay/redline-agent/node';
import pc from 'picocolors';
import { DEFAULT_JUDGE_MODEL, createAnthropicJudge } from '../src/judge/anthropic.js';
import { judgeElements, judgeKnownIssues } from '../src/judge/rule.js';
import type { JudgeVerdict } from '../src/judge/types.js';
import { createFileLedger } from '../src/node/spend-file.js';
import { createWorkspace } from '../src/node/workspace.js';
import type { Workspace } from '../src/node/workspace.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RESULTS = fileURLToPath(new URL('./results/', import.meta.url));
const labels = JSON.parse(
  readFileSync(fileURLToPath(new URL('./labels-phase4.json', import.meta.url)), 'utf8'),
) as {
  run: string;
  damagedCutouts: Record<string, string>;
  textInImage: Record<string, string>;
  otherWinnerProblems: Record<string, string>;
};

const { values } = parseArgs({
  options: {
    run: { type: 'string', default: labels.run },
    judge: { type: 'string', default: 'anthropic' },
    'judge-model': { type: 'string', default: DEFAULT_JUDGE_MODEL },
    ledger: { type: 'string', default: join(RESULTS, 'spend-ledger-phase5.json') },
    cap: { type: 'string', default: '8' },
    'no-save': { type: 'boolean' },
  },
});
loadDotEnv(join(ROOT, '.env'));
const runDir = join(ROOT, values.run!);
const ledger = createFileLedger(values.ledger!, Number(values.cap));
const judge =
  values.judge === 'anthropic'
    ? createAnthropicJudge({ model: values['judge-model'], ledger, tag: 'replay' })
    : undefined;

/** "prompt/prompt.assets/file.png" for an image src as written in a design of that prompt. */
const assetKey = (prompt: string, src: string) => `${prompt}/${src.replace(/^\.\.\//, '')}`;
const issuesOf = (report: Report, ruleId: string) =>
  report.issues.filter((i) => i.ruleId === ruleId && i.severity !== 'info');

async function checkWith(workspace: Workspace, prompt: string, design: Design) {
  for (const el of design.elements)
    if (el.type === 'image') workspace.markImage(el.src, 'generated');
  return workspace.check(design);
}

interface CandidateRow {
  prompt: string;
  index: number;
  winner: boolean;
  truth: { damagedCutout: boolean; textInImage: boolean };
  imageText: { severity: string; message: string }[];
  cutout: { severity: string; message: string }[];
}
const candidates: CandidateRow[] = [];
const winners: {
  prompt: string;
  truth: string[];
  rules: { imageText: number; cutout: number; score: number };
  judge?: JudgeVerdict & { costUsd?: number };
  error?: string;
}[] = [];

const prompts = readdirSync(runDir).filter((d) =>
  existsSync(join(runDir, d, `${d}.generation.json`)),
);
for (const prompt of prompts) {
  const dir = join(runDir, prompt);
  const record = JSON.parse(readFileSync(join(dir, `${prompt}.generation.json`), 'utf8')) as {
    winner: number;
    candidates: { file: string }[];
  };
  const candidateSpace = await createWorkspace(join(dir, `${prompt}.candidates`), {
    imageChecks: true,
  });
  const truthOf = (design: Design) => {
    const keys = design.elements.flatMap((el) =>
      el.type === 'image' ? [assetKey(prompt, el.src)] : [],
    );
    return {
      damagedCutout: keys.some((k) => k in labels.damagedCutouts),
      textInImage: keys.some((k) => k in labels.textInImage),
    };
  };
  for (const [index, c] of record.candidates.entries()) {
    const design = parseDesign(JSON.parse(readFileSync(join(dir, c.file), 'utf8')));
    const report = await checkWith(candidateSpace, prompt, design);
    candidates.push({
      prompt,
      index,
      winner: index === record.winner,
      truth: truthOf(design),
      imageText: issuesOf(report, 'image-text').map((i) => ({
        severity: i.severity,
        message: i.message,
      })),
      cutout: issuesOf(report, 'cutout-quality').map((i) => ({
        severity: i.severity,
        message: i.message,
      })),
    });
  }

  // The winner as shipped (the loop made no edits in that run, so it is the final design).
  const space = await createWorkspace(dir, { imageChecks: true });
  const final = parseDesign(JSON.parse(readFileSync(join(dir, `${prompt}.json`), 'utf8')));
  const report = await checkWith(space, prompt, final);
  const t = truthOf(final);
  const row: (typeof winners)[number] = {
    prompt,
    truth: [
      ...(t.damagedCutout ? ['damaged cutout'] : []),
      ...(t.textInImage ? ['text in image'] : []),
      ...(labels.otherWinnerProblems[prompt] ? [labels.otherWinnerProblems[prompt]!] : []),
    ],
    rules: {
      imageText: issuesOf(report, 'image-text').length,
      cutout: issuesOf(report, 'cutout-quality').length,
      score: report.score,
    },
  };
  if (judge) {
    try {
      const long = Math.max(final.canvas.width, final.canvas.height);
      const png = renderPng(final, { images: space.images, scale: Math.min(1, 1024 / long) });
      const prompts = JSON.parse(
        readFileSync(join(ROOT, 'packages/generate/eval/prompts.json'), 'utf8'),
      ) as { id: string; prompt: string }[];
      const v = await judge.judge({
        prompt: prompts.find((p) => p.id === prompt)?.prompt ?? prompt,
        canvas: final.canvas,
        png: new Uint8Array(png),
        elements: judgeElements(final),
        issues: judgeKnownIssues(report),
      });
      row.judge = {
        verdict: v.verdict,
        summary: v.summary,
        findings: v.findings,
        ...(v.costUsd !== undefined ? { costUsd: v.costUsd } : {}),
      };
    } catch (err) {
      row.error = (err as Error).message;
    }
  }
  winners.push(row);
  process.stderr.write(
    pc.dim(
      `  ${prompt}: truth [${row.truth.join('; ') || 'fine'}] · image-text ${row.rules.imageText} · cutout ${row.rules.cutout}${row.judge ? ` · judge ${row.judge.verdict} (${row.judge.findings.map((f) => `${f.severity} ${f.category}`).join(', ') || 'no findings'})` : ''}${row.error ? ` · judge failed: ${row.error}` : ''} · ledger $${ledger.spentUsd().toFixed(2)}\n`,
    ),
  );
}

const confusion = (pred: (c: CandidateRow) => boolean, truth: (c: CandidateRow) => boolean) => ({
  truePositive: candidates.filter((c) => pred(c) && truth(c)).length,
  falsePositive: candidates.filter((c) => pred(c) && !truth(c)).length,
  falseNegative: candidates.filter((c) => !pred(c) && truth(c)).length,
  trueNegative: candidates.filter((c) => !pred(c) && !truth(c)).length,
});
const errorOf = (xs: { severity: string }[]) => xs.some((x) => x.severity === 'error');
const flagged = (j?: JudgeVerdict) => Boolean(j && j.verdict !== 'ship');
const summary = {
  candidates: candidates.length,
  imageText: confusion(
    (c) => c.imageText.length > 0,
    (c) => c.truth.textInImage,
  ),
  cutoutAny: confusion(
    (c) => c.cutout.length > 0,
    (c) => c.truth.damagedCutout,
  ),
  cutoutError: confusion(
    (c) => errorOf(c.cutout),
    (c) => c.truth.damagedCutout,
  ),
  winners: {
    total: winners.length,
    withProblems: winners.filter((w) => w.truth.length > 0).length,
    caughtByImageRules: winners.filter(
      (w) => w.truth.length > 0 && w.rules.imageText + w.rules.cutout > 0,
    ).length,
    caughtByJudge: winners.filter((w) => w.truth.length > 0 && flagged(w.judge)).length,
    caughtByEither: winners.filter(
      (w) => w.truth.length > 0 && (flagged(w.judge) || w.rules.imageText + w.rules.cutout > 0),
    ).length,
    judgeFlaggedFine: winners.filter((w) => w.truth.length === 0 && flagged(w.judge)).length,
    imageRulesFlaggedFine: winners.filter(
      (w) => w.truth.length === 0 && w.rules.imageText + w.rules.cutout > 0,
    ).length,
  },
  judgeCostUsd: Number(winners.reduce((s, w) => s + (w.judge?.costUsd ?? 0), 0).toFixed(4)),
  ledgerTotalUsd: Number(ledger.spentUsd().toFixed(4)),
};
console.log(JSON.stringify(summary, null, 2));
if (!values['no-save']) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(RESULTS, `${stamp}_replay-phase4.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), run: values.run, judge: judge ? judge.name : null, summary, winners, candidates }, null, 2)}\n`,
  );
  console.log(pc.dim(`  saved ${file.replace(ROOT, '')}`));
}
