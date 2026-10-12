import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CheckWorkspace } from '@/components/CheckWorkspace';
import { readGalleryIndex } from '@/lib/gallery/read';

export const metadata: Metadata = { title: 'Check a design' };

export default function CheckPage() {
  const index = readGalleryIndex();
  return (
    <main className="page">
      <div className="page-intro">
        <h1>Check a design</h1>
        <p>
          Open a sample or your own design JSON, then move, resize or recolor anything. The checker
          runs in your browser and re-checks on every change.
        </p>
      </div>
      <Suspense fallback={<p className="note">Loading…</p>}>
        <CheckWorkspace index={index} />
      </Suspense>
    </main>
  );
}
