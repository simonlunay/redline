import { createCanvas } from '@napi-rs/canvas';
import type { Image } from '@napi-rs/canvas';
import { round2, shortSide } from '../core/geometry.js';
import { paintDesign } from '../core/paint.js';
import type { Design } from '../core/schema.js';
import type { Issue, RasterImage, Report, Severity } from '../core/types.js';
import { createFontMeasurer } from './font-measurer.js';
import { cssFont, registerBundledFonts } from './fonts.js';

export interface RenderOptions {
  /** Decoded images keyed by src (see loadDesignImages). Missing images render as placeholders. */
  images?: Map<string, Image>;
  /** Output scale, e.g. 0.5 for a smaller preview. */
  scale?: number;
}

/** Draws the design. `headerHeight` reserves a strip above it (used by the annotated view). */
function renderToCanvas(design: Design, options: RenderOptions, headerHeight = 0) {
  registerBundledFonts();
  const scale = options.scale ?? 1;
  const canvas = createCanvas(
    Math.round(design.canvas.width * scale),
    Math.round((design.canvas.height + headerHeight) * scale),
  );
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(0, headerHeight);
  paintDesign(ctx, design, {
    images: options.images ?? new Map(),
    measurer: createFontMeasurer(),
    cssFont,
  });
  return { canvas, ctx };
}

/** Renders the design to raw RGBA pixels (the RuleContext.render format). */
export function renderRaster(design: Design, options: RenderOptions = {}): RasterImage {
  const { canvas, ctx } = renderToCanvas(design, options);
  const { width, height, data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width, height, data };
}

/** Renders the design to a PNG buffer. */
export function renderPng(design: Design, options: RenderOptions = {}): Buffer {
  return renderToCanvas(design, options).canvas.toBuffer('image/png');
}

const SEVERITY_COLOR: Record<Severity, string> = {
  error: '#e5193b',
  warning: '#f59e0b',
  info: '#3b82f6',
};

/** e.g. "3. text-contrast 1.37:1". Only compact units are shown to keep labels short. */
function shortLabel(issue: Issue, index: number): string {
  let value = '';
  if (typeof issue.measured === 'number') {
    const unit = issue.unit?.startsWith('%')
      ? '%'
      : issue.unit === ':1' || issue.unit === 'px'
        ? issue.unit
        : '';
    value = ` ${round2(issue.measured)}${unit}`;
  }
  return `${index + 1}. ${issue.ruleId}${value}`;
}

/**
 * Renders the design with each issue drawn on top: a colored box around the primary element
 * and a numbered label. Numbers match the order of report.issues (and the CLI output).
 */
export function renderAnnotatedPng(
  design: Design,
  report: Report,
  options: RenderOptions = {},
): Buffer {
  const unit = shortSide(design.canvas) / 1080; // keep annotations readable at any canvas size
  const fontSize = Math.round(20 * unit);
  const pad = Math.round(6 * unit);
  // The score lives in a strip above the design so it can never hide an annotation.
  const headerHeight = Math.round(56 * unit);
  const { canvas, ctx } = renderToCanvas(design, options, headerHeight);
  const byId = new Map(design.elements.map((el) => [el.id, el]));
  const labelsPerElement = new Map<string, number>();

  const entries = report.issues.map((issue, index) => ({ issue, index }));
  // Boxes: draw lower severities first so error boxes end up on top.
  for (const { issue } of [...entries].reverse()) {
    const el = byId.get(issue.elementIds[0] ?? '');
    if (!el) continue;
    const color = SEVERITY_COLOR[issue.severity];
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, 4 * unit);
    ctx.setLineDash(issue.severity === 'error' ? [] : [12 * unit, 8 * unit]);
    ctx.strokeRect(el.x, el.y, el.width, el.height);
    ctx.restore();
  }

  // Labels: in report order, so the first issue on an element sits closest to it.
  for (const { issue, index } of entries) {
    const el = byId.get(issue.elementIds[0] ?? '');
    if (!el) continue;
    const stack = labelsPerElement.get(el.id) ?? 0;
    labelsPerElement.set(el.id, stack + 1);
    const text = shortLabel(issue, index);
    ctx.font = cssFont({ family: 'Inter', size: fontSize, weight: 700 });
    const w = ctx.measureText(text).width + pad * 2;
    const h = fontSize + pad * 2;
    // Stack labels above the element, clamped to stay on the canvas.
    const x = Math.min(Math.max(0, el.x), design.canvas.width - w);
    const y = Math.min(Math.max(0, el.y - h * (stack + 1)), design.canvas.height - h);
    ctx.fillStyle = SEVERITY_COLOR[issue.severity];
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + pad, y + h / 2);
  }

  // Header strip: score and issue counts.
  ctx.translate(0, -headerHeight);
  ctx.fillStyle = report.passed ? '#15803d' : '#b91c1c';
  ctx.fillRect(0, 0, design.canvas.width, headerHeight);
  const { errors, warnings, infos } = report.summary;
  ctx.font = cssFont({ family: 'Inter', size: Math.round(26 * unit), weight: 900 });
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(
    `Redline ${report.score}/100 · ${errors} errors · ${warnings} warnings · ${infos} info`,
    pad * 3,
    headerHeight / 2,
  );

  return canvas.toBuffer('image/png');
}
