"""
Reproduces the MSI-Net ONNX file that `redline` downloads for the attention check.

  python -m venv venv  (use a SHORT path on Windows: TensorFlow exceeds MAX_PATH otherwise)
  venv/Scripts/pip install tensorflow==2.15.1 tf2onnx==1.16.1 huggingface_hub "numpy<2" onnxruntime onnxconverter-common
  venv/Scripts/python convert-msi-net.py <out-dir>

Source: https://huggingface.co/alexanderkroner/MSI-Net (MIT license), pinned to the commit
below. The script converts the TF SavedModel to ONNX, then checks the ONNX output against
TensorFlow on the model card's example image (and on random input) before printing the
size and SHA-256 that are pinned in src/node/saliency/onnx-model.ts.
"""

import hashlib
import os
import subprocess
import sys

import numpy as np
import onnx
import onnxruntime as ort
import tensorflow as tf
from huggingface_hub import snapshot_download
from onnxconverter_common import float16

REPO = "alexanderkroner/MSI-Net"
REVISION = "d950b35945db961ae63f84bc2b23f6bd578d0b8f"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def letterbox(image, target):
    """Same preprocessing as the model card: keep aspect, zero-pad, raw 0-255 floats."""
    t = tf.image.resize(tf.expand_dims(image, 0), target, preserve_aspect_ratio=True)
    v, h = target[0] - t.shape[1], target[1] - t.shape[2]
    t = tf.pad(t, [[0, 0], [v // 2, v - v // 2], [h // 2, h - h // 2], [0, 0]])
    return t.numpy().astype(np.float32)


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    src = snapshot_download(REPO, revision=REVISION, local_dir=os.path.join(out_dir, "hf"))
    model = tf.saved_model.load(src)
    signature = model.signatures["serving_default"]
    print("inputs:", signature.structured_input_signature)
    print("outputs:", signature.structured_outputs)

    fp32 = os.path.join(out_dir, "msi-net-salicon-d950b35.fp32.onnx")
    subprocess.run(
        [sys.executable, "-m", "tf2onnx.convert", "--saved-model", src, "--signature_def",
         "serving_default", "--opset", "17", "--output", fp32],
        check=True,
    )
    fp16 = os.path.join(out_dir, "msi-net-salicon-d950b35.onnx")
    onnx.save(float16.convert_float_to_float16(onnx.load(fp32), keep_io_types=True), fp16)

    example = tf.io.decode_image(tf.io.read_file(os.path.join(src, "example.jpg")), channels=3)
    inputs = {
        "example": letterbox(tf.cast(example, tf.float32), (240, 320)),
        "random-square": np.random.default_rng(0).uniform(0, 255, (1, 320, 320, 3)).astype(np.float32),
    }
    out_key = list(signature.structured_outputs.keys())[0]
    in_key = list(signature.structured_input_signature[1].keys())[0]
    for name, x in inputs.items():
        expected = signature(**{in_key: tf.constant(x)})[out_key].numpy()
        for path in (fp32, fp16):
            sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
            got = sess.run(None, {sess.get_inputs()[0].name: x})[0]
            diff = float(np.max(np.abs(got - expected)))
            corr = float(np.corrcoef(got.ravel(), expected.ravel())[0, 1])
            print(f"{name:14s} {os.path.basename(path):40s} shape={got.shape} max|diff|={diff:.5f} corr={corr:.6f}")

    for path in (fp32, fp16):
        print(f"{os.path.basename(path)}  bytes={os.path.getsize(path)}  sha256={sha256(path)}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "msi-net-out")
