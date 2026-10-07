import { formatIteration, formatUsage } from '@simonlunay/redline-agent/node';
import pc from 'picocolors';
import type { DirectorResult } from '../director/types.js';
import type { DesignPlan } from '../plan.js';
import type { ManifestEntry } from './assets.js';
import type { CandidateResult, GenerationResult } from './pipeline.js';

function color(score: number) {
  return score >= 85 ? pc.green : score >= 60 ? pc.yellow : pc.red;
}

function bar(score: number): string {
  const filled = Math.round(score / 10);
  return color(score)('█'.repeat(filled)) + pc.dim('░'.repeat(10 - filled));
}

const pct = (share: number | undefined) =>
  share === undefined ? '–' : `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatGenerateHeader(prompt: string, settings: string): string {
  return `\n${pc.bold(pc.inverse(' redline generate '))} ${pc.bold(`"${prompt}"`)}\n  ${pc.dim(settings)}\n`;
}

export function formatPlan(
  plan: DesignPlan,
  director: DirectorResult,
  directorName: string,
): string {
  const lines = [
    `  ${pc.bold('Plan')} ${pc.dim(`(${directorName}${director.calls > 1 ? `, retried once` : ''})`)}`,
    `    ${plan.concept}`,
    `    ${pc.dim('copy')}  ${pc.bold(plan.copy.headline)}${plan.copy.subheading ? ` · ${plan.copy.subheading}` : ''}${plan.copy.cta ? ` · [${plan.copy.cta}]` : ''}`,
    `    ${pc.dim('colors')} ${Object.values(plan.palette).join(' ')}`,
  ];
  plan.layouts.forEach((layout, i) => {
    lines.push(`    ${pc.dim(`layout ${i + 1}`)} ${layout.name}`);
    for (const slot of layout.imageSlots.filter((s) => s.kind !== 'user')) {
      lines.push(
        pc.dim(
          `      ${slot.kind}: ${slot.brief.slice(0, 90)}${slot.brief.length > 90 ? '…' : ''}`,
        ),
      );
    }
  });
  return lines.join('\n');
}

export function formatImage(entry: ManifestEntry): string {
  const cut = entry.cutout
    ? ` · cutout ${entry.cutout.remover}`
    : entry.kind === 'subject'
      ? ' · no cutout'
      : '';
  const cost = entry.costUsd > 0 ? ` · $${entry.costUsd.toFixed(3)}` : '';
  return pc.dim(
    `    ▸ ${entry.key} ${entry.width}x${entry.height} · ${entry.provider}${entry.seed !== null ? ` seed ${entry.seed}` : ''}${cut}${cost}`,
  );
}

export function formatCandidate(c: CandidateResult): string {
  return `  ${pc.bold(`#${c.index + 1}`)}  ${String(c.score).padStart(3)}  ${bar(c.score)}  ${pc.dim(`${plural(c.errors, 'error')} · ${plural(c.warnings, 'warning')} · CTA ${pct(c.ctaShare)} · layout ${c.layout + 1}, background ${c.variant + 1}`)}`;
}

export function formatWinner(c: CandidateResult, total: number): string {
  return `\n  ${pc.green('★')} ${pc.bold(`Winner: candidate ${c.index + 1}`)} of ${total} (${c.score}) ${pc.dim(`· ${c.layoutName}`)}\n\n  ${pc.bold('Fix loop')}`;
}

export function formatIterationLine(record: Parameters<typeof formatIteration>[0]): string {
  return formatIteration(record);
}

export function formatGenerateSummary(result: GenerationResult, editorModel?: string): string {
  const first = result.candidates[0]!;
  const winner = result.candidates[result.winner]!;
  const final = result.final.report;
  const ok = final.passed;
  const lines = [
    '',
    `  ${ok ? pc.green('✔') : pc.yellow('▲')} ${pc.bold(`first candidate ${first.score} → best of ${result.candidates.length} ${winner.score} → final ${color(final.score)(String(final.score))}`)} ${pc.dim(`· ${plural(result.loop.totals.iterations, 'iteration')} · stop: ${result.loop.stopReason}`)}`,
    pc.dim(
      `    CTA attention ${pct(winner.ctaShare)} → ${pct(
        (
          final.rules.find((r) => r.ruleId === 'attention-key-elements')?.details?.roleShares as
            Record<string, number> | undefined
        )?.cta,
      )} · errors ${winner.errors} → ${final.summary.errors}`,
    ),
  ];
  if (editorModel && result.loop.totals.calls > 0) {
    lines.push(
      pc.dim(
        `    fix loop: ${plural(result.loop.totals.calls, 'LLM call')} · ${formatUsage(result.loop.totals.usage, editorModel)}`,
      ),
    );
  }
  lines.push(
    pc.dim(
      `    spend this run ≈ $${result.spend.totalUsd.toFixed(3)} (LLM $${result.spend.llmUsd.toFixed(3)} · images $${result.spend.imageUsd.toFixed(3)})${Number.isFinite(result.spend.capUsd) ? ` · cap $${result.spend.capUsd.toFixed(2)}` : ''} · ${(result.durationMs / 1000).toFixed(1)}s`,
    ),
  );
  const remaining = [
    ...new Set(final.issues.filter((i) => i.severity !== 'info').map((i) => i.ruleId)),
  ];
  if (remaining.length > 0) lines.push(pc.dim(`    still failing: ${remaining.join(', ')}`));
  lines.push(pc.dim(`    wrote ${result.out}`));
  lines.push(pc.dim(`          ${result.generationFile} (plan, all candidates, loop history)`));
  lines.push(pc.dim(`          ${result.manifestFile}`));
  for (const w of result.warnings) lines.push(pc.yellow(`    ! ${w}`));
  lines.push('');
  return lines.join('\n');
}
