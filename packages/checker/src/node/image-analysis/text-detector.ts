import { createCanvas } from '@napi-rs/canvas';
import type { Image } from '@napi-rs/canvas';
import type * as OrtModule from 'onnxruntime-node';
import type { TextRegion } from '../../core/image-analysis.js';
import { ensureModelFile } from '../saliency/model-file.js';
import type { EnsureOptions, PinnedModelFile } from '../saliency/model-file.js';

/**
 * PP-OCRv5_mobile_det (PaddleOCR, Apache-2.0): a DBNet text *detector*, 4.8 MB. Official ONNX
 * export from huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx at commit e6f4fa8,
 * downloaded from there on first use (not re-hosted) and pinned by size and SHA-256.
 *
 * Detection only, no recognition: gibberish lettering isn't readable anyway, and finding
 * text-shaped marks is what matters.
 */
export const PP_OCR_DET: PinnedModelFile & { id: string; license: string } = {
  id: 'pp-ocrv5-mobile-det@e6f4fa8',
  license: 'Apache-2.0 (PaddleOCR PP-OCRv5_mobile_det)',
  fileName: 'pp-ocrv5-mobile-det-e6f4fa8.onnx',
  url: 'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/e6f4fa85f00e168c862bc462aebca69eef9b3d3d/inference.onnx',
  bytes: 4826518,
  sha256: 'a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d',
};

/**
 * en_PP-OCRv5_mobile_rec (PaddleOCR, Apache-2.0), 7.8 MB, official ONNX export from
 * huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx at commit 3fafbc3. Used only as a
 * verifier: a detected box counts as text when the recognizer reads several characters in it
 * with confidence. Rows of trees or oranges trip the detector but read as nothing. No
 * dictionary is needed for that (CTC: count the non-blank steps), so none is downloaded.
 */
export const PP_OCR_REC: PinnedModelFile & { id: string; license: string } = {
  id: 'en-pp-ocrv5-mobile-rec@3fafbc3',
  license: 'Apache-2.0 (PaddleOCR en_PP-OCRv5_mobile_rec)',
  fileName: 'en-pp-ocrv5-mobile-rec-3fafbc3.onnx',
  url: 'https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx/resolve/3fafbc3b5dcf93dd72add9f48368be8a3a2cd33b/inference.onnx',
  bytes: 7848423,
  sha256: 'b5f833dfc5d0eb71da397b4efa06ebeee9b431b690a47d6af40d77d8eabc557f',
};

/** From the model's inference.yml: DetResizeForTest resize_long 960, ImageNet mean/std, BGR. */
const RESIZE_LONG = 960;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export interface DbOptions {
  /** Pixel probability threshold (DBPostProcess thresh). */
  thresh: number;
  /** Mean probability a box needs to count (box_thresh). */
  boxThresh: number;
  /** How far boxes are grown back out (DB shrinks text during training). */
  unclipRatio: number;
  /** Components smaller than this many map pixels are ignored. */
  minPixels: number;
}

export const DB_DEFAULTS: DbOptions = {
  thresh: 0.3,
  boxThresh: 0.6,
  unclipRatio: 1.5,
  minPixels: 12,
};

/**
 * DB post-processing, simplified to axis-aligned boxes: threshold the probability map, take
 * 4-connected components, score each by its mean probability, and grow it by the DB unclip
 * offset (area x ratio / perimeter). Returns boxes normalized to the map size (0..1).
 */
export function dbBoxes(
  prob: Float32Array,
  width: number,
  height: number,
  options: DbOptions = DB_DEFAULTS,
): TextRegion[] {
  const seen = new Uint8Array(width * height);
  const out: TextRegion[] = [];
  const stack: number[] = [];
  for (let start = 0; start < prob.length; start++) {
    if (seen[start] || prob[start]! < options.thresh) continue;
    seen[start] = 1;
    stack.push(start);
    let n = 0;
    let sum = 0;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i - x) / width;
      n++;
      sum += prob[i]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
        if (j < 0 || j >= prob.length || seen[j] || prob[j]! < options.thresh) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (n < options.minPixels) continue;
    const score = sum / n;
    if (score < options.boxThresh) continue;
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const d = (w * h * options.unclipRatio) / (2 * (w + h));
    const bx0 = Math.max(0, x0 - d);
    const by0 = Math.max(0, y0 - d);
    const bx1 = Math.min(width, x1 + 1 + d);
    const by1 = Math.min(height, y1 + 1 + d);
    out.push({
      x: bx0 / width,
      y: by0 / height,
      width: (bx1 - bx0) / width,
      height: (by1 - by0) / height,
      score: Number(score.toFixed(3)),
    });
  }
  return out;
}

export interface TextDetector {
  id: string;
  license: string;
  /**
   * Text regions in normalized image coordinates: boxes the detector finds that the recognizer
   * reads as characters (each with `chars` and `readConfidence`).
   */
  detect(image: Image | RasterLike): Promise<TextRegion[]>;
  /** Every detector box before the recognizer's verdict, for tuning and debugging. */
  detectRaw(image: Image | RasterLike): Promise<TextRegion[]>;
}

interface RasterLike {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface TextDetectorOptions extends EnsureOptions {
  /** Local .onnx files instead of the pinned downloads (also: REDLINE_TEXT_DET_MODEL / _REC_). */
  detModelPath?: string;
  recModelPath?: string;
  db?: Partial<DbOptions>;
  /** A box is text when the recognizer reads at least this many characters... */
  minChars?: number;
  /** ...with at least this mean per-character confidence. */
  minReadConfidence?: number;
}

type Ort = typeof OrtModule;

/** Draws any image into a canvas of the given size and returns its RGBA pixels. */
function pixels(
  image: Image | RasterLike,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  if ('data' in image) {
    const src = createCanvas(image.width, image.height);
    const sctx = src.getContext('2d');
    const id = sctx.createImageData(image.width, image.height);
    id.data.set(image.data);
    sctx.putImageData(id, 0, 0);
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  } else {
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, w, h);
  }
  return ctx.getImageData(0, 0, w, h).data;
}

