'use client';

import type { Design } from '@simonlunay/redline';
import { useEffect, useRef } from 'react';
import { drawDesign } from '@/lib/env/design-env';
import type { DesignEnv } from '@/lib/env/design-env';

/** A small rendering of a design (the candidate strip), with the shared renderer. */
export function Thumb({
  design,
  env,
  width = 120,
  label,
}: {
  design: Design;
  env: DesignEnv<ImageBitmap> | null;
  width?: number;
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { width: W, height: H } = design.canvas;
  useEffect(() => {
    const c = ref.current;
    if (!c || !env) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(width * dpr);
    c.height = Math.round((width * dpr * H) / W);
    const ctx = c.getContext('2d');
    if (ctx) drawDesign<ImageBitmap>(ctx, design, env, c.width / W);
  }, [design, env, width, W, H]);
  return (
    <canvas
      ref={ref}
      className="thumb"
      style={{ width, aspectRatio: `${W} / ${H}` }}
      role="img"
      aria-label={label}
    />
  );
}
