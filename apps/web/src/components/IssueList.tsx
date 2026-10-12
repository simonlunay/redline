import type { Fix, Issue } from '@simonlunay/redline';

function round(v: number | string): string {
  return typeof v === 'number' ? String(Math.round(v * 100) / 100) : v;
}

/** The checker's suggested fix in words, like the CLI's "fix:" line. */
export function describeFix(fix: Fix): string {
  switch (fix.op) {
    case 'move':
      return `move ${fix.elementId} by (${round(fix.dx)}, ${round(fix.dy)})`;
    case 'resize':
      return `resize ${fix.elementId} to ${round(fix.width)}×${round(fix.height)}`;
    case 'setColor':
      return `set ${fix.elementId} color to ${fix.color}`;
    case 'setFontSize':
      return `set ${fix.elementId} font size to ${round(fix.fontSize)}`;
    case 'setFontWeight':
      return `set ${fix.elementId} weight to ${fix.fontWeight}`;
    case 'setOpacity':
      return `set ${fix.elementId} opacity to ${round(fix.opacity)}`;
    case 'insertShape':
      return `add a ${fix.kind} behind ${fix.behindElementId}`;
  }
}

export function IssueList({
  issues,
  selected,
  onSelect,
  empty = 'No issues. Every rule passes.',
}: {
  issues: Issue[];
  selected?: number | null;
  onSelect?: (index: number | null) => void;
  empty?: string;
}) {
  if (issues.length === 0) return <p className="note">{empty}</p>;
  return (
    <ol className="issues" aria-label="Issues">
      {issues.map((issue, i) => (
        <li
          key={`${i}-${issue.ruleId}`}
          className={`issue ${issue.severity}`}
          data-selected={selected === i}
          onPointerEnter={() => onSelect?.(i)}
          onPointerLeave={() => onSelect?.(null)}
          onFocus={() => onSelect?.(i)}
          onBlur={() => onSelect?.(null)}
          tabIndex={0}
        >
          <span className="issue-n" aria-label={`${issue.severity} ${i + 1}`}>
            {i + 1}
          </span>
          <span>
            {issue.message} <span className="issue-rule">{issue.ruleId}</span>
          </span>
          {issue.measured !== '' && issue.threshold !== '' ? (
            <span className="issue-measure">
              measured {round(issue.measured)}
              {issue.unit ?? ''}, limit {round(issue.threshold)}
              {issue.unit ?? ''}
            </span>
          ) : null}
          {issue.fix?.length ? (
            <span className="issue-fix">
              Suggested fix: {issue.fix.map(describeFix).join(', then ')}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
