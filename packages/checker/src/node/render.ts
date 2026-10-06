import { createCanvas } from '@napi-rs/canvas';
import type { Image, SKRSContext2D } from '@napi-rs/canvas';
import { round2, shortSide } from '../core/geometry.js';
import type { Design, DesignElement, ImageElement } from '../core/schema.js';
import { paintOrder } from '../core/rules/util.js';
import { fontOf, wrapText } from '../core/text-measure.js';
import type { Issue, Report, Severity } from '../core/types.js';
import { createFontMeasurer } from './font-measurer.js';
import { cssFont, registerBundledFonts } from './fonts.js';

export interface RenderOptions {
  /** Decoded images keyed by src (see loadDesignImages). Missing images render as placeholders. */
  images?: Map<string, Image>;
  /** Output scale, e.g. 0.5 for a smaller preview. */
  scale?: number;
}

function drawImageElement(ctx: SKRSContext2D, el: ImageElement, img: Image | undefined) {
  if (!img) {
    // Visible placeholder so a missing file is obvious in previews.
    ctx.fillStyle = '#d0d0d0';
    ctx.fillRect(el.x, el.y, el.width, el.height);
    ctx.strokeStyle = '#888888';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(el.x, el.y);
    ctx.lineTo(el.x + el.width, el.y + el.height);
    ctx.moveTo(el.x + el.width, el.y);
    ctx.lineTo(el.x, el.y + el.height);
    ctx.stroke();
    return;
  }
  if (el.fit === 'fill') {
    ctx.drawImage(img, el.x, el.y, el.width, el.height);
    return;
  }
  const sx = el.width / img.width;
  const sy = el.height / img.height;
  const scale = el.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(el.x, el.y, el.width, el.height);
  ctx.clip();
  ctx.drawImage(img, el.x + (el.width - w) / 2, el.y + (el.height - h) / 2, w, h);
  ctx.restore();
}

function drawElement(
  ctx: SKRSContext2D,
  el: DesignElement,
  images: Map<string, Image>,
  measurer: ReturnType<typeof createFontMeasurer>,
) {
  ctx.save();
  ctx.globalAlpha = el.opacity;
  if (el.rotation !== 0) {
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((el.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  if (el.type === 'shape') {
    ctx.fillStyle = el.fill;
    ctx.beginPath();
    if (el.kind === 'ellipse') {
      ctx.ellipse(
        el.x + el.width / 2,
        el.y + el.height / 2,
        el.width / 2,
        el.height / 2,
        0,
        0,
        Math.PI * 2,
      );
    } else {
      ctx.roundRect(el.x, el.y, el.width, el.height, el.cornerRadius);
    }
    ctx.fill();
  } else if (el.type === 'image') {
    drawImageElement(ctx, el, images.get(el.src));
  } else {
    const font = fontOf(el);
    ctx.font = cssFont(font);
    ctx.fillStyle = el.color;
    ctx.textAlign = el.align;
    ctx.textBaseline = 'middle';
    const lineHeight = el.fontSize * el.lineHeight;
    const x =
      el.align === 'left' ? el.x : el.align === 'right' ? el.x + el.width : el.x + el.width / 2;
    // Deliberately not clipped: overflowing text should be visible in the preview.
    wrapText(el.content, el.width, font, measurer).forEach((line, i) => {
      ctx.fillText(line, x, el.y + i * lineHeight + lineHeight / 2);
    });
  }
  ctx.restore();
}

function renderToCanvas(design: Design, options: RenderOptions) {
  registerBundledFonts();
  const scale = options.scale ?? 1;
  const canvas = createCanvas(
    Math.round(design.canvas.width * scale),
    Math.round(design.canvas.height * scale),
  );
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = design.canvas.background;
  ctx.fillRect(0, 0, design.canvas.width, design.canvas.height);
  const measurer = createFontMeasurer();
  for (const el of paintOrder(design)) {
    drawElement(ctx, el, options.images ?? new Map(), measurer);
  }
  return { canvas, ctx };
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
    const unit = issue.unit === ':1' || issue.unit === 'px' ? issue.unit : '';
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
  const { canvas, ctx } = renderToCanvas(design, options);
  const unit = shortSide(design.canvas) / 1080; // keep annotations readable at any canvas size
  const fontSize = Math.round(20 * unit);
  const pad = Math.round(6 * unit);
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

  // Score badge in the top-right corner.
  const badge = `Redline ${report.score}/100`;
  ctx.font = cssFont({ family: 'Inter', size: Math.round(28 * unit), weight: 900 });
  const bw = ctx.measureText(badge).width + pad * 4;
  const bh = Math.round(28 * unit) + pad * 3;
  ctx.fillStyle = report.passed ? '#15803d' : '#b91c1c';
  ctx.fillRect(design.canvas.width - bw, 0, bw, bh);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(badge, design.canvas.width - bw + pad * 2, bh / 2);

  return canvas.toBuffer('image/png');
}
