'use client';

import { useEffect, useState } from 'react';
import type { RunRecord } from '@/lib/gallery/types';
import { runFile } from '@/lib/run/source';
import type { Frame } from '@/lib/run/timeline';

/** Types `text` out over `ms` (all at once when the viewer prefers reduced motion). */
function useTyped(text: string, active: boolean, ms: number): string {
  const [n, setN] = useState(text.length);
  useEffect(() => {
    if (!active) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setN(text.length);
      return;
    }
    setN(0);
    const step = Math.max(12, ms / text.length);
    const id = setInterval(() => setN((v) => (v >= text.length ? v : v + 1)), step);
    return () => clearInterval(id);
  }, [text, active, ms]);
  return active ? text.slice(0, n) : text;
}

const SEVERITY: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };

/**
 * One line per pipeline stage under the landing page's demo: the typed prompt, the plan, the
 * candidates fanning out with their scores, the winner, the judge's finding, the fix, the ship.
 * Every word and number comes from the recorded run.
 */
export function PipelineCaption({ record, frame }: { record: RunRecord; frame: Frame }) {
  const prompt = useTyped(record.prompt ?? '', frame.kind === 'prompt', 1800);
  const candidates = record.candidates ?? [];

  if (frame.kind === 'prompt') {
    return (
      <div className="caption" aria-live="polite">
        <div className="caption-stage">Prompt</div>
        <div className="prompt-line">
          {prompt}
          <span className="caret" aria-hidden="true" />
        </div>
      </div>
    );
  }
  if (frame.kind === 'plan' && record.plan) {
    return (
      <div className="caption">
        <div className="caption-stage">Art director</div>
        <div className="caption-text">{record.plan.concept}</div>
        <div className="swatches small" aria-label="Palette">
          {Object.entries(record.plan.palette).map(([name, hex]) => (
            <span
              key={name}
              className="swatch"
              style={{ background: hex }}
              title={`${name} ${hex}`}
            />
          ))}
        </div>
      </div>
    );
  }
  if (frame.kind === 'candidate' || frame.kind === 'winner') {
    return (
      <div className="caption">
        <div className="caption-stage">
          {frame.kind === 'winner'
            ? `Best of ${candidates.length}: candidate ${(record.winner ?? 0) + 1}`
            : `${candidates.length} candidates, scored by the rules and the attention model`}
        </div>
        <ol className="fan">
          {candidates.slice(0, frame.revealed).map((c, i) => {
            const thumb = record.snapshots[c.snapshot]?.thumbnail;
            const won = frame.kind === 'winner' && c.index === record.winner;
            return (
              <li
                key={c.index}
                className={`${frame.candidate === i ? 'current' : ''}${won ? ' won' : ''}`}
                style={{ ['--i' as string]: i }}
              >
                {thumb ? (
                  <img
                    src={runFile(record.id, thumb)}
                    alt={`Candidate ${c.index + 1}`}
                    width={record.canvas.width}
                    height={record.canvas.height}
                  />
                ) : null}
                <span>{c.recordedScore}</span>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }
  if (frame.kind === 'judge') {
    const j = record.judgments![frame.judgment!]!;
    const finding = j.findings[0];
    return (
      <div className="caption">
        <div className="caption-stage">
          Vision judge:{' '}
          <span className={`verdict ${j.verdict}`}>
            {j.verdict === 'ship' ? 'Ship it' : j.verdict === 'fix' ? 'Needs fixes' : 'Reject'}
          </span>
        </div>
        <div className="caption-text">
          {finding && j.verdict !== 'ship'
            ? `${SEVERITY[finding.severity] ?? finding.severity}: ${finding.description}`
            : j.summary}
        </div>
      </div>
    );
  }
  if (frame.kind === 'step') {
    const step = record.loop.steps[frame.step!]!;
    return (
      <div className="caption">
        <div className="caption-stage">
          Fix loop: {step.recordedScoreBefore} → {step.recordedScoreAfter}
        </div>
        <div className="caption-text">{step.summary ?? frame.label}</div>
      </div>
    );
  }
  return (
    <div className="caption">
      <div className="caption-stage">Final design</div>
      <div className="caption-text">
        {record.outcome === 'shipped' ? 'The judge would ship it.' : record.outcomeNote}
      </div>
    </div>
  );
}
