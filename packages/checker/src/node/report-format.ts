import pc from 'picocolors';
import type { Design } from '../core/schema.js';
import type { Fix, Issue, Report, Severity } from '../core/types.js';

export interface FormatOptions {
  /** Shown in the header, usually the design file path. */
  title?: string;
  design?: Design;
  /** Extra non-fatal notes, e.g. images that failed to load. */
  warnings?: string[];
}

const SEVERITY_STYLE: Record<
  Severity,
  { icon: string; title: string; color: (s: string) => string }
> = {
  error: { icon: '✖', title: 'Errors', color: pc.red },
  warning: { icon: '▲', title: 'Warnings', color: pc.yellow },
  info: { icon: 'ℹ', title: 'Info', color: pc.blue },
};

function scoreColor(score: number): (s: string) => string {
  if (score >= 85) return pc.green;
  if (score >= 60) return pc.yellow;
  return pc.red;
}

function bar(score: number, width = 10): string {
  const filled = Math.round((score / 100) * width);
  return scoreColor(score)('█'.repeat(filled)) + pc.dim('░'.repeat(width - filled));
}

export function formatFix(fix: Fix): string {
  const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  switch (fix.op) {
    case 'move':
      return `move ${fix.elementId} by (${sign(fix.dx)}, ${sign(fix.dy)})`;
    case 'resize':
      return `resize ${fix.elementId} to ${fix.width}x${fix.height}`;
    case 'setColor':
      return `set ${fix.elementId} color to ${fix.color}`;
    case 'setFontSize':
      return `set ${fix.elementId} font size to ${fix.fontSize}px`;
    case 'setFontWeight':
      return `set ${fix.elementId} font weight to ${fix.fontWeight}`;
    case 'setOpacity':
      return `set ${fix.elementId} opacity to ${fix.opacity}`;
    case 'insertShape':
      return `insert ${fix.kind} ${fix.fill} (opacity ${fix.opacity}) behind ${fix.behindElementId} at ${fix.x},${fix.y} ${fix.width}x${fix.height}`;
  }
}

function formatValue(value: number | string, unit?: string): string {
  if (unit === ':1') return `${value}:1`;
  return unit ? `${value} ${unit}` : String(value);
}

function formatIssue(issue: Issue, number: number): string[] {
  const style = SEVERITY_STYLE[issue.severity];
  const lines = [
    `  ${style.color(style.icon)} ${pc.dim(`${number}.`)} ${issue.message} ${pc.dim(`[${issue.ruleId}]`)}`,
    pc.dim(
      `       measured ${formatValue(issue.measured, issue.unit)} · threshold ${formatValue(issue.threshold, issue.unit)}`,
    ),
  ];
  for (const fix of issue.fix ?? []) {
    lines.push(`       ${pc.cyan('fix:')} ${formatFix(fix)}`);
  }
  return lines;
}

/** Human-friendly terminal report (colors are disabled automatically when not a TTY). */
export function formatPretty(report: Report, options: FormatOptions = {}): string {
  const out: string[] = [];
  const size = options.design
    ? pc.dim(` ${options.design.canvas.width}x${options.design.canvas.height}`)
    : '';
  out.push('');
  out.push(`${pc.bold(pc.inverse(' redline '))} ${options.title ?? ''}${size}`);
  out.push('');

  const { errors, warnings, infos } = report.summary;
  const counts = [
    SEVERITY_STYLE.error.color(`${errors} error${errors === 1 ? '' : 's'}`),
    SEVERITY_STYLE.warning.color(`${warnings} warning${warnings === 1 ? '' : 's'}`),
    SEVERITY_STYLE.info.color(`${infos} info`),
  ].join(pc.dim(' · '));
  out.push(`  Score ${pc.bold(scoreColor(report.score)(`${report.score}/100`))}   ${counts}`);
  out.push('');

  const nameWidth = Math.max(...report.rules.map((r) => r.ruleId.length), 4);
  for (const rule of report.rules) {
    const issues =
      rule.issues === 0 ? pc.dim('ok') : `${rule.issues} issue${rule.issues === 1 ? '' : 's'}`;
    out.push(
      `  ${rule.ruleId.padEnd(nameWidth)}  ${bar(rule.score)} ${String(rule.score).padStart(3)}  ${issues}`,
    );
  }

  // Numbers follow report.issues order, so they match the labels in --annotate images.
  let number = 0;
  for (const severity of ['error', 'warning', 'info'] as const) {
    const group = report.issues.filter((i) => i.severity === severity);
    if (group.length === 0) continue;
    const style = SEVERITY_STYLE[severity];
    out.push('');
    out.push(style.color(pc.bold(`  ${style.title} (${group.length})`)));
    for (const issue of group) out.push(...formatIssue(issue, ++number));
  }

  for (const w of options.warnings ?? []) {
    out.push('');
    out.push(pc.yellow(`  note: ${w}`));
  }

  out.push('');
  out.push(
    report.passed
      ? pc.green(pc.bold('  ✔ No errors.'))
      : pc.red(pc.bold(`  ✖ ${errors} error${errors === 1 ? '' : 's'} found.`)),
  );
  out.push('');
  return out.join('\n');
}
