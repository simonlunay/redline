import { freemem } from 'node:os';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import { ensureModelFile } from '@simonlunay/redline/node';
import type { PinnedModelFile } from '@simonlunay/redline/node';
import type * as OrtModule from 'onnxruntime-node';
import { judgeCutout, measureCutout } from '@simonlunay/redline';
import type { CutoutVerdict } from '@simonlunay/redline';
import type { BackgroundRemover, Cutout } from '../cutout.js';
import type { ReplicateClient } from '../providers/replicate-client.js';
import type { SpendLedger } from '../spend.js';

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

/**
 * BiRefNet_lite's input is fixed at 1024x1024, and one fp32 inference on CPU peaks at about 6 GB
 * of native memory (measured: onnxruntime-node 1.30, Windows; fp16 weights don't lower it, ORT
 * casts back to fp32). With ONNX Runtime's default CPU arena that peak also stays reserved for the
 * life of the session (~6.5 GB held between cutouts, 8.2 GB peak). Without the arena and the
 * memory-pattern planner it's returned after every run, with identical output and speed.
 */
export const BIREFNET_SESSION_OPTIONS = {
  enableCpuMemArena: false,
  enableMemPattern: false,
  graphOptimizationLevel: 'all',
} as const;

/**
 * Free memory below which the auto remover uses the backdrop keyer instead: the ~6 GB inference
 * peak plus a margin. (A 2 GB threshold let an inference start with ~7 GB free during the eval,
 * and the host stopped the process for low memory.)
 */
const DEFAULT_MIN_FREE_BYTES = 7.5 * 1024 ** 3;

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
  return {
    width: image.width,
    height: image.height,
    data: ctx.getImageData(0, 0, image.width, image.height).data,
  };
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
      return { ort, session: await ort.InferenceSession.create(path, BIREFNET_SESSION_OPTIONS) };
    })().catch((err: unknown) => {
      session = undefined;
      throw err;
    }));
  // One inference at a time per remover, even when several generations share it (eval
  // concurrency): two overlapping runs would need ~12 GB.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  return {
    id: 'birefnet',
    model: BIREFNET_LITE.id,
    license: BIREFNET_LITE.license,
    remove: (bytes) => exclusive(() => removeWith(bytes)),
  };

  async function removeWith(bytes: Uint8Array): Promise<Cutout> {
    const { ort, session: s } = await load();
    const image = await loadImage(Buffer.from(bytes));
    const source = createCanvas(image.width, image.height);
    const sctx = source.getContext('2d');
    sctx.drawImage(image, 0, 0);
    const rgba = {
      width: image.width,
      height: image.height,
      data: sctx.getImageData(0, 0, image.width, image.height).data,
    };

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
    const result = await s.run({
      [s.inputNames[0]!]: new ort.Tensor('float32', tensor, [1, 3, SIZE, SIZE]),
    });
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
  }
}

/**
 * BiRefNet on Replicate (men1scus/birefnet), pinned by version. It's the same model family as the
 * local path, so the cuts stay comparable. Code: github.com/ZhengPeng7/BiRefNet (MIT). Weights:
 * huggingface.co/ZhengPeng7/BiRefNet-legacy (MIT), per the model page (checked 2026-10-11). It
 * runs on an A100 80GB, billed per second ($0.0014/s on replicate.com/pricing, checked
 * 2026-10-11). A 900x600 probe took 0.51 s, about $0.0007.
 */
export const REPLICATE_BIREFNET = {
  id: 'replicate-birefnet',
  model: 'men1scus/birefnet@f74986db',
  version: 'f74986db0355b58403ed20963af156525e2891ea3c2d499bfbfb2a28cd87c5d7',
  license: 'MIT (BiRefNet by Peng Zheng et al.; weights ZhengPeng7/BiRefNet-legacy)',
  usdPerSecond: 0.0014,
  /** What the spend guard reserves per cutout: ~7 s of GPU time, well above the usual 0.5-2 s. */
  estimateUsd: 0.01,
};

/** Image media type from the file's magic bytes (FLUX subjects are PNG; stock may be JPEG). */
function sniffImageType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    return 'image/webp';
  return 'application/octet-stream';
}

/**
 * Hosted BiRefNet, for machines without the ~8 GB free the local model needs. The subject is
 * uploaded to Replicate's file store (deleted again afterwards) and cut there. Only the returned
 * alpha is kept: it's applied to the original pixels and trimmed exactly like a local cut. Every
 * call is guarded by and recorded in the spend ledger.
 */
