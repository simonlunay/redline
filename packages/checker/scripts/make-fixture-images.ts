/**
 * Generates the placeholder images used by fixtures/*.json.
 * Everything is drawn from simple shapes and gradients, so nothing is copyrighted and the
 * images can be regenerated at any time:  npm run fixture-images -w packages/checker
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import type { SKRSContext2D } from '@napi-rs/canvas';

const OUT_DIR = fileURLToPath(new URL('../../../fixtures/images/', import.meta.url));

function save(name: string, width: number, height: number, draw: (ctx: SKRSContext2D) => void) {
  const canvas = createCanvas(width, height);
  draw(canvas.getContext('2d'));
  writeFileSync(OUT_DIR + name, canvas.toBuffer('image/png'));
  console.log(`wrote fixtures/images/${name} (${width}x${height})`);
}

function circle(ctx: SKRSContext2D, x: number, y: number, r: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

mkdirSync(OUT_DIR, { recursive: true });

// A bright, pale sky: white text on top of it has poor contrast.
save('sky.png', 1080, 1080, (ctx) => {
  const g = ctx.createLinearGradient(0, 0, 0, 1080);
  g.addColorStop(0, '#bfe3ff');
  g.addColorStop(0.6, '#fff4d6');
  g.addColorStop(1, '#ffd9b3');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1080, 1080);
  circle(ctx, 780, 300, 120, '#fffbe8');
  ctx.fillStyle = '#9ccc9c';
  ctx.beginPath();
  ctx.moveTo(0, 900);
  ctx.quadraticCurveTo(300, 760, 620, 880);
  ctx.quadraticCurveTo(860, 960, 1080, 840);
  ctx.lineTo(1080, 1080);
  ctx.lineTo(0, 1080);
  ctx.fill();
});

// A "product": a stylized bottle on a soft circular backdrop, square.
save('product.png', 800, 800, (ctx) => {
  ctx.fillStyle = '#f5e6d3';
  ctx.fillRect(0, 0, 800, 800);
  circle(ctx, 400, 430, 300, '#e9cfae');
  ctx.fillStyle = '#7c2d12';
  ctx.beginPath();
  ctx.roundRect(300, 260, 200, 420, 60);
  ctx.fill();
  ctx.fillStyle = '#431407';
  ctx.fillRect(355, 160, 90, 120);
  ctx.fillStyle = '#fbbf24';
  ctx.fillRect(300, 420, 200, 120);
});

// A 3:2 landscape with hills and a sun, used for the stretched-image fixture.
save('landscape.png', 1200, 800, (ctx) => {
  const g = ctx.createLinearGradient(0, 0, 0, 800);
  g.addColorStop(0, '#1e3a8a');
  g.addColorStop(1, '#60a5fa');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1200, 800);
  circle(ctx, 900, 220, 90, '#fde68a');
  ctx.fillStyle = '#166534';
  ctx.beginPath();
  ctx.moveTo(0, 560);
  ctx.quadraticCurveTo(350, 380, 700, 560);
  ctx.quadraticCurveTo(950, 680, 1200, 520);
  ctx.lineTo(1200, 800);
  ctx.lineTo(0, 800);
  ctx.fill();
  // A perfect circle makes distortion easy to see when the image is stretched.
  circle(ctx, 300, 640, 70, '#facc15');
});
