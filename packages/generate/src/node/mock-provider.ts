import { createCanvas } from '@napi-rs/canvas';
import type { GeneratedImage, ImageProvider, ImageRequest } from '../providers/types.js';

/** Small seeded PRNG (mulberry32): same seed, same image, on every machine. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hsl = (h: number, s: number, l: number) =>
  `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;

/** The plain backdrop mock subjects are drawn on (what the keyer removes). */
export const MOCK_BACKDROP = '#e5e7eb';

/**
 * Deterministic stand-in for a text-to-image model. Backgrounds are seeded gradients with soft
 * blobs and a little noise (busy enough to exercise contrast and attention rules); subjects are
 * a shaded object on a plain light-grey backdrop, like the real subject prompt asks for. Costs
 * nothing and never touches the network, so every test uses it.
 */
export function createMockImageProvider(options: { megapixels?: number } = {}): ImageProvider {
  const pixels = (options.megapixels ?? 0.25) * 1e6;
  return {
    id: 'mock',
    model: 'mock-gradient-v1',
    license: 'Generated locally by Redline (no third-party content)',
    estimateCostUsd: () => 0,
    async generate(req: ImageRequest): Promise<GeneratedImage> {
      const aspect = req.width / req.height;
      const width = Math.max(16, Math.round(Math.sqrt(pixels * aspect) / 16) * 16);
      const height = Math.max(16, Math.round(width / aspect / 16) * 16);
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const rand = prng(req.seed);
      const hue = rand() * 360;

      if (req.kind === 'subject') {
        ctx.fillStyle = MOCK_BACKDROP;
        ctx.fillRect(0, 0, width, height);
        const w = width * (0.4 + rand() * 0.2);
        const h = height * (0.55 + rand() * 0.2);
        const x = (width - w) / 2;
        const y = (height - h) / 2;
        const gradient = ctx.createLinearGradient(x, y, x + w, y + h);
        gradient.addColorStop(0, hsl(hue, 80, 60));
        gradient.addColorStop(1, hsl(hue + 30, 85, 35));
        ctx.fillStyle = gradient;
        ctx.beginPath();
        if (rand() < 0.5) ctx.ellipse(width / 2, height / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        else ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.2);
        ctx.fill();
      } else {
        const gradient = ctx.createLinearGradient(0, 0, width * rand(), height);
        gradient.addColorStop(0, hsl(hue, 55, 22 + rand() * 20));
        gradient.addColorStop(1, hsl(hue + 40 + rand() * 60, 60, 35 + rand() * 25));
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
        for (let i = 0; i < 7; i++) {
          const cx = rand() * width;
          const cy = rand() * height;
          const r = (0.08 + rand() * 0.25) * Math.min(width, height);
          const blob = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          blob.addColorStop(0, hsl(hue + rand() * 120, 70, 50 + rand() * 30));
          blob.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = blob;
          ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
        const data = ctx.getImageData(0, 0, width, height);
        for (let i = 0; i < data.data.length; i += 4) {
          const n = (rand() - 0.5) * 18;
          data.data[i] = Math.min(255, Math.max(0, data.data[i]! + n));
          data.data[i + 1] = Math.min(255, Math.max(0, data.data[i + 1]! + n));
          data.data[i + 2] = Math.min(255, Math.max(0, data.data[i + 2]! + n));
        }
        ctx.putImageData(data, 0, 0);
      }
      return {
        bytes: new Uint8Array(await canvas.encode('png')),
        mimeType: 'image/png',
        provider: 'mock',
        model: 'mock-gradient-v1',
        seed: req.seed,
        costUsd: 0,
        license: 'Generated locally by Redline (no third-party content)',
      };
    },
  };
}
