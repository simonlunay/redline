'use client';

import type { KeyboardEvent } from 'react';
import type { Frame } from '@/lib/run/timeline';

/**
 * The scrubber: one tick per frame, with the score each frame recorded drawn as a line above,
 * so the climb (and any rollback) is visible before you press play. Arrow keys step, Home/End
 * jump, Space plays.
 */
export function Timeline({
  frames,
  index,
  scores,
  playing,
  speed,
  onSeek,
  onTogglePlay,
  onSpeed,
}: {
  frames: Frame[];
  index: number;
  /** Score at each frame (undefined where a frame has no design, e.g. the plan). */
  scores: (number | undefined)[];
  playing: boolean;
  speed: number;
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

  const x = (i: number) => ((i + 0.5) / n) * 100;
  const y = (s: number) => 4 + (1 - s / 100) * 40;
  const points = scores
    .map((s, i) => (s === undefined ? null : `${x(i)},${y(s)}`))
    .filter(Boolean)
    .join(' ');

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
        <svg
          className="track-score"
          viewBox="0 0 100 48"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line x1="0" x2="100" y1={y(100)} y2={y(100)} className="track-ref" />
          <polyline points={points} className="track-line" />
        </svg>
        <ol className="ticks">
          {frames.map((f, i) => {
            return (
              <li key={i}>
                <button
                  type="button"
                  className={`tick ${f.kind}${f.status && f.status !== 'accepted' && f.status !== 'initial' ? ' rolled-back' : ''}${i === index ? ' current' : ''}${i < index ? ' past' : ''}`}
                  onClick={() => onSeek(i)}
                  title={f.label}
                  tabIndex={-1}
                >
                  <span className="visually-hidden">{f.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="track-now" aria-hidden="true">
          {frames[index]?.label}
        </div>
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
