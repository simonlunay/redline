import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import { ensureModelFile } from '@simonlunay/redline/node';
import type { PinnedModelFile } from '@simonlunay/redline/node';
import type * as OrtModule from 'onnxruntime-node';
import type { BackgroundRemover, Cutout } from '../cutout.js';

/**
 * BiRefNet_lite (Zheng et al., "Bilateral Reference for High-Resolution Dichotomous Image
 * Segmentation", CAAI AIR 2024), MIT license. ONNX export by onnx-community on Hugging Face,
 * downloaded from there (not re-hosted) and pinned by commit, size and SHA-256.
 */
export const BIREFNET_LITE: PinnedModelFile & { id: string; license: string } = {
  id: 'birefnet-lite@de15b22',
  license: 'MIT (BiRefNet by Peng Zheng et al.)',
  fileName: 'birefnet-lite-de15b22.onnx',
  url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model.onnx',
  bytes: 224005088,
  sha256: '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333',
};

const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
/** Alpha below this (0-255) counts as transparent when trimming. */
const TRIM_ALPHA = 12;

/** RGBA pixels of an encoded image. */
async function decode(bytes: Uint8Array) {
  const image = await loadImage(Buffer.from(bytes));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data };
}

/**
 * Applies an alpha mask (0-255 per pixel) to RGBA pixels, trims to the visible bounding box
 * plus a small margin, and encodes a PNG. The trim makes the element box match the subject.
 */
