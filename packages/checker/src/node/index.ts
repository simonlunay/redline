// Node-only entry point: @simonlunay/redline/node
// File loading, real-font text measurement, image pixel sampling and PNG rendering.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Image } from '@napi-rs/canvas';
import { checkAsync } from '../core/check.js';
import type { CheckOptions } from '../core/check.js';
import { ConfigSchema } from '../core/config.js';
import type { RedlineConfig } from '../core/config.js';
import { parseDesign } from '../core/schema.js';
import type { Design } from '../core/schema.js';
import type { TextMeasurer } from '../core/text-measure.js';
import type { ImageSampler, RasterImage, Report } from '../core/types.js';
import { createFontMeasurer } from './font-measurer.js';
import { createImageSampler, loadDesignImages } from './image-sampler.js';
import { renderRaster } from './render.js';
import { createOnnxSaliencyModel } from './saliency/onnx-model.js';
import type { OnnxSaliencyOptions } from './saliency/onnx-model.js';
import type { SaliencyModel } from '../core/attention/saliency.js';
import { attentionRules, builtinRules, imageRules } from '../core/rules/index.js';
import { createImageAnalyzer } from './image-analysis/index.js';
import type { ImageAnalyzer } from './image-analysis/index.js';

export interface LoadedDesign {
  design: Design;
  /** Directory that relative image paths are resolved against. */
  baseDir: string;
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
}

/** Reads and validates a design file. */
export async function loadDesign(path: string): Promise<LoadedDesign> {
  const abs = resolve(path);
  return { design: parseDesign(await readJson(abs)), baseDir: dirname(abs) };
}

export async function loadConfig(path: string): Promise<RedlineConfig> {
  return ConfigSchema.parse(await readJson(resolve(path)));
}

export interface NodeEnv {
  measurer: TextMeasurer;
  sampler: ImageSampler;
  images: Map<string, Image>;
  /**
   * Renders any design that uses the same images (e.g. edited versions of it) to pixels.
   * Pass it to checkAsync({ render }) for rules that need a rendered image.
   */
  render: (design: Design) => Promise<RasterImage>;
  /** Saliency model for the attention rules (only when created with { attention: true }). */
  saliency?: SaliencyModel;
  /**
   * Per-image analysis for the image rules (only when created with { imageChecks: true }).
   * Every image of the design was analyzed as a user image.
   */
  imageAnalysis?: ImageAnalyzer;
  /** Non-fatal problems such as images that could not be loaded. */
  warnings: string[];
}

let sharedModel: Promise<SaliencyModel> | undefined;

/**
 * The MSI-Net saliency model, loaded once per process (ONNX sessions are expensive to create).
 * Downloads and verifies the pinned weights on first use.
 */
export function getAttentionModel(options: OnnxSaliencyOptions = {}): Promise<SaliencyModel> {
  sharedModel ??= createOnnxSaliencyModel(options).catch((err: unknown) => {
    sharedModel = undefined;
    throw err;
  });
  return sharedModel;
}

/** Loads images and fonts for a design so checks and renders are precise. */
export async function createNodeEnv(
  loaded: LoadedDesign,
  options: {
    attention?: boolean;
    saliency?: SaliencyModel;
    /** Analyze every image (text in images, cutout quality) for the image rules. */
    imageChecks?: boolean | ImageAnalyzer;
  } = {},
): Promise<NodeEnv> {
  const { images, errors } = await loadDesignImages(loaded.design, loaded.baseDir);
  const saliency = options.saliency ?? (options.attention ? await getAttentionModel() : undefined);
  const imageAnalysis =
    typeof options.imageChecks === 'object'
      ? options.imageChecks
      : options.imageChecks
        ? createImageAnalyzer()
        : undefined;
  await imageAnalysis?.analyzeDesign(loaded.design, images);
  return {
    measurer: createFontMeasurer(),
    sampler: createImageSampler(images),
    images,
    render: async (design) => renderRaster(design, { images }),
    ...(saliency ? { saliency } : {}),
    ...(imageAnalysis ? { imageAnalysis } : {}),
    warnings: [
      ...[...errors].map(([src, msg]) => `Could not load image "${src}": ${msg}`),
      ...(imageAnalysis?.warnings ?? []),
    ],
  };
}

/** Convenience: load a design file, set up the Node environment and check it. */
export async function checkFile(
  path: string,
  options: Omit<CheckOptions, 'measurer' | 'sampler'> & {
    attention?: boolean;
    imageChecks?: boolean;
  } = {},
): Promise<{ report: Report; loaded: LoadedDesign; env: NodeEnv }> {
  const { attention, imageChecks, ...checkOptions } = options;
  const loaded = await loadDesign(path);
  const env = await createNodeEnv(loaded, { attention, imageChecks });
  const report = await checkAsync(loaded.design, {
    ...checkOptions,
    rules:
      checkOptions.rules ??
      (attention || imageChecks
        ? [
            ...builtinRules,
            ...(attention ? attentionRules : []),
            ...(imageChecks ? imageRules : []),
          ]
        : undefined),
    ...(env.imageAnalysis ? { images: env.imageAnalysis } : {}),
    measurer: env.measurer,
    sampler: env.sampler,
    render: env.render,
    saliency: env.saliency,
  });
  return { report, loaded, env };
}

export { createFontMeasurer } from './font-measurer.js';
export { registerFont } from './fonts.js';
export { createImageSampler, loadDesignImages } from './image-sampler.js';
export { renderAnnotatedPng, renderPng, renderRaster } from './render.js';
export { heatColor, renderHeatmapPng } from './heatmap.js';
export type { HeatmapOptions } from './heatmap.js';
export { MSI_NET, createOnnxSaliencyModel, msiNetInputShape } from './saliency/onnx-model.js';
export type { OnnxSaliencyOptions } from './saliency/onnx-model.js';
export {
  ModelChecksumError,
  cacheDir,
  ensureModelFile,
  sha256File,
} from './saliency/model-file.js';
export type { EnsureOptions, PinnedModelFile } from './saliency/model-file.js';
export { formatFix, formatPretty } from './report-format.js';
export { createImageAnalyzer, getTextDetector } from './image-analysis/index.js';
export type { ImageAnalyzer } from './image-analysis/index.js';
export {
  DB_DEFAULTS,
  PP_OCR_DET,
  PP_OCR_REC,
  createOnnxTextDetector,
  ctcRead,
  dbBoxes,
} from './image-analysis/text-detector.js';
export type {
  DbOptions,
  TextDetector,
  TextDetectorOptions,
} from './image-analysis/text-detector.js';
export * from '../core/index.js';