export function createReplicateBiRefNetRemover(options: {
  client: ReplicateClient;
  ledger?: SpendLedger;
  tag?: string;
}): BackgroundRemover {
  const { client, ledger } = options;
  const what = 'cutout (BiRefNet on Replicate)';
  return {
    id: REPLICATE_BIREFNET.id,
    model: REPLICATE_BIREFNET.model,
    license: REPLICATE_BIREFNET.license,
    async remove(bytes) {
      ledger?.guard(REPLICATE_BIREFNET.estimateUsd, what);
      const type = sniffImageType(bytes);
      const file = await client.upload(bytes, `subject.${type.split('/')[1] ?? 'bin'}`, type);
      let run: Awaited<ReturnType<ReplicateClient['run']>>;
      try {
        run = await client.run('/predictions', {
          version: REPLICATE_BIREFNET.version,
          input: { image: file.url },
        });
      } finally {
        await file.remove();
      }
      const seconds = run.prediction.metrics?.predict_time;
      ledger?.record({
        kind: 'image',
        what,
        model: REPLICATE_BIREFNET.model,
        // No metrics (shouldn't happen once it succeeded): count the reserved estimate, not zero.
        costUsd:
          typeof seconds === 'number'
            ? Number((seconds * REPLICATE_BIREFNET.usdPerSecond).toFixed(6))
            : REPLICATE_BIREFNET.estimateUsd,
        ...(options.tag ? { tag: options.tag } : {}),
      });

      const rgba = await decode(bytes);
      const cut = await loadImage(Buffer.from(run.output));
      // The model returns an RGBA PNG at the input size; scale it if it ever doesn't.
      const canvas = createCanvas(rgba.width, rgba.height);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cut, 0, 0, rgba.width, rgba.height);
      const px = ctx.getImageData(0, 0, rgba.width, rgba.height).data;
      const alpha = new Uint8ClampedArray(rgba.width * rgba.height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3]!;
      return applyMaskAndTrim(rgba, alpha);
    },
  };
}

/** Per-channel median of an image's border pixels: the backdrop color of a studio shot. */
export function borderMedian(rgba: {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}): [number, number, number] {
  const { width, height, data } = rgba;
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
  return border.map((values) => values.sort((a, b) => a - b)[values.length >> 1]!) as [
    number,
    number,
    number,
  ];
}

/** The backdrop color of an encoded studio shot (border median). */
export async function estimateBackdrop(bytes: Uint8Array): Promise<[number, number, number]> {
  return borderMedian(await decode(bytes));
}

/** Measures an encoded cutout PNG against the backdrop it was cut from. */
export async function assessCutout(
  png: Uint8Array,
  backdrop?: [number, number, number],
): Promise<CutoutVerdict> {
  return judgeCutout(measureCutout(await decode(png), backdrop));
}

const SEVERITY_RANK = { ok: 0, warning: 1, error: 2 } as const;

/** Lower is better: severity first, then how far past their limits the problems are. */
export function cutoutBadness(v: CutoutVerdict): number {
  return (
    SEVERITY_RANK[v.severity] * 1000 +
    v.problems.reduce((s, p) => s + (p.severity === 'error' ? 10 : 1) * (p.measured / p.limit), 0)
  );
}

export interface QualityCutout {
  cut: Cutout;
  verdict: CutoutVerdict;
  /** Re-cuts tried after the first cut failed, with their verdicts (empty when it passed). */
  recuts: { remover: string; severity: CutoutVerdict['severity'] }[];
  /** Which re-cut was kept, when one beat the first cut. */
  kept?: string;
}

/**
 * Cuts out a subject and checks the cut (cutout-quality). If it's damaged, re-cuts it with the
 * alternatives (no API cost, a second or two each) and keeps whichever measures best. With the
 * keyer that means a tighter and a looser tolerance: tighter bites less out of light subjects,
 * looser removes more leftover backdrop.
 */
