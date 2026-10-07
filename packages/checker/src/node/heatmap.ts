import { ImageData, createCanvas, loadImage } from '@napi-rs/canvas';
import type { SKRSContext2D } from '@napi-rs/canvas';
import type { SaliencyMap } from '../core/attention/saliency.js';
import { KEY_ROLES, analyzeAttention, pct } from '../core/attention/shares.js';
import type { AttentionAnalysis } from '../core/attention/shares.js';
import { shortSide } from '../core/geometry.js';
import type { Design, DesignElement } from '../core/schema.js';
import { cssFont } from './fonts.js';
import { renderPng } from './render.js';
import type { RenderOptions } from './render.js';

/** Transparent -> yellow -> red; alpha grows with attention so cold areas stay readable. */
export function heatColor(t: number): [number, number, number, number] {
  const v = Math.min(1, Math.max(0, t));
  const r = 255;
  const g = Math.round(230 * (1 - Math.max(0, v - 0.35) / 0.65));
  const b = Math.round(40 * (1 - v));
  const a = Math.round(255 * Math.min(0.7, Math.pow(v, 0.7) * 0.8));
  return [r, g, b, a];
}

const LABEL: Record<string, string> = {
  cta: 'CTA',
  headline: 'Headline',
  product: 'Product',
  logo: 'Logo',
};

function unionBox(elements: DesignElement[]) {
  const x = Math.min(...elements.map((e) => e.x));
  const y = Math.min(...elements.map((e) => e.y));
  return {
    x,
    y,
    width: Math.max(...elements.map((e) => e.x + e.width)) - x,
    height: Math.max(...elements.map((e) => e.y + e.height)) - y,
  };
}

function label(ctx: SKRSContext2D, text: string, x: number, y: number, size: number, maxX: number) {
  ctx.font = cssFont({ family: 'Inter', size, weight: 800 });
  const pad = Math.round(size * 0.3);
  const w = ctx.measureText(text).width + pad * 2;
  const h = size + pad * 2;
  const lx = Math.min(Math.max(0, x), maxX - w);
  const ly = Math.max(0, y - h);
  ctx.fillStyle = 'rgba(17, 24, 39, 0.88)';
  ctx.fillRect(lx, ly, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, lx + pad, ly + h / 2);
}

export interface HeatmapOptions extends RenderOptions {
  /** Shown in the header, e.g. the saliency model id. */
  modelId?: string;
}

/**
 * The design with predicted attention painted on top, key elements outlined and labeled with
 * their share (e.g. "CTA 4%"), and the predicted viewing order in a header strip.
 */
export async function renderHeatmapPng(
  design: Design,
  map: SaliencyMap,
  options: HeatmapOptions = {},
): Promise<Buffer> {
  const attention: AttentionAnalysis = analyzeAttention(design, map);
  const { width: W, height: H } = design.canvas;
  const unit = shortSide(design.canvas) / 1080;
  const header = Math.round(56 * unit);
  const canvas = createCanvas(W, H + header);
  const ctx = canvas.getContext('2d');

  const base = await loadImage(renderPng(design, { images: options.images }));
  ctx.drawImage(base, 0, header, W, H);

  // Heat layer at the model's resolution, then scaled up smoothly over the design.
  let max = 0;
  for (const v of map.data) max = Math.max(max, v);
  const pixels = new Uint8ClampedArray(map.width * map.height * 4);
  for (let i = 0; i < map.data.length; i++) {
    const [r, g, b, a] = heatColor(max > 0 ? map.data[i]! / max : 0);
    pixels.set([r, g, b, a], i * 4);
  }
  const heat = createCanvas(map.width, map.height);
  heat.getContext('2d').putImageData(new ImageData(pixels, map.width, map.height), 0, 0);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(heat, 0, header, W, H);

  // Key roles (button + label together) and loud decorations, outlined and labeled.
  ctx.translate(0, header);
  const size = Math.max(12, Math.round(22 * unit));
  for (const role of KEY_ROLES) {
    const elements = design.elements.filter((el) => el.role === role);
    if (elements.length === 0) continue;
    const box = unionBox(elements);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, 3 * unit);
    ctx.setLineDash([10 * unit, 6 * unit]);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.setLineDash([]);
    label(ctx, `${LABEL[role]} ${pct(attention.roleShares[role] ?? 0)}`, box.x, box.y, size, W);
  }
  for (const el of design.elements) {
    const share = attention.elementShares[el.id] ?? 0;
    if (el.role === 'decoration' && share >= 0.05) {
      label(ctx, `decoration ${pct(share)}`, el.x, el.y + el.height, size, W);
    }
  }
  ctx.translate(0, -header);

  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, W, header);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.font = cssFont({ family: 'Inter', size: Math.round(24 * unit), weight: 800 });
  const order = attention.viewingOrder.map((r) => LABEL[r] ?? r).join(' → ');
  const title = `Predicted attention · order: ${order || 'n/a'}`;
  const margin = Math.round(16 * unit);
  ctx.fillText(title, margin, header / 2);
  const titleWidth = ctx.measureText(title).width;
  // The model note goes on the right only if it fits next to the title (narrow banners).
  ctx.font = cssFont({ family: 'Inter', size: Math.round(16 * unit), weight: 400 });
  const note = `${options.modelId ?? 'saliency model'} · prediction, not eye tracking`;
  if (margin * 3 + titleWidth + ctx.measureText(note).width <= W) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#9ca3af';
    ctx.fillText(note, W - margin, header / 2);
  }

  return canvas.toBuffer('image/png');
}