/** Transparent pixels (cutouts) are composited on mid grey, which reads as no text. */
const channel = (px: Uint8ClampedArray, i: number, c: number) => {
  const a = px[i * 4 + 3]! / 255;
  return (px[i * 4 + c]! * a + 128 * (1 - a)) / 255;
};

/**
 * CTC read-out without a dictionary: the number of characters (non-blank steps after
 * collapsing repeats) and their mean probability. Index 0 is the CTC blank in PaddleOCR.
 */
export function ctcRead(probs: Float32Array, steps: number, classes: number) {
  let chars = 0;
  let sum = 0;
  let prev = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let p = -Infinity;
    for (let k = 0; k < classes; k++) {
      const v = probs[t * classes + k]!;
      if (v > p) {
        p = v;
        best = k;
      }
    }
    if (best !== 0 && best !== prev) {
      chars++;
      sum += p;
    }
    prev = best;
  }
  return { chars, confidence: chars ? sum / chars : 0 };
}

/** Loads PP-OCRv5 det + en rec with onnxruntime-node. Sessions are created once. */
export async function createOnnxTextDetector(
  options: TextDetectorOptions = {},
): Promise<TextDetector> {
  const ort = (await import('onnxruntime-node')) as Ort;
  const detPath =
    options.detModelPath ??
    process.env.REDLINE_TEXT_DET_MODEL ??
    (await ensureModelFile(PP_OCR_DET, options));
  const recPath =
    options.recModelPath ??
    process.env.REDLINE_TEXT_REC_MODEL ??
    (await ensureModelFile(PP_OCR_REC, options));
  // logSeverityLevel 3: the Paddle exports carry unused initializers ORT warns about on load.
  const session = { graphOptimizationLevel: 'all', logSeverityLevel: 3 } as const;
  const det = await ort.InferenceSession.create(detPath, session);
  const rec = await ort.InferenceSession.create(recPath, session);
  const db = { ...DB_DEFAULTS, ...options.db };
  const minChars = options.minChars ?? 3;
  const minReadConfidence = options.minReadConfidence ?? 0.8;
  // One inference at a time: sessions aren't meant for overlapping runs.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };

  async function boxes(image: Image | RasterLike): Promise<TextRegion[]> {
    const scale = Math.min(1, RESIZE_LONG / Math.max(image.width, image.height));
    // Dimensions must be multiples of 32.
    const w = Math.max(32, Math.round((image.width * scale) / 32) * 32);
    const h = Math.max(32, Math.round((image.height * scale) / 32) * 32);
    const px = pixels(image, 0, 0, image.width, image.height, w, h);
    const tensor = new Float32Array(3 * w * h);
    for (let i = 0; i < w * h; i++) {
      // BGR order, normalized with the mean/std in the same order (as Paddle does).
      for (let c = 0; c < 3; c++)
        tensor[c * w * h + i] = (channel(px, i, 2 - c) - MEAN[c]!) / STD[c]!;
    }
    const result = await det.run({
      [det.inputNames[0]!]: new ort.Tensor('float32', tensor, [1, 3, h, w]),
    });
    const out = result[det.outputNames[0]!]!;
    const dims = out.dims as number[];
    return dbBoxes(out.data as Float32Array, dims[3] ?? w, dims[2] ?? h, db);
  }

  /** Reads one box: height 48, width by aspect (8-1600 px), (x/255 - 0.5) / 0.5, BGR. */
  async function read(image: Image | RasterLike, r: TextRegion) {
    const sx = r.x * image.width;
    const sy = r.y * image.height;
    const sw = Math.max(1, r.width * image.width);
    const sh = Math.max(1, r.height * image.height);
    const H = 48;
    const W = Math.min(1600, Math.max(8, Math.round((sw / sh) * H)));
    const px = pixels(image, sx, sy, sw, sh, W, H);
    const tensor = new Float32Array(3 * W * H);
    for (let i = 0; i < W * H; i++) {
      for (let c = 0; c < 3; c++) tensor[c * W * H + i] = (channel(px, i, 2 - c) - 0.5) / 0.5;
    }
    const result = await rec.run({
      [rec.inputNames[0]!]: new ort.Tensor('float32', tensor, [1, 3, H, W]),
    });
    const out = result[rec.outputNames[0]!]!;
    const [, steps, classes] = out.dims as number[];
    return ctcRead(out.data as Float32Array, steps!, classes!);
  }

  async function detect(image: Image | RasterLike): Promise<TextRegion[]> {
    const found: TextRegion[] = [];
    for (const r of await boxes(image)) {
      const { chars, confidence } = await read(image, r);
      const region = { ...r, chars, readConfidence: Number(confidence.toFixed(3)) };
      if (chars >= minChars && confidence >= minReadConfidence) found.push(region);
    }
    return found;
  }

  return {
    id: `${PP_OCR_DET.id}+${PP_OCR_REC.id}`,
    license: 'Apache-2.0 (PaddleOCR PP-OCRv5 mobile det + en rec)',
    detect: (image) => exclusive(() => detect(image)),
    detectRaw: (image) =>
      exclusive(async () =>
        Promise.all(
          (await boxes(image)).map(async (r) => {
            const { chars, confidence } = await read(image, r);
            return { ...r, chars, readConfidence: Number(confidence.toFixed(3)) };
          }),
        ),
      ),
  };
}
