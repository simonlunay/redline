import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { SKRSContext2D } from '@napi-rs/canvas';
import type { Design, Report } from '@simonlunay/redline';
import { renderPng } from '@simonlunay/redline/node';
import { ctaShare, roleShares } from '../select.js';
import type { Workspace } from './workspace.js';

export interface SheetColumn {
  title: string;
  subtitle: string;
  design: Design;
  report: Report;
  highlight?: 'winner' | 'final';
}

const BG = '#0b1020';
const FG = '#f8fafc';
const DIM = '#94a3b8';
const GREEN = '#22c55e';
const BLUE = '#38bdf8';

function scoreColor(score: number) {
  return score >= 85 ? GREEN : score >= 60 ? '#eab308' : '#ef4444';
}

const pct = (share: number | undefined) => (share === undefined ? '–' : `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`);

function fitText(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/**
 * The demo image: every candidate side by side with its score, CTA/headline attention and
 * heatmap, the winner outlined, and the final design after the fix loop in the last column.
 */
export async function renderContactSheet(
  workspace: Workspace,
  columns: SheetColumn[],
  options: { title: string; footer?: string } = { title: '' },
): Promise<Buffer> {
  const first = columns[0]!.design.canvas;
  const aspect = first.width / first.height;
  const cellWidth = aspect > 1.3 ? 560 : 360;
  const imageHeight = Math.round(cellWidth / aspect);
  const pad = 20;
  const header = 74;
  const label = 64;
  const titleHeight = 64;
  const footerHeight = options.footer ? 40 : 0;
  // Render first: rendering registers the bundled Inter font used for the labels.
  const renders: { render: Buffer; heatmap?: Buffer }[] = [];
  for (const column of columns) {
    await workspace.ensure(column.design);
    const render = renderPng(column.design, { images: workspace.images, scale: cellWidth / column.design.canvas.width });
    const heatmap = workspace.renderHeatmap ? await workspace.renderHeatmap(column.design) : undefined;
    renders.push({ render, ...(heatmap ? { heatmap } : {}) });
  }

  // The heatmap PNG carries its own header strip, so its height follows its own aspect ratio.
  const firstHeat = renders[0]?.heatmap ? await loadImage(renders[0].heatmap) : undefined;
  const heatHeight = firstHeat ? Math.round((firstHeat.height * cellWidth) / firstHeat.width) : 0;
  const columnHeight = label + imageHeight + (firstHeat ? pad / 2 + heatHeight : 0);
  const width = pad + columns.length * (cellWidth + pad);
  const height = titleHeight + header + columnHeight + pad + footerHeight;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'top';
  ctx.fillStyle = FG;
  ctx.font = '800 26px Inter';
  ctx.fillText(fitText(ctx, options.title, width - 2 * pad), pad, 18);

  for (let i = 0; i < columns.length; i++) {
    const column = columns[i]!;
    const x = pad + i * (cellWidth + pad);
    let y = titleHeight;
    const accent = column.highlight === 'winner' ? GREEN : column.highlight === 'final' ? BLUE : undefined;

    ctx.fillStyle = accent ?? FG;
    ctx.font = '800 20px Inter';
    ctx.fillText(fitText(ctx, column.title, cellWidth - 90), x, y);
    ctx.fillStyle = DIM;
    ctx.font = '400 14px Inter';
    ctx.fillText(fitText(ctx, column.subtitle, cellWidth), x, y + 28);
    // Score badge
    const score = column.report.score;
    ctx.fillStyle = scoreColor(score);
    ctx.beginPath();
    ctx.roundRect(x + cellWidth - 78, y - 4, 78, 40, 8);
    ctx.fill();
    ctx.fillStyle = '#0b1020';
    ctx.font = '900 26px Inter';
    ctx.textAlign = 'center';
    ctx.fillText(String(score), x + cellWidth - 39, y + 2);
    ctx.textAlign = 'left';
    y += header;

    const shares = roleShares(column.report);
    ctx.fillStyle = FG;
    ctx.font = '600 15px Inter';
    const e = column.report.summary;
    ctx.fillText(
      `${e.errors} errors · ${e.warnings} warnings · CTA ${pct(ctaShare(column.report))} · headline ${pct(shares?.headline)}`,
      x,
      y - 6,
    );
    y += label - 34;

    const render = await loadImage(renders[i]!.render);
    ctx.drawImage(render, x, y, cellWidth, imageHeight);
    if (accent) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 5;
      ctx.strokeRect(x - 2.5, y - 2.5, cellWidth + 5, imageHeight + 5);
    }
    if (renders[i]!.heatmap) {
      const heat = await loadImage(renders[i]!.heatmap!);
      const hy = y + imageHeight + pad / 2;
      ctx.drawImage(heat, x, hy, cellWidth, heatHeight);
    }
  }
  if (options.footer) {
    ctx.fillStyle = DIM;
    ctx.font = '400 15px Inter';
    ctx.fillText(fitText(ctx, options.footer, width - 2 * pad), pad, height - footerHeight + 8);
  }
  return canvas.toBuffer('image/png');
}
