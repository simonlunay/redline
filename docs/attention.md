# Attention check

The layout rules check that a design is _correct_. The attention check asks whether people will _notice_ the parts that matter. A visual saliency model predicts where viewers will look on the rendered design. Redline turns that prediction into per-element attention shares, and flags ads whose CTA, headline or product get too little of it.

```bash
npx redline setup attention                                   # once: downloads + verifies the model
npx redline check ad.json --attention --heatmap heatmap.png   # rules + overlay
npx redline fix ad.json --attention --render-steps steps/     # heatmap per iteration too
```

It's **one optional set of rules** (`attentionRules`), not part of the default check:

- It needs a render and an ML model, so it runs only through `checkAsync()`. The browser-friendly `check()` is unchanged.
- It needs `onnxruntime-node`, an optional peer dependency (`npm install onnxruntime-node`).

## How it works

1. **Render and predict.** The design is rendered and fed to MSI-Net (below), which returns a heatmap that sums to 1.
   - Preprocessing is exactly the model card's: keep aspect ratio, zero-pad to 320×320, 240×320 or 320×240, and crop the padding back off.
   - It takes about 0.2 to 0.3 s per design on a laptop CPU.
   - Predictions are cached by a hash of the render's pixels, so the fix loop and eval never predict the same design twice.
2. **Attribute attention to elements.** Each heatmap cell goes to the **top-most visible element** at that point, in paint order, exactly like the renderer:
   - A button label beats its button, and a headline beats the photo behind it.
   - Uncovered canvas and `background`-role elements count as background, which is also split into a 4×4 grid of named regions to find hot spots.
   - Role shares sum their elements, so a CTA's button and label count together.
3. **Predict the viewing order** by each key role's **peak** attention. This is the classic winner-take-all proxy for where the first fixation lands. A sum would just favour big elements.
4. **Report.** `report.rules[i].elementScores` holds the share per element, and `details` holds role shares, viewing order and background share.

## Rules

| Rule                     | Flags                                                                                                                                                    | Fix suggestions                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `attention-key-elements` | CTA, headline or product (when present) below its minimum share. Error below half the minimum.                                                           | Grow the element(s) around their centre by `√(min/share)` (1.1 to 1.4×), and raise contrast/size |
| `attention-competition`  | A `decoration`, or a background region, that gets more attention than the headline or CTA (minimum 5% share). Backing panels behind content don't count. | `setOpacity` + shrink the decoration, or an `insertShape` scrim (35% black) over the busy region |

Example message: _"CTA gets 1.1% of predicted attention; minimum is 5%. Make it larger, higher-contrast or more isolated (predicted viewing order: headline → product → cta)."_

## Calibration

The minimums aren't guesses. `npm run calibrate-attention -w packages/agent` runs the model over all fixtures plus the 84 LLM-fixed designs from the normal-mode [fix-loop eval](evaluation.md#fix-loop-normal-mode). The 86 designs with **no layout errors** form the reference set. Each minimum is the **10th percentile** of that role's share, rounded down:

| Role     | n   | min  | p10   | p20   | median | max   | **Minimum** |
| -------- | --- | ---- | ----- | ----- | ------ | ----- | ----------- |
| headline | 86  | 7.5% | 19.5% | 21.3% | 25.8%  | 53.0% | **19%**     |
| CTA      | 86  | 4.6% | 5.4%  | 9.1%  | 10.1%  | 22.9% | **5%**      |
| product  | 74  | 4.7% | 13.7% | 15.1% | 16.7%  | 23.4% | **13%**     |

**Tradeoff:**

- At the 10th percentile, **17 of 86** layout-clean designs get at least one attention flag.
- At the 20th percentile (21% / 9% / 15%), **34 of 86** would.
- The union over three roles flags more than 10% of designs, because a design fails if any one role is low.

These numbers calibrate against "designs that pass the layout rules", not against human ratings. The reference set also contains several fixed versions of each fixture, so the samples aren't independent. Raw data is in [`packages/agent/eval/results/attention-calibration.json`](../packages/agent/eval/results/attention-calibration.json), and the thresholds are configurable:

```json
{ "rules": { "attention-key-elements": { "options": { "minShare": { "cta": 0.08 } } } } }
```

## In the fix loop

- Attention issues are just more issues for the loop.
- The model also receives the heatmap overlay as a second image.
- The prompt explains what a share means and the good fixes: grow the CTA or give it contrast and space, fade or shrink a competing decoration (`setOpacity`), or add a scrim over a busy area.
- `--render-steps` writes `NN-status.heatmap.png` for every iteration, so you can watch attention move. For example, on `hard-story-hero` the CTA went from 1.1% to 7.9% of predicted attention in two iterations, and the predicted viewing order changed from headline → product → CTA to headline → CTA → product.

## Model and license

- **Model:** [MSI-Net](https://github.com/alexanderkroner/saliency) (Kroner et al., _Neural Networks_ 2020), the SALICON-trained weights from [Hugging Face](https://huggingface.co/alexanderkroner/MSI-Net) at commit `d950b35`. MIT License, © 2019 Alexander Kroner.
- **Conversion:** converted to ONNX with float16 weights by `packages/checker/scripts/convert-msi-net.py`. The output matches TensorFlow within 0.0007 on a 0 to 1 scale, with correlation 1.000000.
- **Hosting:** the 50 MB file is hosted as a [GitHub release asset](https://github.com/simonlunay/redline/releases/tag/saliency-msi-net-v1), **never in git**.
- **Pinned and verified:** the code pins the URL, size (50,041,285 bytes) and SHA-256 (`9a6d3605…59cb0f`). The model downloads on first use to `%LOCALAPPDATA%\redline` or `~/.cache/redline` (override with `REDLINE_CACHE_DIR`, or use a local file with `REDLINE_SALIENCY_MODEL`). It's written to a temp file and only renamed into place after verification.
- **Why MSI-Net:** it was compared with UNISAL and UMSI. UMSI is trained on graphic designs but is licensed for non-commercial research only. UNISAL is much smaller, but its weights were partly trained on movie clips and YouTube videos. MSI-Net had the cleanest license.
- **Training-data caveats** (see [NOTICE](../NOTICE); get a legal review before any commercial use):
  - SALICON's annotation license couldn't be confirmed on its official site; secondary sources say CC BY 4.0.
  - Its images are MS COCO / Flickr photos under mixed per-image licenses.
  - The encoder started from ImageNet-pretrained VGG16, and ImageNet's image terms are research-only.

## Limits

- **It's a prediction, not eye tracking.** MSI-Net was trained on mouse-tracking "attention" over _natural photos_, not on graphic designs or real ad viewing.
- **It's strongly drawn to text.** Large flat shapes, like a bright red burst, attract less predicted attention than a person might give them. It does respond to faces, contrast and isolation.
- **Thin banners get squeezed.** Extreme aspect ratios (728×90, 300×1050) are letterboxed into the model's input, so they're predicted at low resolution.
- **The thresholds come from 86 designs**, calibrated against the layout rules, not against conversion data.
