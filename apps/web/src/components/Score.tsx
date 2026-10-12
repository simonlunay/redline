import type { Report } from '@simonlunay/redline';

export function Score({
  report,
  before,
  caption,
}: {
  report: Report;
  /** Score this one is compared with (shows the change). */
  before?: number;
  caption?: string;
}) {
  const { errors, warnings } = report.summary;
  const delta = before === undefined ? 0 : report.score - before;
  return (
    <div className={`score${report.passed ? '' : ' failing'}`} aria-live="polite">
      <div className="score-number">
        {report.score}
        <small>/100</small>
      </div>
      <div className="score-meta">
        {caption ? <div className="label">{caption}</div> : null}
        <div>
          <strong>{errors}</strong> {errors === 1 ? 'error' : 'errors'}, <strong>{warnings}</strong>{' '}
          {warnings === 1 ? 'warning' : 'warnings'}
        </div>
        {delta !== 0 ? (
          <div className={delta > 0 ? 'delta-up' : 'delta-down'}>
            {delta > 0 ? '+' : '−'}
            {Math.abs(delta)} from {before}
          </div>
        ) : null}
      </div>
    </div>
  );
}
