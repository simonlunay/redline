'use client';

import type { Design } from '@simonlunay/redline';
import { useState } from 'react';
import type { DesignEnv } from '@/lib/env/design-env';
import { designJson, designPng, download } from '@/lib/export';

export function ExportButtons({
  design,
  env,
  url,
  name,
}: {
  design: Design;
  env: DesignEnv<ImageBitmap> | null;
  url: (src: string) => string;
  name: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const run = (f: () => Promise<void>) => () => {
    setError(null);
    f().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  return (
    <>
      <button
        type="button"
        className="button secondary"
        disabled={!env}
        onClick={run(async () => download(await designPng(design, env!), `${name}.png`))}
      >
        Export PNG
      </button>
      <button
        type="button"
        className="button secondary"
        onClick={run(async () => download(await designJson(design, url), `${name}.json`))}
      >
        Export JSON
      </button>
      {error ? (
        <p className="note" role="alert">
          Export failed: {error}
        </p>
      ) : null}
    </>
  );
}
