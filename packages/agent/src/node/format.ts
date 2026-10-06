import { formatFix } from '@simonlunay/redline/node';
import pc from 'picocolors';
import { estimateCostUsd } from '../pricing.js';
import type { IterationRecord, LoopResult, StopReason, TokenUsage } from '../types.js';

const STATUS_LABEL: Record<IterationRecord['status'], string> = {
  initial: 'start',
  accepted: 'accepted',
  'rolled-back': 'rolled back',
  invalid: 'invalid',
  'no-edits': 'no edits',
};

const STOP_LABEL: Record<StopReason, string> = {
  'target-reached': 'target reached',
  'no-issues': 'no issues left',
  'max-iterations': 'max iterations reached',
  'no-improvement': 'no improvement for 2 iterations',
  'editor-error': 'editor error',
};

function color(score: number) {
  return score >= 85 ? pc.green : score >= 60 ? pc.yellow : pc.red;
}

function bar(score: number): string {
  const filled = Math.round(score / 10);
  return color(score)('█'.repeat(filled)) + pc.dim('░'.repeat(10 - filled));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatHeader(file: string, settings: string): string {
  return `\n${pc.bold(pc.inverse(' redline fix '))} ${file}  ${pc.dim(settings)}\n`;
}

/** One block per iteration: status, score, delta, and the edits with their reasons. */
export function formatIteration(r: IterationRecord, maxEdits = 8): string {
  const { errors, warnings } = r.report.summary;
  const label = STATUS_LABEL[r.status].padEnd(12);
  const statusText =
    r.status === 'accepted' || r.status === 'initial'
      ? label
      : r.status === 'rolled-back'
        ? pc.red(label)
        : pc.yellow(label);
  const delta = r.scoreAfter - r.scoreBefore;
  const deltaText =
    r.status === 'initial'
      ? ''
      : delta > 0
        ? pc.green(`+${delta}`)
        : delta < 0
          ? pc.red(`${delta}`)
          : pc.dim('±0');
  const head = `  #${r.iteration}  ${statusText} ${String(r.scoreAfter).padStart(3)}  ${bar(r.scoreAfter)}  ${deltaText.padEnd(4)} ${pc.dim(`${plural(errors, 'error')} · ${plural(warnings, 'warning')}`)}`;

  const lines = [head];
  if (r.summary) lines.push(pc.dim(`        ${r.summary}`));
  for (const edit of r.edits.slice(0, maxEdits)) {
    lines.push(`        • ${formatFix(edit)} ${pc.dim(`— ${edit.reason}`)}`);
  }
  if (r.edits.length > maxEdits) lines.push(pc.dim(`        … ${r.edits.length - maxEdits} more`));
  if (r.rejected.length > 0) lines.push(pc.yellow(`        ${r.rejected.length} edit(s) rejected`));
  if (r.note && r.status !== 'accepted') lines.push(pc.dim(`        ${r.note}`));
  return lines.join('\n');
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function formatUsage(usage: TokenUsage, model?: string): string {
  const cost = estimateCostUsd(model, usage);
  return [
    `${formatTokens(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)} in (${formatTokens(usage.cacheReadTokens)} cached) / ${formatTokens(usage.outputTokens)} out tokens`,
    cost === null ? null : `≈ $${cost.toFixed(3)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function formatSummary(result: LoopResult, model?: string, out?: string): string {
  const before = result.initial.report;
  const after = result.best.report;
  const ok = after.passed;
  const mark = ok ? pc.green('✔') : pc.yellow('▲');
  const lines = [
    '',
    `  ${mark} ${pc.bold(`${before.score} → ${color(after.score)(String(after.score))}`)} in ${plural(result.totals.iterations, 'iteration')} · errors ${before.summary.errors} → ${after.summary.errors} · stop: ${STOP_LABEL[result.stopReason]}`,
  ];
  if (result.error) lines.push(pc.red(`    ${result.error}`));
  if (model && result.totals.calls > 0) {
    lines.push(
      pc.dim(
        `    ${plural(result.totals.calls, 'LLM call')} · ${formatUsage(result.totals.usage, model)} · ${(result.totals.durationMs / 1000).toFixed(1)}s`,
      ),
    );
  }
  const remaining = [
    ...new Set(after.issues.filter((i) => i.severity !== 'info').map((i) => i.ruleId)),
  ];
  if (remaining.length > 0) lines.push(pc.dim(`    still failing: ${remaining.join(', ')}`));
  if (out)
    lines.push(pc.dim(`    wrote ${out} (best version: iteration ${result.best.iteration})`));
  lines.push('');
  return lines.join('\n');
}
