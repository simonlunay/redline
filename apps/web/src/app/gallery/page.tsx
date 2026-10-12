import type { Metadata } from 'next';
import { RunCard } from '@/components/RunCard';
import { readGalleryIndex } from '@/lib/gallery/read';

export const metadata: Metadata = { title: 'Recorded runs' };

export default function GalleryPage() {
  const index = readGalleryIndex();
  const generate = index.runs.filter((r) => r.kind === 'generate').length;
  const fix = index.runs.length - generate;
  return (
    <main className="page">
      <div className="page-intro">
        <h1>Recorded runs</h1>
        <p>
          {generate} designs generated from a one-line prompt and {fix} broken test designs repaired
          by the fix loop, replayed step by step. The best come first. The ones the judge
          didn&apos;t approve, or the loop didn&apos;t solve, are further down, with what still
          looks wrong.
        </p>
      </div>
      <ol className="run-grid">
        {index.runs.map((run) => (
          <RunCard key={run.id} run={run} />
        ))}
      </ol>
    </main>
  );
}
