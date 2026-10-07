import { ImageData, createCanvas } from '@napi-rs/canvas';
import type * as OrtModule from 'onnxruntime-node';
import { cachedSaliencyModel, normalizeSaliency } from '../../core/attention/saliency.js';
import type { SaliencyModel } from '../../core/attention/saliency.js';
import type { RasterImage } from '../../core/types.js';
import { ensureModelFile } from './model-file.js';
import type { EnsureOptions, PinnedModelFile } from './model-file.js';

/**
 * MSI-Net (Kroner et al. 2020, MIT license) trained on SALICON, converted from the TF
 * SavedModel at huggingface.co/alexanderkroner/MSI-Net@d950b35 to ONNX with tf2onnx
 * (see scripts/convert-msi-net.md). Hosted as a GitHub release asset; pinned by size and hash.
 */
export const MSI_NET: PinnedModelFile & { id: string } = {
  id: 'msi-net-salicon@d950b35',
  fileName: 'msi-net-salicon-d950b35.onnx',
  url: 'https://github.com/simonlunay/redline/releases/download/saliency-msi-net-v1/msi-net-salicon-d950b35.onnx',
  bytes: 50041285,
  sha256: '9a6d3605dff7846ecc8e180031787d8152d5269773db869aa11c21eb0b59cb0f',
};

/** MSI-Net was trained on these input sizes (height x width); pick the closest aspect ratio. */
export function msiNetInputShape(width: number, height: number): [number, number] {
  const aspect = height / width;
  const options: [number, number][] = [
    [320, 320],
    [240, 320],
    [320, 240],
  ];
  return options.reduce((best, s) =>
    Math.abs(aspect - s[0] / s[1]) < Math.abs(aspect - best[0] / best[1]) ? s : best,
  );
}

interface Letterbox {
  tensor: Float32Array;
  inputHeight: number;
  inputWidth: number;
  /** Placement of the scaled image inside the padded input. */
  top: number;
  left: number;
  height: number;
  width: number;
}

/** Resizes (keeping aspect) and zero-pads the render into an NHWC float tensor of 0-255 values. */
function letterbox(image: RasterImage): Letterbox {
  const [inputHeight, inputWidth] = msiNetInputShape(image.width, image.height);
  const scale = Math.min(inputWidth / image.width, inputHeight / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const top = Math.floor((inputHeight - height) / 2);
  const left = Math.floor((inputWidth - width) / 2);

  const source = createCanvas(image.width, image.height);
  source.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  const target = createCanvas(inputWidth, inputHeight);
  const ctx = target.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, inputWidth, inputHeight);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, left, top, width, height);
  const rgba = ctx.getImageData(0, 0, inputWidth, inputHeight).data;

  const tensor = new Float32Array(inputWidth * inputHeight * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    tensor[j] = rgba[i]!;
    tensor[j + 1] = rgba[i + 1]!;
    tensor[j + 2] = rgba[i + 2]!;
  }
  return { tensor, inputHeight, inputWidth, top, left, height, width };
}

type Ort = typeof OrtModule;

async function loadOrt(): Promise<Ort> {
  try {
    return await import('onnxruntime-node');
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('The attention check needs onnxruntime-node: npm install onnxruntime-node', {
        cause: err,
      });
    }
    throw err;
  }
}

export interface OnnxSaliencyOptions extends EnsureOptions {
  /** Use a local .onnx file instead of the pinned download (also: REDLINE_SALIENCY_MODEL). */
  modelPath?: string;
}

/**
 * Loads MSI-Net with onnxruntime-node. The session is created once; predictions are cached by
 * render pixels. Output: the model's 0-1 map with the letterbox padding cropped off, normalized
 * to sum to 1, at the model's resolution (e.g. 320x240 for a landscape design).
 */
export async function createOnnxSaliencyModel(
  options: OnnxSaliencyOptions = {},
): Promise<SaliencyModel> {
  const ort = await loadOrt();
  const path =
    options.modelPath ??
    process.env.REDLINE_SALIENCY_MODEL ??
    (await ensureModelFile(MSI_NET, options));
  const session = await ort.InferenceSession.create(path, { graphOptimizationLevel: 'all' });
  const inputName = session.inputNames[0]!;
  const outputName = session.outputNames[0]!;

  return cachedSaliencyModel({
    id: options.modelPath ? `onnx:${options.modelPath}` : MSI_NET.id,
    async predict(image) {
      const box = letterbox(image);
      const input = new ort.Tensor('float32', box.tensor, [1, box.inputHeight, box.inputWidth, 3]);
      const result = await session.run({ [inputName]: input });
      const out = result[outputName]!.data as Float32Array;
      // Output is [1, H, W, 1]; crop the padding back off.
      const data = new Float32Array(box.width * box.height);
      for (let row = 0; row < box.height; row++) {
        for (let col = 0; col < box.width; col++) {
          data[row * box.width + col] = out[(row + box.top) * box.inputWidth + col + box.left]!;
        }
      }
      return normalizeSaliency({ width: box.width, height: box.height, data });
    },
  });
}
