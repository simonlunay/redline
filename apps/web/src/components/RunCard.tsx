import Link from 'next/link';
import { asset } from '@/lib/base-path';
import type { GalleryEntry } from '@/lib/gallery/types';

const OUTCOME: Record<GalleryEntry['outcome'], { word: string; good: boolean }> = {
  shipped: { word: 'Judge: ship', good: true },
  solved: { word: 'All rules pass', good: true },
  'judge-fix': { word: 'Judge: needs fixes', good: false },
  'judge-reject': { word: 'Judge: reject', good: false },
  unsolved: { word: 'Not solved', good: false },
};

export function RunCard({ run }: { run: GalleryEntry }) {
  const outcome = OUTCOME[run.outcome];
  return (
    <li className="run-card">
      <Link href={`/runs/${run.id}/`}>
        <span className="run-proof">
          <img
            src={asset(`gallery/${run.thumbnail}`)}
            alt=""
            width={run.canvas.width}
            height={run.canvas.height}
            loading="lazy"
            style={{
              aspectRatio: `${run.canvas.width} / ${run.canvas.height}`,
              width: `${Math.min(1, run.canvas.width / run.canvas.height) * 100}%`,
            }}
          />
        </span>
        <span className="run-title">{run.title}</span>
      </Link>
      <span className="run-sub">
        {run.kind === 'generate'
          ? `“${run.prompt}”`
          : `Fix loop on a test design, ${run.canvas.width}×${run.canvas.height}`}
      </span>
      <span className={`run-outcome ${outcome.good ? 'good' : 'bad'}`}>
        {outcome.word}
        <span className="run-scores">
          {run.kind === 'fix'
            ? `${run.scores.first} to ${run.scores.final}`
            : `final ${run.scores.final}`}
        </span>
      </span>
      {run.outcomeNote ? <span className="run-note">{run.outcomeNote}</span> : null}
    </li>
  );
}
