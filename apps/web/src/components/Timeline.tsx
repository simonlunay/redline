'use client';

import type { KeyboardEvent } from 'react';
import type { Frame } from '@/lib/run/timeline';

function isRolledBack(f: Frame): boolean {
  return Boolean(f.status && f.status !== 'accepted' && f.status !== 'initial');
}

const isFixStep = (f: Frame) => f.kind === 'step' && f.status !== 'initial' && !isRolledBack(f);

/** A frame's name in the score tooltip. */
function frameName(f: Frame): string {
  switch (f.kind) {
    case 'candidate':
      return `candidate ${(f.candidate ?? 0) + 1}`;
    case 'winner':
      return 'the winner';
    case 'judge':
      return 'judge review';
    case 'step':
      return f.status === 'initial'
        ? 'before'
        : isRolledBack(f)
          ? 'rolled-back attempt'
          : 'after the fix';
    case 'final':
      return 'final design';
    default:
      return f.label.toLowerCase();
  }
}

/** What each block's color means. Only the kinds a run has are listed. */
const LEGEND: { key: string; label: (frames: Frame[]) => string; has: (f: Frame) => boolean }[] = [
  {
    key: 'setup',
    label: (frames) =>
      frames.some((f) => f.kind === 'prompt')
        ? 'Prompt, plan, candidates, final'
        : 'Before and best',
    has: (f) => !isFixStep(f) && !isRolledBack(f) && f.kind !== 'judge',
  },
  { key: 'step', label: () => 'Fix step', has: isFixStep },
  { key: 'rolled-back', label: () => 'Rolled back', has: isRolledBack },
  { key: 'judge', label: () => 'Judge review', has: (f) => f.kind === 'judge' },
];

/**
 * The scrubber: one block per frame, and above it the run's score over time against its target,
 * so the climb (and any rollback) is visible before you press play. Arrow keys step, Home/End
 * jump, Space plays.
 */
export function Timeline({
  frames,
  index,
  scores,
  target,
  playing,
  speed,
  legend = false,
  onSeek,
  onTogglePlay,
  onSpeed,
}: {
  frames: Frame[];
  index: number;
  /** Score at each frame (undefined where a frame has no design, e.g. the plan). */
  scores: (number | undefined)[];
  /** The score the run was aiming for (the dotted line). */
  target: number;
  playing: boolean;
  speed: number;
  /** Show the color legend under the blocks. */
  legend?: boolean;
  onSeek: (index: number) => void;
  onTogglePlay: () => void;
  onSpeed: (speed: number) => void;
}) {
  const n = frames.length;
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const keys: Record<string, number> = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
      Home: 0,
      End: n - 1,
    };
    if (e.key in keys) {
      e.preventDefault();
      onSeek(Math.max(0, Math.min(n - 1, keys[e.key]!)));
    } else if (e.key === ' ') {
      e.preventDefault();
      onTogglePlay();
    }
  }

  const known = scores.flatMap((s, i) => (s === undefined ? [] : [{ s, i }]));
  // Zoom the scale to the run's range (and its target), so a 93 → 100 climb is visible.
  const low = Math.max(0, Math.floor((Math.min(target, ...known.map((k) => k.s)) - 5) / 10) * 10);
  const x = (i: number) => ((i + 0.5) / n) * 100;
  // % of the chart's height; the top third is left for the start and end labels.
  const y = (s: number) => 34 + (1 - (s - low) / (100 - low)) * 58;
  const points = known.map((k) => `${x(k.i)},${y(k.s)}`).join(' ');
  const start = known[0];
  const end = known.at(-1);

  return (
    <div className="timeline">
      <button
        type="button"
        className="icon-button play"
        onClick={onTogglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="2" y="1" width="3.5" height="12" rx="1" fill="currentColor" />
            <rect x="8.5" y="1" width="3.5" height="12" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 1.5v11l9.5-5.5z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div
        className="track"
        role="slider"
        tabIndex={0}
        aria-label="Run timeline"
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={index + 1}
        aria-valuetext={frames[index]?.label}
        onKeyDown={onKeyDown}
      >
        {start && end ? (
          <div className="score-head">
            <span>
              Score <strong>{start.s}</strong> → <strong>{end.s}</strong>
            </span>
            <span className="target-key">
              <span className="target-swatch" aria-hidden="true" />
              target {target}
            </span>
          </div>
        ) : null}
        <div className="score-chart">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" x2="100" y1={y(target)} y2={y(target)} className="track-ref" />
            <polyline points={points} className="track-line" />
          </svg>
          {start ? (
            <span
              className="score-end start"
              style={{ left: `${x(start.i)}%`, top: `${y(start.s)}%` }}
              aria-hidden="true"
            >
              {start.s}
            </span>
          ) : null}
          {end && end.i !== start?.i ? (
            <span
              className="score-end end"
              style={{ left: `${x(end.i)}%`, top: `${y(end.s)}%` }}
              aria-hidden="true"
            >
              {end.s}
            </span>
          ) : null}
          {known.map((k) => (
            <span
              key={k.i}
              className={`score-dot${k.i === index ? ' current' : ''}`}
              style={{ left: `${x(k.i)}%`, top: `${y(k.s)}%` }}
            >
              <span className="score-tip" role="tooltip">
                <strong>{k.s}</strong> rules score, {frameName(frames[k.i]!)}
              </span>
            </span>
          ))}
        </div>
        <ol className="ticks">
          {frames.map((f, i) => (
            <li key={i}>
              <button
                type="button"
                className={`tick ${f.kind}${f.status === 'initial' ? ' initial' : ''}${isRolledBack(f) ? ' rolled-back' : ''}${i === index ? ' current' : ''}${i < index ? ' past' : ''}`}
                onClick={() => onSeek(i)}
                title={scores[i] === undefined ? f.label : `${f.label} (score ${scores[i]})`}
                tabIndex={-1}
              >
                <span className="visually-hidden">{f.label}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="track-now" aria-hidden="true">
          {frames[index]?.label}
        </div>
        {legend ? (
          <ul className="tick-legend" aria-label="Timeline colors">
            {LEGEND.filter((l) => frames.some(l.has)).map((l) => (
              <li key={l.key}>
                <span className={`legend-swatch ${l.key}`} aria-hidden="true" />
                {l.label(frames)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="speeds" role="group" aria-label="Playback speed">
        {[1, 2, 4].map((s) => (
          <button
            key={s}
            type="button"
            className={`speed${s === speed ? ' current' : ''}`}
            aria-pressed={s === speed}
            onClick={() => onSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