export async function cutOutWithQualityCheck(
  remover: BackgroundRemover,
  bytes: Uint8Array,
  alternatives: BackgroundRemover[] = [
    createBackdropKeyRemover({ tolerance: 18 }),
    createBackdropKeyRemover({ tolerance: 45 }),
  ],
): Promise<QualityCutout> {
  const backdrop = await estimateBackdrop(bytes);
  const cut = await remover.remove(bytes);
  const verdict = await assessCutout(cut.png, backdrop);
  if (verdict.severity !== 'error') return { cut, verdict, recuts: [] };
  let best = { cut, verdict, name: '' };
  const recuts: QualityCutout['recuts'] = [];
  for (const alt of alternatives) {
    try {
      const c = await alt.remove(bytes);
      const v = await assessCutout(c.png, backdrop);
      const name = `${alt.id}:${alt.model}`;
      recuts.push({ remover: name, severity: v.severity });
      if (cutoutBadness(v) < cutoutBadness(best.verdict)) {
        best = {
          cut: { ...c, remover: { id: alt.id, model: alt.model, license: alt.license } },
          verdict: v,
          name,
        };
      }
    } catch {
      // An alternative that can't cut this image is simply not a candidate.
    }
  }
  return {
    cut: best.cut,
    verdict: best.verdict,
    recuts,
    ...(best.name ? { kept: best.name } : {}),
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
    model:
      tolerance === 30 ? 'backdrop-flood-key-v1' : `backdrop-flood-key-v1 (tolerance ${tolerance})`,
    license: 'Part of Redline (MIT)',
    async remove(bytes) {
      const rgba = await decode(bytes);
      const { width, height, data } = rgba;
      const backdrop = borderMedian(rgba);
      const distance = (i: number) =>
        Math.hypot(
          data[i * 4]! - backdrop[0]!,
          data[i * 4 + 1]! - backdrop[1]!,
          data[i * 4 + 2]! - backdrop[2]!,
        );

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
 * Local BiRefNet when it can be loaded (onnxruntime-node installed, model downloadable) and the
 * machine has memory to spare. Otherwise the hosted remover when one is given (BiRefNet on
 * Replicate), and the backdrop keyer as the last resort. `forceHosted` skips the local model.
 * Each cutout says which one made it (`remover`, `fallbackReason`); `lastUsed()` is kept for
 * single-generation callers.
 */
export function createAutoRemover(
  options: {
    onProgress?: (message: string) => void;
    /** Called when a cutout didn't come from the first choice: why, and which remover made it. */
    onFallback?: (reason: string, used: BackgroundRemover) => void;
    /** Below this much free memory a cutout skips local BiRefNet (or REDLINE_CUTOUT_MIN_FREE_MB). */
    minFreeBytes?: number;
    /** Used instead of the keyer when local BiRefNet can't run (always, with forceHosted). */
    hosted?: BackgroundRemover;
    forceHosted?: boolean;
    /** Injected in tests. */
    primary?: BackgroundRemover;
    freeMemory?: () => number;
  } = {},
): BackgroundRemover & { lastUsed(): BackgroundRemover | undefined } {
  const { hosted, forceHosted = false } = options;
  if (forceHosted && !hosted) throw new Error('forceHosted needs a hosted remover');
  const primary = forceHosted
    ? undefined
    : (options.primary ?? createBiRefNetRemover({ onProgress: options.onProgress }));
  const fallback = createBackdropKeyRemover();
  const envMin = Number(process.env.REDLINE_CUTOUT_MIN_FREE_MB);
  const minFree =
    options.minFreeBytes ?? (envMin > 0 ? envMin * 1024 ** 2 : DEFAULT_MIN_FREE_BYTES);
  const freeMemory = options.freeMemory ?? freemem;
  const info = (r: BackgroundRemover) => ({ id: r.id, model: r.model, license: r.license });
  const first = (primary ?? hosted)!;
  const fallbacks = [...(primary && hosted ? [hosted] : []), fallback].map((r) => r.model);
  let broken: string | undefined;
  let last: BackgroundRemover | undefined;
  return {
    id: 'auto',
    model: `${first.model} (fallback ${fallbacks.join(', then ')})`,
    license: first.license,
    lastUsed: () => last,
    async remove(bytes) {
      let reason: string | undefined;
      if (primary) {
        reason = broken;
        if (!reason) {
          const free = freeMemory();
          if (free < minFree) {
            // Not sticky: memory may be back for the next cutout.
            reason = `only ${Math.round(free / 1024 ** 2)} MB of memory free (BiRefNet needs ~6 GB at its peak)`;
          } else {
            try {
              const result = await primary.remove(bytes);
              last = primary;
              return { ...result, remover: info(primary) };
            } catch (err) {
              broken = reason = err instanceof Error ? err.message : String(err);
            }
          }
        }
      }
      if (hosted) {
        try {
          const result = await hosted.remove(bytes);
          last = hosted;
          if (reason) options.onFallback?.(reason, hosted);
          return {
            ...result,
            remover: info(hosted),
            ...(reason ? { fallbackReason: reason } : {}),
          };
        } catch (err) {
          // Not sticky either: a timeout or the spend cap may only hit this one cutout.
          const message = `hosted cutout failed: ${err instanceof Error ? err.message : String(err)}`;
          reason = reason ? `${reason}; ${message}` : message;
        }
      }
      last = fallback;
      options.onFallback?.(reason!, fallback);
      return { ...(await fallback.remove(bytes)), remover: info(fallback), fallbackReason: reason };
    },
  };
}
