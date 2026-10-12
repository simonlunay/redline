import type { Metadata } from 'next';
import Link from 'next/link';
import { Player } from '@/components/Player';
import { readGalleryIndex, readRun } from '@/lib/gallery/read';

export const dynamicParams = false;

export function generateStaticParams() {
  return readGalleryIndex().runs.map((r) => ({ id: r.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const run = readRun(id);
  return { title: run.title, description: run.prompt ?? `The fix loop on ${run.title}.` };
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = readRun(id);
  return (
    <main className="page run-page">
      <div className="run-head">
        <Link href="/gallery/" className="back">
          All runs
        </Link>
        <h1>{run.title}</h1>
        <p className="run-prompt">
          {run.kind === 'generate' ? (
            <>
              <span className="muted">Prompt: </span>“{run.prompt}”, {run.canvas.width}×
              {run.canvas.height}
            </>
          ) : (
            <>
              <span className="muted">The fix loop on a broken test design, </span>
              {run.canvas.width}×{run.canvas.height}
            </>
          )}
        </p>
      </div>
      <Player record={run} />
    </main>
  );
}