export async function applyMaskAndTrim(
  rgba: { width: number; height: number; data: Uint8ClampedArray },
  alpha: Uint8ClampedArray | Uint8Array,
): Promise<Cutout> {
  const { width, height } = rgba;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let opaque = 0;
  const out = new Uint8ClampedArray(rgba.data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = alpha[i]!;
      out[i * 4 + 3] = a;
      if (a > TRIM_ALPHA) {
        opaque++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('The cutout is empty: no subject was found');
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.01);
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const full = createCanvas(width, height);
  full.getContext('2d').putImageData(new ImageData(out, width, height), 0, 0);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const trimmed = createCanvas(w, h);
  trimmed.getContext('2d').drawImage(full, minX, minY, w, h, 0, 0, w, h);
  return {
    png: new Uint8Array(await trimmed.encode('png')),
    width: w,
    height: h,
    coverage: opaque / (width * height),
  };
}

type Ort = typeof OrtModule;

/** BiRefNet_lite through onnxruntime-node. The model is downloaded and verified on first use. */
export function createBiRefNetRemover(
  options: { modelPath?: string; onProgress?: (message: string) => void } = {},
): BackgroundRemover {
  let session: Promise<{ ort: Ort; session: OrtModule.InferenceSession }> | undefined;
  const load = () =>
    (session ??= (async () => {
      const ort = (await import('onnxruntime-node')) as Ort;
      const path =
        options.modelPath ??
        process.env.REDLINE_CUTOUT_MODEL ??
        (await ensureModelFile(BIREFNET_LITE, { onProgress: options.onProgress }));
      return { ort, session: await ort.InferenceSession.create(path) };
    })().catch((err: unknown) => {
      session = undefined;
      throw err;
    }));

  return {
    id: 'birefnet',
    model: BIREFNET_LITE.id,
    license: BIREFNET_LITE.license,
    async remove(bytes) {
      const { ort, session: s } = await load();
      const image = await loadImage(Buffer.from(bytes));
      const source = createCanvas(image.width, image.height);
      const sctx = source.getContext('2d');
      sctx.drawImage(image, 0, 0);
      const rgba = { width: image.width, height: image.height, data: sctx.getImageData(0, 0, image.width, image.height).data };

      // Preprocess exactly like the model's preprocessor_config: resize to 1024x1024 (no aspect
      // preservation), scale to 0-1, ImageNet mean/std, NCHW.
      const input = createCanvas(SIZE, SIZE);
      const ictx = input.getContext('2d');
      ictx.imageSmoothingQuality = 'high';
      ictx.drawImage(image, 0, 0, SIZE, SIZE);
      const px = ictx.getImageData(0, 0, SIZE, SIZE).data;
      const tensor = new Float32Array(3 * SIZE * SIZE);
      for (let i = 0; i < SIZE * SIZE; i++) {
        for (let c = 0; c < 3; c++) {
          tensor[c * SIZE * SIZE + i] = (px[i * 4 + c]! / 255 - MEAN[c]!) / STD[c]!;
        }
      }
      const result = await s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', tensor, [1, 3, SIZE, SIZE]) });
      const logits = result[s.outputNames[0]!]!.data as Float32Array;

      // Sigmoid -> 1024x1024 mask -> resize to the original size.
      const mask = createCanvas(SIZE, SIZE);
      const maskData = new Uint8ClampedArray(SIZE * SIZE * 4);
      for (let i = 0; i < SIZE * SIZE; i++) {
        const v = Math.round(255 / (1 + Math.exp(-logits[i]!)));
        maskData[i * 4] = v;
        maskData[i * 4 + 1] = v;
        maskData[i * 4 + 2] = v;
        maskData[i * 4 + 3] = 255;
      }
      mask.getContext('2d').putImageData(new ImageData(maskData, SIZE, SIZE), 0, 0);
      const scaled = createCanvas(image.width, image.height);
      const mctx = scaled.getContext('2d');
      mctx.imageSmoothingQuality = 'high';
      mctx.drawImage(mask, 0, 0, image.width, image.height);
      const m = mctx.getImageData(0, 0, image.width, image.height).data;
      const alpha = new Uint8ClampedArray(image.width * image.height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = m[i * 4]!;
      return applyMaskAndTrim(rgba, alpha);
    },
  };
}

/**
 * Fallback remover for subjects shot on a plain backdrop (which is what the subject prompt asks
 * for): estimates the backdrop color from the border and flood-fills it away from the edges,
 * with a soft ramp at the boundary. No model needed; worse on shadows, hair and backdrop-colored
 * subjects. Also used with the mock provider in tests.
 */
export function createBackdropKeyRemover(options: { tolerance?: number } = {}): BackgroundRemover {
  const tolerance = options.tolerance ?? 30;
  return {
    id: 'backdrop-key',
    model: 'backdrop-flood-key-v1',
    license: 'Part of Redline (MIT)',
    async remove(bytes) {
      const rgba = await decode(bytes);
      const { width, height, data } = rgba;
      // Backdrop color = per-channel median of the border pixels.
      const border: number[][] = [[], [], []];
      const push = (x: number, y: number) => {
        const i = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) border[c]!.push(data[i + c]!);
      };
      for (let x = 0; x < width; x++) {
        push(x, 0);
        push(x, height - 1);
      }
      for (let y = 0; y < height; y++) {
        push(0, y);
        push(width - 1, y);
      }
      const backdrop = border.map((values) => values.sort((a, b) => a - b)[values.length >> 1]!);
      const distance = (i: number) =>
        Math.hypot(data[i * 4]! - backdrop[0]!, data[i * 4 + 1]! - backdrop[1]!, data[i * 4 + 2]! - backdrop[2]!);

      const alpha = new Uint8ClampedArray(width * height).fill(255);
      const seen = new Uint8Array(width * height);
      const queue: number[] = [];
      const visit = (i: number) => {
        if (seen[i]) return;
        seen[i] = 1;
        const d = distance(i);
        if (d <= tolerance) {
          alpha[i] = 0;
          queue.push(i);
        } else if (d <= tolerance * 1.8) {
          alpha[i] = Math.round((255 * (d - tolerance)) / (tolerance * 0.8)); // soft edge, not expanded
        }
      };
      for (let x = 0; x < width; x++) {
        visit(x);
        visit((height - 1) * width + x);
      }
      for (let y = 0; y < height; y++) {
        visit(y * width);
        visit(y * width + width - 1);
      }
      while (queue.length > 0) {
        const i = queue.pop()!;
        const x = i % width;
        if (x > 0) visit(i - 1);
        if (x < width - 1) visit(i + 1);
        if (i >= width) visit(i - width);
        if (i < width * (height - 1)) visit(i + width);
      }
      return applyMaskAndTrim(rgba, alpha);
    },
  };
}

/**
 * BiRefNet when it can be loaded (onnxruntime-node installed, model downloadable), otherwise the
 * backdrop keyer. The returned remover reports which one actually ran via `lastUsed()`.
 */
export function createAutoRemover(
  options: { onProgress?: (message: string) => void; onFallback?: (reason: string) => void } = {},
): BackgroundRemover & { lastUsed(): BackgroundRemover | undefined } {
  const primary = createBiRefNetRemover({ onProgress: options.onProgress });
  const fallback = createBackdropKeyRemover();
  let broken: string | undefined;
  let last: BackgroundRemover | undefined;
  return {
    id: 'auto',
    model: `${primary.model} (fallback ${fallback.model})`,
    license: primary.license,
    lastUsed: () => last,
    async remove(bytes) {
      if (!broken) {
        try {
          const result = await primary.remove(bytes);
          last = primary;
          return result;
        } catch (err) {
          broken = err instanceof Error ? err.message : String(err);
          options.onFallback?.(broken);
        }
      }
      last = fallback;
      return fallback.remove(bytes);
    },
  };
}
