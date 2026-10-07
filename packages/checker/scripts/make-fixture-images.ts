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

// ---- Images for the messier, ad-like fixtures (phase 2 eval) ----

// A busy mid-tone "street" photo: neither black nor white text reads well everywhere on it.
save('street.png', 1080, 1080, (ctx) => {
  const g = ctx.createLinearGradient(0, 0, 1080, 1080);
  g.addColorStop(0, '#8a8f99');
  g.addColorStop(0.5, '#b7a99a');
  g.addColorStop(1, '#5d6470');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1080, 1080);
  const colors = ['#d9d4cc', '#4b525c', '#a39280', '#e8e2d8', '#6f7884'];
  for (let i = 0; i < 18; i++) {
    ctx.fillStyle = colors[i % colors.length]!;
    ctx.fillRect(i * 60, 200 + ((i * 97) % 300), 48, 1080);
  }
  ctx.fillStyle = '#f2efe9';
  ctx.fillRect(0, 820, 1080, 40);
});

// A sneaker on a light backdrop, 3:2.
save('sneaker.png', 900, 600, (ctx) => {
  ctx.fillStyle = '#eef2f7';
  ctx.fillRect(0, 0, 900, 600);
  ctx.fillStyle = '#e11d48';
  ctx.beginPath();
  ctx.moveTo(150, 420);
  ctx.quadraticCurveTo(200, 230, 380, 250);
  ctx.quadraticCurveTo(480, 300, 600, 330);
  ctx.quadraticCurveTo(760, 350, 760, 420);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#111827';
  ctx.fillRect(140, 420, 640, 40);
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 5; i++) ctx.fillRect(330 + i * 28, 270 + i * 8, 14, 50);
});

// A concert stage, 9:16: dark, with bright spotlights and haze through the middle.
save('stage.png', 1080, 1920, (ctx) => {
  ctx.fillStyle = '#0b0b1a';
  ctx.fillRect(0, 0, 1080, 1920);
  const beams = ['#ff3ea5', '#3ec5ff', '#ffe03e'];
  beams.forEach((color, i) => {
    const x = 200 + i * 340;
    const g = ctx.createLinearGradient(x, 0, x, 1400);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - 30, 0);
    ctx.lineTo(x + 30, 0);
    ctx.lineTo(x + 260, 1400);
    ctx.lineTo(x - 260, 1400);
    ctx.fill();
  });
  const haze = ctx.createLinearGradient(0, 700, 0, 1200);
  haze.addColorStop(0, 'rgba(255,255,255,0)');
  haze.addColorStop(0.5, 'rgba(230,230,255,0.75)');
  haze.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 700, 1080, 500);
  ctx.fillStyle = '#05050d';
  ctx.fillRect(0, 1500, 1080, 420);
});

// A product "screenshot" for the SaaS banner, 16:10.
save('dashboard.png', 800, 500, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 800, 500);
  ctx.fillStyle = '#1e1b4b';
  ctx.fillRect(0, 0, 160, 500);
  ctx.fillStyle = '#e0e7ff';
  for (let i = 0; i < 3; i++) ctx.fillRect(190 + i * 200, 30, 180, 90);
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(200, 420);
  [360, 300, 340, 220, 260, 170].forEach((y, i) => ctx.lineTo(260 + i * 95, y));
  ctx.stroke();
});

// A top-down bowl of food on a warm table, square.
save('food.png', 1000, 1000, (ctx) => {
  ctx.fillStyle = '#c2703d';
  ctx.fillRect(0, 0, 1000, 1000);
  ctx.fillStyle = '#d9894f';
  for (let i = 0; i < 10; i++) ctx.fillRect(0, i * 100, 1000, 40);
  circle(ctx, 500, 500, 380, '#f5f0e6');
  circle(ctx, 500, 500, 300, '#f2c14e');
  circle(ctx, 420, 430, 80, '#3f7d20');
  circle(ctx, 590, 470, 70, '#d64933');
  circle(ctx, 500, 600, 90, '#fff8dc');
});

// ---- Images for the hard (attention) fixtures (phase 3 eval) ----

// A busy, saturated market scene: lots of high-contrast detail competing for attention.
save('market.png', 1080, 1080, (ctx) => {
  ctx.fillStyle = '#3b2f2f';
  ctx.fillRect(0, 0, 1080, 1080);
  const colors = [
    '#ef4444',
    '#f59e0b',
    '#22c55e',
    '#3b82f6',
    '#a855f7',
    '#f43f5e',
    '#eab308',
    '#14b8a6',
  ];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const i = row * 9 + col;
      ctx.fillStyle = colors[(i * 5 + row) % colors.length]!;
      const x = col * 120 + ((row * 37) % 40);
      const y = row * 120 + ((col * 23) % 30);
      if (i % 3 === 0) circle(ctx, x + 50, y + 50, 38, ctx.fillStyle as string);
      else ctx.fillRect(x + 10, y + 10, 90, 80);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x + 20, y + 85, 50, 12);
    }
  }
  ctx.fillStyle = '#fef3c7';
  for (let i = 0; i < 6; i++) ctx.fillRect(0, i * 190 + 100, 1080, 6);
});

// A stylized face (portrait orientation). Saliency models are strongly drawn to faces.
save('portrait.png', 900, 1200, (ctx) => {
  const g = ctx.createLinearGradient(0, 0, 0, 1200);
  g.addColorStop(0, '#1f2937');
  g.addColorStop(1, '#111827');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 900, 1200);
  ctx.fillStyle = '#7c3aed';
  ctx.beginPath();
  ctx.ellipse(450, 1150, 380, 330, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f2c4a0';
  ctx.beginPath();
  ctx.ellipse(450, 520, 230, 290, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3f2a1d';
  ctx.beginPath();
  ctx.ellipse(450, 330, 250, 150, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  for (const x of [370, 530]) {
    circle(ctx, x, 500, 34, '#ffffff');
    circle(ctx, x, 505, 18, '#1e3a8a');
    circle(ctx, x, 505, 8, '#000000');
  }
  ctx.fillStyle = '#c2410c';
  ctx.beginPath();
  ctx.ellipse(450, 660, 80, 30, 0, 0, Math.PI);
  ctx.fill();
});
