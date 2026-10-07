# Redline

**ESLint for designs, plus an AI that fixes what it finds.** Give Redline a poster, social post or ad as JSON, and it returns a 0–100 score plus a list of problems tied to specific elements. Each problem comes with a **machine-readable fix**. `redline fix` then hands the design to Claude, applies its edits, re-checks, and repeats until the design is good.

```
$ npx @simonlunay/redline check fixtures/worst.json

 redline  fixtures/worst.json 1080x1080

  Score 6/100   11 errors · 3 warnings · 0 info

  text-contrast       ███░░░░░░░  25  5 issues
  off-canvas          █████████░  94  1 issue
  min-text-size       ████████░░  84  1 issue
  image-aspect-ratio  ████████░░  84  1 issue
  safe-margins        ██████████  97  1 issue
  hierarchy           ████████░░  84  1 issue
  unintended-overlap  ████████░░  76  1 issue
  text-overflow       ██████░░░░  58  2 issues
  alignment           ██████████  97  1 issue

  Errors (11)
  ✖ 1. headline "headline" has a contrast of 1.24:1 against what is behind it; large text needs 3:1. [text-contrast]
       measured 1.24:1 · threshold 3:1
       fix: set headline color to #000000
  ...
```

`--annotate` draws the same issues onto the rendered design, numbered to match the report.

## Why

AI tools are good at producing designs and bad at noticing their own mistakes: white text on a pale photo, a headline sliding under the product shot, a stretched logo, a button label that doesn't fit. Redline is the missing feedback signal. It checks a design against concrete, explainable design rules and describes each problem precisely enough for a program to repair it.

It's part of a larger project: an AI design assistant that generates a design, checks it with Redline, repairs it in a self-critiquing loop, and resizes it across formats (see [Roadmap](#roadmap)). Two packages live here:

- **`@simonlunay/redline`**: the checker (library + `redline` CLI). It has no LLM dependency.
- **`@simonlunay/redline-agent`**: the AI fix loop. It's an optional add-on that enables `redline fix`.

## Install

```bash
npm install @simonlunay/redline           # checker library + CLI
npm install @simonlunay/redline-agent     # optional: the AI fix loop (redline fix)
# generation (redline generate) lives in packages/generate in this repo; not published yet
npx @simonlunay/redline check design.json
```

Node 20+. Rendering uses [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (Skia with prebuilt binaries), so nothing gets compiled on install on Windows, macOS or Linux.

## CLI

```bash
redline check <design.json> [options]
redline fix <design.json> [options]    # AI fix loop, see below
redline rules                          # list rules, defaults and weights
redline setup attention                # download the saliency model (50 MB, once)
redline generate "<prompt>" [options]  # prompt to design, see Generation below
```

| Option                  | Description                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `--format pretty\|json` | Coloured report (default) or JSON for tools and CI                                  |
| `--config <path>`       | JSON config file (see [Configuration](#configuration))                              |
| `--render <out.png>`    | Render the design to PNG                                                            |
| `--annotate <out.png>`  | Render with numbered issue boxes and the score drawn on top                         |
| `--attention`           | Also run the [attention check](#attention-check) (needs `onnxruntime-node`)         |
| `--heatmap <out.png>`   | Write a predicted-attention overlay with per-element shares (implies `--attention`) |

**Exit codes:** `0` means no errors, `1` means errors were found (so it can gate CI), and `2` means invalid input or usage.

Image `src` paths are resolved relative to the design file.

### `redline fix`

```
$ redline fix fixtures/worst.json --out fixed.json --render-steps steps/

 redline fix  fixtures/worst.json  target 90 · max 4 · claude-sonnet-5-5 (medium)

  #0  start          6  █░░░░░░░░░       11 errors · 3 warnings
  #1  accepted      94  █████████░  +88  0 errors · 2 warnings
        Reflow the layout: headline on top, subheading below it, product at its natural ratio, ...
        • move headline by (+0, -130) — move the headline above the product
        • set headline color to #0f172a — contrast on the sky
        … 19 more

  ✔ 6 → 94 in 1 iteration · errors 11 → 0 · stop: target reached
    1 LLM call · 8.9k in (0 cached) / 1.6k out tokens · ≈ $0.036 · 20.2s
```

| Option                 | Description                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `--out <path>`         | Where to write the best design (default `<name>.fixed.json`)                                  |
| `--target <score>`     | Done when the score reaches this **and** no errors remain (default 90)                        |
| `--max-iterations <n>` | Max repair iterations (default 4)                                                             |
| `--model <id>`         | Claude model (default `claude-sonnet-5-5`)                                                    |
| `--effort <level>`     | `low` `medium` `high` `xhigh` `max` (default `medium`)                                        |
| `--editor <name>`      | `anthropic` (default) or `suggested`: applies the checker's own fixes, offline, no key needed |
| `--render-steps <dir>` | Annotated PNG per iteration (`00-initial.png`, `01-accepted.png`, …, `final.png`)             |
| `--no-vision`          | Don't send the annotated render to the model                                                  |
| `--config`, `--format` | Same as `check`                                                                               |

It needs `ANTHROPIC_API_KEY`, read from the environment or from `./.env` (copy `.env.example`). The exit code is `0` if the final design has no errors.

## Library

The main entry point is **isomorphic**: it has no Node APIs and its only dependency is `zod`, so it runs in the browser too.

```ts
import { check } from '@simonlunay/redline';

const report = check(designJson, {
  config: { rules: { alignment: 'off' } },
});
report.score; // 0-100
report.issues; // [{ ruleId, severity, elementIds, message, measured, threshold, unit, fix }]
```

`check()` is **synchronous and pure**. Anything that needs I/O, such as decoded image pixels or real font metrics, is injected through two small interfaces:

```ts
interface TextMeasurer {
  measure(text: string, font: { family: string; size: number; weight: number }): number;
}
interface ImageSampler {
  has(src: string): boolean;
  sample(src: string, u: number, v: number): { r; g; b; a } | null; // u, v in 0..1
}
```

The Node entry point provides precise implementations of both, plus file loading and rendering:

```ts
import { checkFile, renderAnnotatedPng } from '@simonlunay/redline/node';

const { report, loaded, env } = await checkFile('poster.json');
const png = renderAnnotatedPng(loaded.design, report, { images: env.images });
```

| Export (`/node`)                   | What it does                                                  |
| ---------------------------------- | ------------------------------------------------------------- |
| `checkFile(path, options?)`        | Load, set up fonts and images, and check                      |
| `loadDesign(path)` / `loadConfig`  | Read and validate JSON files                                  |
| `createNodeEnv(loaded)`            | `{ measurer, sampler, images, warnings }` for a design        |
| `createFontMeasurer()`             | Real font metrics via Skia (bundled Inter, or `registerFont`) |
| `renderPng` / `renderAnnotatedPng` | PNG preview / preview with issues drawn on top                |
| `formatPretty(report)`             | The CLI's terminal report as a string                         |

## Design format (v0.1)

A design is JSON validated by a Zod schema (`DesignSchema`). The TypeScript types are inferred from that schema, so the validation and the types can't drift apart.

```jsonc
{
  "version": "0.1",
  "canvas": { "width": 1080, "height": 1350, "background": "#0f172a" },
  "elements": [
    {
      "id": "headline",
      "type": "text",
      "role": "headline",
      "x": 90,
      "y": 180,
      "width": 900,
      "height": 110,
      "content": "Morning Roast",
      "fontFamily": "Inter",
      "fontSize": 96,
      "fontWeight": 900,
      "color": "#ffffff",
      "lineHeight": 1.1,
      "align": "center",
      "zIndex": 2,
    },
    {
      "id": "product",
      "type": "image",
      "role": "product",
      "x": 340,
      "y": 530,
      "width": 400,
      "height": 400,
      "src": "images/product.png",
      "naturalWidth": 800,
      "naturalHeight": 800,
      "fit": "fill",
    },
    {
      "id": "cta-button",
      "type": "shape",
      "role": "cta",
      "kind": "rect",
      "x": 390,
      "y": 1130,
      "width": 300,
      "height": 90,
      "fill": "#f97316",
      "cornerRadius": 45,
    },
  ],
}
```

| Field                                                                             | Applies to | Notes                                                                                                     |
| --------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `id`, `type`, `x`, `y`, `width`, `height`                                         | all        | Pixels in canvas space. `id`s must be unique.                                                             |
| `rotation`                                                                        | all        | Degrees clockwise around the centre. Default `0`.                                                         |
| `opacity`                                                                         | all        | `0`–`1`, default `1`.                                                                                     |
| `zIndex`                                                                          | all        | Paint order (ties are broken by array order). Default `0`.                                                |
| `groupId`                                                                         | all        | Elements in the same group may overlap.                                                                   |
| `role`                                                                            | all        | `background` `logo` `headline` `subheading` `body` `cta` `product` `decoration`. Many rules depend on it. |
| `content`, `fontFamily`, `fontSize`, `fontWeight`, `color`, `lineHeight`, `align` | text       | `lineHeight` is a multiplier (like CSS). Text wraps at word boundaries within `width`.                    |
| `src`, `naturalWidth`, `naturalHeight`, `fit`                                     | image      | `fit`: `fill` (stretch, default), `cover` (crop), `contain` (letterbox).                                  |
| `kind`, `fill`, `cornerRadius`                                                    | shape      | `kind`: `rect` or `ellipse`.                                                                              |

Colours are hex: `#rgb`, `#rrggbb` or `#rrggbbaa`.

## Rules

| Rule                 | Checks                                                            | Default thresholds                 |
| -------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| `text-contrast`      | WCAG 2.x contrast between text and **what is actually behind it** | 4.5:1 normal, 3:1 large            |
| `off-canvas`         | Elements partly (warning) or fully (error) outside the canvas     | 1px tolerance                      |
| `min-text-size`      | Text too small for the canvas                                     | 2% of short side (error < 1.4%)    |
| `image-aspect-ratio` | Images stretched compared with their natural aspect ratio         | warn ≥ 2%, error ≥ 10%             |
| `safe-margins`       | Logo, headline, CTA and text too close to the edges               | 5% of short side                   |
| `hierarchy`          | Subheading, body or CTA competing with or beating the headline    | warn at 90% of headline prominence |
| `unintended-overlap` | Text over text or images, and key elements colliding              | error at 15% overlap               |
| `text-overflow`      | Wrapped text taller or wider than its box                         | 2px tolerance                      |
| `alignment`          | Edges or centres that are _almost_ aligned                        | ≤ 0.8% of short side               |

How each rule works, and why:

- **text-contrast** samples points along each _wrapped line_ (where the glyphs actually are, not the empty part of the box). At each point it composites everything painted below the text: the canvas, shapes with their opacity, and image pixels mapped through `fit`. It then takes the **worst** ratio. Font sizes are normalised to a 1080px canvas before the WCAG large-text test (24px, or 18.66px bold), so a 2160px canvas isn't judged by phone-pixel sizes. Logos and decorative text are exempt, as in WCAG. Over an image with no pixel data available, it warns that contrast _couldn't be verified_ and doesn't guess. The fix keeps the colour's hue and only shifts its lightness until the text passes.
- **off-canvas** uses the _rotated_ bounding box, so a tilted card that pokes out is caught. Backgrounds are allowed to bleed. Fix: move it back in, scaling it down first if it's bigger than the canvas.
- **min-text-size** scales with the shorter canvas side, so the same config works for a 1080×1080 post (21.6px minimum) and a 1200×628 banner (12.6px minimum).
- **image-aspect-ratio** only checks `fit: "fill"`, because cover and contain can't distort. Fix: keep the width and correct the height.
- **safe-margins** skips elements that are already off-canvas, so the same element isn't reported twice.
- **hierarchy** measures prominence as `fontSize × √(fontWeight / 400)`: size dominates, and weight helps less than linearly. Fix: shrink the competitor to 70% of the headline's prominence.
- **unintended-overlap** treats these as intentional: backgrounds, decorations, elements with the same `groupId`, and text fully on top of a shape (button labels, badges). Fix: move the element on top by the smallest push that clears the other, with a gap. A label poking out of its button is pulled back inside instead.
- **text-overflow** wraps text greedily with the `TextMeasurer` (the same wrapping the renderer uses). Fix: if a font size within 15% of the original fits, it suggests that. Otherwise it grows the box, because shrinking a headline by 40% to make it fit would just create a hierarchy problem.
- **alignment** compares like edges (left with left, centre with centre, and so on) and the canvas centre lines. To avoid false positives, it ignores pairs that are already exactly aligned on another edge (two centred texts of different widths), container/content pairs (a label inside its button), and elements already anchored by an exact alignment elsewhere.

**Simplification:** overlap, margins and contrast use unrotated boxes. Only off-canvas accounts for rotation, since rotation is rare in these layouts.

### Fixes

Every fix is plain data that a program can apply without understanding the rule that produced it:

```ts
type Fix =
  | { op: 'move'; elementId: string; dx: number; dy: number }
  | { op: 'resize'; elementId: string; width: number; height: number }
  | { op: 'setColor'; elementId: string; color: string }
  | { op: 'setFontSize'; elementId: string; fontSize: number }
  | { op: 'setFontWeight'; elementId: string; fontWeight: number }
  | { op: 'setOpacity'; elementId: string; opacity: number };
```

```ts
  | { op: 'insertShape'; behindElementId: string; kind: 'rect' | 'ellipse';
      x: number; y: number; width: number; height: number;
      fill: string; opacity: number; cornerRadius: number };
```

- **`setColor`** sets the text colour on text and the fill on shapes.
- **`setOpacity`** tones an element down, e.g. a decoration that steals attention.
- **`insertShape`** adds a `decoration` shape painted directly behind an element, with a generated id like `headline-backing`. A translucent dark scrim behind white text on a photo is usually a much better contrast fix than recolouring the text grey.

Each issue has `measured` and `threshold` values (e.g. `1.24` vs `3`, unit `:1`), so an agent can tell _how far off_ the design is, not only that it failed.

**`applyFixes(design, fixes)`** applies fixes in order and returns `{ design, applied, rejected, insertedIds }`:

- It's pure: the input isn't modified.
- The returned design is always schema-valid.
- Bad ops are **rejected, not thrown**: unknown ids, an op on the wrong element type (e.g. `setFontSize` on an image), invalid colours.
- Out-of-range values are **clamped**: sizes to at least 1px, font size to 1–1000, opacity to 0–1.
- No op can change text content, font family or image `src`.

**`designJsonSchema()` / `fixJsonSchema()`** return JSON Schema generated from the Zod schemas, for example to describe the format to an LLM.

## Configuration

ESLint-style. Pass the config as an object to `check()`, or as a JSON file to `--config`:

```json
{
  "rules": {
    "alignment": "off",
    "safe-margins": "error",
    "min-text-size": { "options": { "minPercent": 2.5 } },
    "text-contrast": { "weight": 5, "options": { "normalRatio": 7 } }
  }
}
```

- `"off"` disables a rule.
- `"error" | "warning" | "info"` forces the severity of all of that rule's issues.
- `{ severity?, weight?, options?, enabled? }` gives finer control. Run `redline rules` to see every option and its default.

Unknown rule ids are rejected, so typos don't silently do nothing.

**Custom rules** are plain objects:

```ts
import { builtinRules, check, defineRule } from '@simonlunay/redline';

const maxElements = defineRule({
  id: 'max-elements',
  description: 'Too many elements make a design noisy.',
  defaultSeverity: 'warning',
  weight: 1,
  defaultOptions: { max: 12 },
  check: ({ design }, { max }) =>
    design.elements.length > max
      ? [
          {
            elementIds: [],
            message: `${design.elements.length} elements`,
            measured: design.elements.length,
            threshold: max,
          },
        ]
      : [],
});

check(design, { rules: [...builtinRules, maxElements] });
```

**Async and render-based rules:**

- A rule's `check` may return a Promise.
- It can declare `requires: ['render']` and read pixels with `await ctx.render()`.
- It can return `{ issues, elementScores }` to report per-element numbers (e.g. attention share).
- `check()` stays synchronous and skips such rules, listing them in `report.skipped`. `checkAsync(design, { render })` runs them.
- In Node, `createNodeEnv()` provides `render`, and the CLI always uses `checkAsync`.

This is how the planned attention/saliency rule will plug in.

### Scoring

- Each issue removes `points × rule weight` percent of its rule's score. Points are error 8, warning 3 and info 0.5, so a contrast error (weight 3) removes 24%.
- The **overall score is the product of the rule scores**.
- A weighted average would let eight passing rules hide a real error: a design with a stretched image would still score 97. With a product, every failing rule pulls the total down, the score never goes negative, and issue order doesn't matter.
- `passed` is `false` whenever there's at least one error.

## Attention check

The layout rules check that a design is _correct_. The attention check asks whether people will _notice_ the parts that matter. A visual saliency model predicts where viewers will look on the rendered design. Redline turns that prediction into per-element attention shares, and flags ads whose CTA, headline or product get too little of it.

```bash
npx redline setup attention                                   # once: downloads + verifies the model
npx redline check ad.json --attention --heatmap heatmap.png   # rules + overlay
npx redline fix ad.json --attention --render-steps steps/     # heatmap per iteration too
```

It's **one optional set of rules** (`attentionRules`), not part of the default check:

- It needs a render and an ML model, so it runs only through `checkAsync()`. The browser-friendly `check()` is unchanged.
- It needs `onnxruntime-node`, an optional peer dependency (`npm install onnxruntime-node`).

### How it works

1. **Render and predict.** The design is rendered and fed to MSI-Net (below), which returns a heatmap that sums to 1.
   - Preprocessing is exactly the model card's: keep aspect ratio, zero-pad to 320×320, 240×320 or 320×240, and crop the padding back off.
   - It takes about 0.2–0.3 s per design on a laptop CPU.
   - Predictions are cached by a hash of the render's pixels, so the fix loop and eval never predict the same design twice.
2. **Attribute attention to elements.** Each heatmap cell goes to the **top-most visible element** at that point, in paint order, exactly like the renderer:
   - A button label beats its button, and a headline beats the photo behind it.
   - Uncovered canvas and `background`-role elements count as background, which is also split into a 4×4 grid of named regions to find hot spots.
   - Role shares sum their elements, so a CTA's button and label count together.
3. **Predict the viewing order** by each key role's **peak** attention. This is the classic winner-take-all proxy for where the first fixation lands. A sum would just favour big elements.
4. **Report.** `report.rules[i].elementScores` holds the share per element, and `details` holds role shares, viewing order and background share.

### Rules

| Rule                     | Flags                                                                                                                                                    | Fix suggestions                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `attention-key-elements` | CTA, headline or product (when present) below its minimum share. Error below half the minimum.                                                           | Grow the element(s) around their centre by `√(min/share)` (1.1–1.4×), and raise contrast/size    |
| `attention-competition`  | A `decoration`, or a background region, that gets more attention than the headline or CTA (minimum 5% share). Backing panels behind content don't count. | `setOpacity` + shrink the decoration, or an `insertShape` scrim (35% black) over the busy region |

Example message: _"CTA gets 1.1% of predicted attention; minimum is 5%. Make it larger, higher-contrast or more isolated (predicted viewing order: headline → product → cta)."_

### Attention calibration

The minimums aren't guesses. `npm run calibrate-attention -w packages/agent` runs the model over all fixtures plus the 84 LLM-fixed designs from the phase 2 eval. The 86 designs with **no layout errors** form the reference set. Each minimum is the **10th percentile** of that role's share, rounded down:

| Role     | n   | min  | p10   | p20   | median | max   | **Minimum** |
| -------- | --- | ---- | ----- | ----- | ------ | ----- | ----------- |
| headline | 86  | 7.5% | 19.5% | 21.3% | 25.8%  | 53.0% | **19%**     |
| CTA      | 86  | 4.6% | 5.4%  | 9.1%  | 10.1%  | 22.9% | **5%**      |
| product  | 74  | 4.7% | 13.7% | 15.1% | 16.7%  | 23.4% | **13%**     |

**Tradeoff:**

- At the 10th percentile, **17 of 86** layout-clean designs get at least one attention flag.
- At the 20th percentile (21% / 9% / 15%), **34 of 86** would.
- The union over three roles flags more than 10% of designs, because a design fails if any one role is low.

These numbers calibrate against "designs that pass the layout rules", not against human ratings. The reference set also contains several fixed versions of each fixture, so the samples aren't independent. Raw data is in `packages/agent/eval/results/attention-calibration.json`, and thresholds are configurable:

```json
{ "rules": { "attention-key-elements": { "options": { "minShare": { "cta": 0.08 } } } } }
```

### Model and license

- **Model:** [MSI-Net](https://github.com/alexanderkroner/saliency) (Kroner et al., _Neural Networks_ 2020), the SALICON-trained weights from [Hugging Face](https://huggingface.co/alexanderkroner/MSI-Net) at commit `d950b35`. MIT License, © 2019 Alexander Kroner.
- **Conversion:** converted to ONNX with float16 weights by `packages/checker/scripts/convert-msi-net.py`. The output matches TensorFlow within 0.0007 on a 0–1 scale, with correlation 1.000000.
- **Hosting:** the 50 MB file is hosted as a [GitHub release asset](https://github.com/simonlunay/redline/releases/tag/saliency-msi-net-v1), **never in git**.
- **Pinned and verified:** the code pins the URL, size (50,041,285 bytes) and SHA-256 (`9a6d3605…59cb0f`). The model downloads on first use to `%LOCALAPPDATA%\redline` or `~/.cache/redline` (override with `REDLINE_CACHE_DIR`, or use a local file with `REDLINE_SALIENCY_MODEL`). It's written to a temp file and only renamed into place after verification.
- **Why MSI-Net:** I compared it with UNISAL and UMSI. UMSI is trained on graphic designs but is licensed for non-commercial research only. UNISAL is much smaller, but its weights were partly trained on movie clips and YouTube videos. MSI-Net had the cleanest license.
- **Training-data caveats** (see [NOTICE](NOTICE); get a legal review before any commercial use):
  - SALICON's annotation license couldn't be confirmed on its official site; secondary sources say CC BY 4.0.
  - Its images are MS COCO / Flickr photos under mixed per-image licenses.
  - The encoder started from ImageNet-pretrained VGG16, and ImageNet's image terms are research-only.

### Limits

- **It's a prediction, not eye tracking.** MSI-Net was trained on mouse-tracking "attention" over _natural photos_, not on graphic designs or real ad viewing.
- **It's strongly drawn to text.** Large flat shapes, like a bright red burst, attract less predicted attention than a person might give them. It does respond to faces, contrast and isolation.
- **Thin banners get squeezed.** Extreme aspect ratios (728×90, 300×1050) are letterboxed into the model's input, so they're predicted at low resolution.
- **The thresholds come from 86 designs**, calibrated against the layout rules, not against conversion data.

## AI fix loop

```
check ──► goal reached? ──yes──► done (return the best version + full history)
  ▲            │ no
  │            ▼
  │     LLM proposes edits (submit_edits tool: ops + a reason each)
  │            │  invalid? retry once with the validation error
  │            ▼
  │     applyFixes ──► guardrails ──► re-check
  │            │
  └── accept ◄─┴─► score dropped? roll back, tell the LLM what it broke
```

**The model gets**, in one stateless request per iteration:

- the score and the target
- every issue, with the checker's suggested fix
- a layout table (id, role, box, z-order, font/colour)
- feedback from earlier rolled-back or invalid attempts
- the design JSON
- the annotated render as an image

**The system prompt never changes**, so it's prompt-cached across every call in a run and the whole eval. It holds the rules, the ops, the strategy and the design's JSON Schema.

**The model answers through a `submit_edits` tool** with `strict: true`, whose schema is generated from the same Zod schema `applyFixes` uses. It can accept, adjust or ignore the checker's suggestions. Suggestions only know about one rule, and they often cause new problems: growing a text box can push it into the button below.

**Guardrails and stopping:**

- **Layout and style only:** the op set can't express changes to text, font family or image `src`. A backstop also compares those fields against the original after every step.
- **Validation:** every response is validated with Zod and retried once with the validation error. Responses are capped at 25 edits.
- **Rollback:** an iteration is accepted only if the score doesn't drop. Otherwise it's rolled back, and the next request includes the score drop plus the new issues it caused.
- **Stopping** happens when any of these is true:
  - score ≥ target **and** no errors remain
  - no issues remain
  - max iterations is reached
  - two iterations in a row fail to improve (by score or error count)
  - the editor fails
- **Best version:** the loop keeps the best version seen (highest score, then fewest errors).

**Replayable history:** every iteration, including rolled-back candidates, stores a full design snapshot, its report, the edits with reasons, token usage and timing. The web app can animate it directly, and a test checks that every snapshot re-checks to its recorded score.

**Reproducibility:** no server-side model fallback is enabled, so every response comes from the model you asked for. The eval records the model id the API reports.

```ts
import { createAnthropicEditor, runFixLoop } from '@simonlunay/redline-agent';
import { createFixSession } from '@simonlunay/redline-agent/node';

const session = await createFixSession('poster.json');
const result = await runFixLoop(session.loaded.design, {
  editor: createAnthropicEditor({ model: 'claude-sonnet-5-5', effort: 'medium' }),
  check: session.check,
  renderImage: session.renderImage,
  target: 90,
  maxIterations: 4,
});
result.best.design; // the fixed design
result.history; // every step, replayable
```

**With `--attention`:**

- Attention issues are just more issues for the loop.
- The model also receives the heatmap overlay as a second image.
- The prompt explains what a share means and the good fixes: grow the CTA or give it contrast and space, fade or shrink a competing decoration (`setOpacity`), or add a scrim over a busy area.
- `--render-steps` writes `NN-status.heatmap.png` for every iteration, so you can watch attention move. For example, on `hard-story-hero` the CTA went from 1.1% to 7.9% of predicted attention in two iterations, and the predicted viewing order changed from headline → product → CTA to headline → CTA → product.

`DesignEditor` is a one-method interface (`proposeEdits(request) → { raw, usage, model }`), so other LLM providers plug in without touching the loop. Validation, guardrails and rollback all live in the loop, so every provider is treated the same. `createSuggestedFixesEditor()` is the deterministic, offline editor used in tests and as the eval's rules-only baseline.

## Evaluation

```bash
npm run eval                                              # default model
npm run eval -- --models claude-sonnet-5-5,claude-opus-5-5 --runs 3
npm run eval -- --no-llm                                  # baselines only, free
npm run eval -- --fixtures worst,promo-food --effort high
npm run eval -- --strict --models claude-sonnet-5-5,claude-opus-5-5 --runs 3
npm run eval -- --strict --fixtures 'hard-*'
```

**`--strict`** is the harder benchmark:

- target **100** (every warning counts)
- the **attention rules on**
- up to **5 iterations**

It adds a second table with each fixture's CTA and headline share of predicted attention, how often the CTA is predicted to be seen first or second, and how many designs fall below the attention minimums. Rollbacks per run are reported too.

Every fixture is measured four ways, all with the same precise checker the CLI uses:

| Column     | What it measures                                                                  |
| ---------- | --------------------------------------------------------------------------------- |
| Before     | The original design                                                               |
| Rules once | Apply the checker's suggested fixes once, with no LLM                             |
| Rules loop | The same fix loop, but the editor only applies the checker's suggestions (no LLM) |
| _model_    | The fix loop with Claude (`--runs N`: mean and min–max)                           |

**The two rules columns are deterministic.** They separate what _iterating_ adds from what the _LLM_ adds.

**Results** are saved to `packages/agent/eval/results/*.json` and include:

- the git commit and settings
- per-step history
- every accepted edit with its reason
- the best design
- token usage and estimated cost
- the model ids the API returned

**Fixtures:** 21 in total:

- a clean poster
- one fixture per rule
- `worst.json`
- four messy, ad-like designs, each failing 5–8 rules at once: `ad-sneaker-sale`, `story-concert`, `banner-saas`, `promo-food`
- seven **hard** ones (`hard-*`):
  - a busy photo with a tiny CTA
  - a flyer with six competing stickers
  - a 728×90 leaderboard
  - a 300×1050 skyscraper
  - a story whose hero face pulls attention from the CTA
  - two designs that **pass every layout rule but fail attention** (`hard-attention-burst`, `hard-attention-badge`)

### Results: strict mode

This run was at commit `db2a50f`, on 2026-10-07:

- `--strict`: target 100, attention on, max 5 iterations
- effort `medium`, vision on (annotated render + heatmap)
- **3 runs per model**, 21 fixtures
- raw data in `packages/agent/eval/results/2026-10-07T01-25-38-380Z_strict_*.json`

Cells are score / errors. For the models, the score is the mean (min–max) over 3 runs, and the errors are the mean.

| Fixture                    | Before  | Rules once | Rules loop | Sonnet 5.5         | Opus 5.5         |
| -------------------------- | ------- | ---------- | ---------- | ------------------ | ---------------- |
| ad-sneaker-sale            | 11 / 7  | 28 / 4     | 33 / 4     | 100 / 0            | 100 / 0          |
| banner-saas                | 23 / 5  | 78 / 0     | 78 / 0     | 84.3 (79–88) / 0.3 | 92 (88–94) / 0   |
| clean-poster               | 100 / 0 | 100 / 0    | 100 / 0    | 100 / 0            | 100 / 0          |
| competing-headline         | 79 / 1  | 97 / 0     | 97 / 0     | 100 / 0            | 100 / 0          |
| hard-attention-badge       | 88 / 0  | 71 / 1     | 88 / 0     | 100 / 0            | 100 / 0          |
| hard-attention-burst       | 94 / 0  | 94 / 0     | 100 / 0    | 100 / 0            | 100 / 0          |
| hard-busy-photo-tiny-cta   | 70 / 1  | 70 / 1     | 70 / 1     | 98 (94–100) / 0    | 100 / 0          |
| hard-cluttered-flyer       | 63 / 1  | 94 / 0     | 94 / 0     | 100 / 0            | 98 (94–100) / 0  |
| hard-leaderboard           | 79 / 1  | 88 / 0     | 88 / 0     | 96 (94–100) / 0    | 100 / 0          |
| hard-skyscraper            | 88 / 0  | 70 / 1     | 88 / 0     | 100 / 0            | 100 / 0          |
| hard-story-hero            | 79 / 1  | 79 / 1     | 100 / 0    | 100 / 0            | 100 / 0          |
| low-contrast-on-image      | 58 / 2  | 100 / 0    | 100 / 0    | 100 / 0            | 100 / 0          |
| misaligned                 | 94 / 0  | 100 / 0    | 100 / 0    | 100 / 0            | 100 / 0          |
| off-canvas                 | 79 / 1  | 97 / 0     | 100 / 0    | 100 / 0            | 100 / 0          |
| overlap-headline-product   | 46 / 3  | 60 / 2     | 94 / 0     | 100 / 0            | 100 / 0          |
| promo-food                 | 11 / 8  | 26 / 5     | 26 / 5     | 100 / 0            | 100 / 0          |
| story-concert              | 16 / 6  | 32 / 4     | 56 / 2     | 96 (94–100) / 0    | 100 / 0          |
| stretched-image            | 84 / 1  | 100 / 0    | 100 / 0    | 100 / 0            | 100 / 0          |
| text-overflow              | 58 / 2  | 53 / 2     | 58 / 2     | 100 / 0            | 100 / 0          |
| tiny-text                  | 79 / 1  | 91 / 0     | 100 / 0    | 100 / 0            | 100 / 0          |
| worst                      | 5 / 11  | 20 / 6     | 47 / 3     | 100 / 0            | 100 / 0          |
| **Mean score**             | 62.1    | 73.7       | 81.8       | **98.8**           | **99.5**         |
| **Reached goal**           | 1/21    | 4/21       | 8/21       | **55/63 runs**     | **59/63 runs**   |
| **Rolled-back iterations** | –       | –          | –          | 12 (0.19 per run)  | 3 (0.05 per run) |
| **Mean iterations**        | –       | –          | –          | 1.75               | 1.37             |
| **Cost (3 runs)**          | –       | –          | –          | $1.94 (110 calls)  | $3.62 (86 calls) |

Predicted attention: share of the best design's attention, with the mean over all fixtures and runs.

| Attention                                 | Before | Rules loop | Sonnet 5.5 | Opus 5.5 |
| ----------------------------------------- | ------ | ---------- | ---------- | -------- |
| Designs with the CTA below the 5% minimum | 4/21   | 4/21       | **0/63**   | **0/63** |
| Designs with the headline below 19%       | 5/21   | 5/21       | 2/63       | 1/63     |
| CTA predicted to be seen 1st or 2nd       | 17/21  | 16/21      | 51/63      | 52/63    |
| Mean CTA share                            | 9.4%   | 8.8%       | 9.6%       | 10.6%    |
| Mean headline share                       | 25.4%  | 26.1%      | 29.1%      | 29.1%    |

Selected CTA shares (mean, with min–max over 3 runs):

| Fixture                  | Before | Rules loop | Sonnet 5.5        | Opus 5.5          |
| ------------------------ | ------ | ---------- | ----------------- | ----------------- |
| hard-busy-photo-tiny-cta | 0.1%   | 0.1%       | 8.7% (6.6–10.4)   | 7.7% (7.1–8.4)    |
| hard-story-hero          | 1.1%   | 5.5%       | 6.0% (5.8–6.2)    | 8.9% (6.6–11.2)   |
| hard-skyscraper          | 2.6%   | 2.6%       | 6.9% (6.9–7.0)    | 8.5% (7.3–10.1)   |
| hard-leaderboard         | 4.2%   | 4.2%       | 7.8% (6.4–10.1)   | 9.5% (9.3–9.7)    |
| hard-attention-badge     | 7.6%   | 7.6%       | 15.5% (13.1–18.3) | 16.0% (15.7–16.5) |

**What the numbers show:**

- **The strict benchmark separates the models where the normal one couldn't.**
  - Opus reaches the goal in 59/63 runs and Sonnet in 55/63.
  - Sonnet needs more iterations (1.75 vs 1.37 on average).
  - The gap shows up on the hardest designs: `banner-saas` (Sonnet 84 vs Opus 92), the busy photo, the leaderboard and `story-concert`.
  - Opus costs about 1.9× as much ($0.057 vs $0.031 per fixed design).
- **Rollback now fires in real runs.** Sonnet had 12 rolled-back iterations (0.19 per run) and Opus 3. After each one the next attempt was steered by the "you broke X" feedback, and those runs still converged.
- **Rules alone can't fix attention.** Looping the checker's suggestions leaves 4/21 CTAs below the minimum and doesn't change the mean CTA share. Both LLMs bring **every CTA above the minimum in every run**: the starved CTAs go from 0.1–4% to 6–16%.
- **Mean CTA share is the wrong headline metric.** Over-attended CTAs (e.g. `low-contrast-on-image` at 29.8%) drop to a normal share as their layout problems are fixed, while starved ones rise. "Below the minimum" is what the rule enforces, and it's what to quote.
- **The two layout-clean but attention-failing designs** (`hard-attention-badge`, `hard-attention-burst`) score 88 and 94 before. Every run fixes them to 100, mostly by boosting the CTA and toning down the decoration.
- **`banner-saas` is still unsolved.** At 1200×628 with a long headline, the model gives the headline about 50% of attention, and the small CTA stays near the 5% line.

### Phase 2 results (normal mode)

This run was at commit `c64f2d5`, on 2026-10-07, before the hard fixtures and attention existed:

- effort `medium`, target 90, max 4 iterations, vision on
- **3 runs per model**, 14 fixtures
- raw data in `packages/agent/eval/results/2026-10-07T00-10-51-680Z_*.json`

Each cell is score / errors. For the models, the score is the mean (min–max) over the 3 runs.

| Fixture                  | Before  | Rules once | Rules loop | Sonnet 5.5       | Opus 5.5         |
| ------------------------ | ------- | ---------- | ---------- | ---------------- | ---------------- |
| ad-sneaker-sale          | 11 / 7  | 28 / 4     | 35 / 4     | 97 (94–100) / 0  | 97 (94–100) / 0  |
| banner-saas              | 27 / 5  | 88 / 0     | 97 / 0     | 98 (97–100) / 0  | 99 (97–100) / 0  |
| clean-poster             | 100 / 0 | 100 / 0    | 100 / 0    | 100 / 0          | 100 / 0          |
| competing-headline       | 84 / 1  | 100 / 0    | 100 / 0    | 100 / 0          | 100 / 0          |
| low-contrast-on-image    | 58 / 2  | 100 / 0    | 100 / 0    | 100 / 0          | 100 / 0          |
| misaligned               | 94 / 0  | 100 / 0    | 94 / 0     | 94 / 0           | 94 / 0           |
| off-canvas               | 79 / 1  | 97 / 0     | 97 / 0     | 100 / 0          | 100 / 0          |
| overlap-headline-product | 58 / 2  | 76 / 1     | 100 / 0    | 100 / 0          | 100 / 0          |
| promo-food               | 11 / 8  | 27 / 5     | 27 / 5     | 97 (97–97) / 0   | 100 / 0          |
| story-concert            | 22 / 5  | 40 / 3     | 67 / 1     | 99 (97–100) / 0  | 100 / 0          |
| stretched-image          | 84 / 1  | 100 / 0    | 100 / 0    | 100 / 0          | 100 / 0          |
| text-overflow            | 58 / 2  | 53 / 2     | 58 / 2     | 100 / 0          | 100 / 0          |
| tiny-text                | 79 / 1  | 91 / 0     | 91 / 0     | 100 / 0          | 100 / 0          |
| worst                    | 6 / 11  | 21 / 6     | 54 / 2     | 98 (97–100) / 0  | 98 (97–100) / 0  |
| **Mean score**           | 55.1    | 72.9       | 80.0       | **98.8**         | **99.1**         |
| **Errors (total)**       | 46      | 21         | 14         | 0 (every run)    | 0 (every run)    |
| **Reached goal**         | 2/14    | 7/14       | 9/14       | **42/42 runs**   | **42/42 runs**   |
| **Cost (3 runs)**        | n/a     | n/a        | n/a        | $0.67 (42 calls) | $1.26 (37 calls) |

**What the numbers show:**

- **The checker's own suggestions only get you so far.** Applied once, they lift the mean score from 55 to 73. Looped, they reach 80, but the four messy ads stay at 27–97, and `text-overflow` doesn't improve at all. Growing the text box pushes it into the button, so the loop correctly rolls that back.
- **The LLM adds what the rules can't.** It reasons across rules and repairs the whole layout. It moves text off photos, adds translucent backing shapes (`insertShape` was used in 9 of 42 Sonnet runs), and rebalances type sizes. It cleared every error in every run, usually in **one iteration**.
- **Sonnet 5.5 vs Opus 5.5:** almost identical quality on this set, and Sonnet costs about half as much (about $0.016 per fixed design). That's why Sonnet is the default.
- **`misaligned` stays at 94 for every loop.** 94 with no errors already meets the goal, so the loop never runs. The "rules once" column applies its suggestions unconditionally, which is why it shows 100 there.

**Limitations to keep in mind:**

- **The benchmark was saturated.** Both models solved every fixture, so it couldn't separate them, and no rollback fired. That's why `--strict` and the hard fixtures were added (see above).
- **The checker is also the judge.** A high score means "passes these 9 rules", not "is a good design". I spot-checked the fixed renders (`redline fix --render-steps`), and they're genuine layout repairs rather than games played against the rules. A vision- or human-rated quality check would be the next step.
- **LLM runs vary.** Results come from the requested model only (no fallbacks), but sampling isn't deterministic. That's why the table reports min–max over 3 runs.

## Generation

`redline generate` turns a one-line prompt into a finished, editable design in the Redline format. It plans the design, generates the images in layers, builds several candidates, scores them with the checker, picks the best, and repairs it with the fix loop.

```
$ redline generate "poster for a charity 5K, energetic, blue and orange" --out charity.json --render-steps steps/

 redline generate  "poster for a charity 5K, energetic, blue and orange"
  1080x1350 · 4 candidates · target 95 · director anthropic:claude-sonnet-5-5 · images replicate + cutout auto · …

  Plan (anthropic:claude-sonnet-5-5)
    A burst of motion: runners racing toward a sunrise, cobalt blue sky with vivid orange energy…
    copy  RUN FOR HOPE · Charity 5K · Saturday, June 14 · City Park · [Register Now]
    layout 1 headline top, runners below
    layout 2 text on bottom panel, hero runner

  Candidates
  #1   76  ████████░░  1 error · 0 warnings · CTA 17% · layout 1, background 1
  #2  100  ██████████  0 errors · 0 warnings · CTA 11% · layout 2, background 1
  #3   58  ██████░░░░  2 errors · 0 warnings · CTA 15% · layout 1, background 2
  #4  100  ██████████  0 errors · 0 warnings · CTA 10% · layout 2, background 2

  ★ Winner: candidate 2 of 4 (100) · text on bottom panel, hero runner

  ✔ first candidate 76 → best of 4 100 → final 100 · 0 iterations · stop: no-issues
    spend this run ≈ $0.052 (LLM $0.037 · images $0.015) · 84.5s
```

`--render-steps` writes `contact-sheet.png`: every candidate with its score, CTA/headline attention and heatmap, the winner outlined, and the final design after the fix loop. It also writes one annotated PNG (plus heatmap) per candidate and per fix-loop step.

### How it works

```
prompt ──► art director (Claude, strict tool) ──► plan: copy, palette, 2 layouts, image briefs
                                                      │
              ┌───────────────────────────────────────┘
              ▼
   images per slot: background (FLUX.1 schnell / Pexels / yours) · subject (generated on a
   plain backdrop → BiRefNet cutout) · logo and supplied images (used as-is)
              │
              ▼
   N candidates = layouts × background seeds ──► checkAsync (layout + attention rules)
              │
              ▼
   best of N (score, then errors, warnings, CTA attention) ──► fix loop (+ image regeneration)
```

1. **Art director.** One Claude call returns a design plan through a `submit_design_plan` tool with `strict: true`. The schema is generated from Zod and kept simple for strict mode (no nullable fields, one discriminated union per element kind). The plan has the concept, a palette, all the copy, 1–3 alternative layouts (element roles, boxes, z-order, text styling) and an image brief per slot. Code then checks what a schema can't, and sends any problems back for **one retry**: exactly one headline, every image element points to a slot, boxes inside the canvas, hex colors, fonts that are actually available, a `calmAreas` description on every background ("keep the top third calm for the headline"), and **no copy inside any image brief**. Text is always a separate, editable text element. The image model is never asked to draw words.
2. **Image prompts.** The prompt sent to the image model is built in code: the brief, the art director's calm areas, a description of the text zones computed from the layout's boxes ("Text will be placed over the top 32% (headline, subheading) and the bottom 18%, center side (cta): keep those areas calm…"), the style, and "No text, no letters, no words, no logos". So the text-safe areas are right even when the model's own description is vague.
3. **Layered images.** Every source sits behind one `ImageProvider` interface:
   - **FLUX.1 [schnell]** on Replicate (`REPLICATE_API_TOKEN`), $0.003 per image. Seeds are derived from the prompt, so runs are reproducible.
   - **Pexels** stock search (`PEXELS_API_KEY`), using the slot's short `stockQuery`.
   - **Your images** (`--logo`, `--image`), copied into the assets folder and never modified.
   - A deterministic **mock** (seeded gradients and shapes) used by every test.
   Subjects (a product, a runner, a dog) are generated separately "isolated on a plain light-grey studio background", then cut out locally with **BiRefNet_lite** through `onnxruntime-node` and trimmed to their visible pixels, so the element box matches the subject. If the model can't load, a flood-fill keyer removes the plain backdrop instead.
4. **Best-of-N.** Candidate *i* uses layout `i mod L` and background variant `⌊i / L⌋`, so the default (4 candidates, 2 layouts) tries both layouts with two different backgrounds each. Subjects are made once per layout. Each candidate is assembled into the design format and scored with `checkAsync`, with layout and attention rules. The winner has the highest score, then fewest errors, then fewest warnings, then the most CTA attention. All candidates are kept.
5. **Fix loop.** The existing loop runs on the winner, with attention and vision on and a default target of 95.
6. **Image-aware fixing.** In generation mode the loop's editor gets one extra op, `regenerateImage {elementId, brief, reason}`. When an issue comes from the image itself, for example text contrast over a busy area or a background hot spot competing with the CTA, Claude can choose between layout edits (a scrim, moving text) and a new image from a revised brief ("…keep the top-left third plain and dark"). Details:
   - Regenerations run before the layout edits in the same response.
   - The new prompt's text zones come from the *current* layout.
   - The result is accepted or rolled back like any edit.
   - Regenerations are capped per run (`--max-regenerations`, default 2) and counted when attempted, since they cost money even if rolled back.
   - Each one is recorded in history and in the manifest with its reason and the image it replaced.
   - **`redline fix` on your own designs is unchanged.** The op isn't in its tool schema or prompt, a regeneration request there fails validation, and the guardrail still rejects any change to an image `src`. A test runs `redline fix` with an editor that asks to regenerate and checks that every `src` is untouched.

### Assembly details

- The background fills the canvas with `fit: cover`, so any generated size works.
- Subjects, logos and supplied images get the largest box with their **real** aspect ratio inside the planned box (`fit: contain`). They're never stretched.
- CTA labels are snapped to their text's real height and centered in their button. Text renders from the top of its box, so a label box that fills its button sits visibly high. Nothing overflows or overlaps there, so the checker can't flag it, and the first live run showed exactly this.

### Output files

`--out poster.json` writes:

| Path                           | Contents                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `poster.json`                  | The final design (relative image paths)                                                                             |
| `poster.assets/`               | Every image file                                                                                                    |
| `poster.assets/manifest.json`  | Per image: prompt, provider, model, seed, cost, license, cutout model and license, and the reason for any regeneration |
| `poster.candidates/*.json`     | Every candidate as a standalone design you can `redline check`                                                      |
| `poster.generation.json`       | The plan, every candidate's score and attention, the ranking, the full fix-loop history, and the spend              |

### CLI

```bash
redline generate "<prompt>" [options]
```

| Option                     | Description                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `--out <path>`             | Design to write (default `generated/<slug>.json`)                                                 |
| `--size <WxH>`             | Canvas size (default `1080x1350`)                                                                 |
| `--candidates <n>`         | Candidates to build and score (default 4, max 12)                                                 |
| `--layouts <n>`            | Distinct layouts among them (default `min(2, candidates)`)                                        |
| `--target <score>`         | Fix-loop target, with no errors (default 95)                                                      |
| `--max-iterations <n>`     | Fix-loop iterations (default 4)                                                                   |
| `--max-regenerations <n>`  | Image regenerations the fix loop may use (default 2, `0` = layout edits only)                     |
| `--render-steps <dir>`     | Contact sheet, candidate renders and per-step PNGs + heatmaps                                     |
| `--provider <name>`        | `replicate`, `pexels` or `mock`. Default: the first one with a key, otherwise `mock`             |
| `--cutout <name>`          | `auto` (BiRefNet, keying fallback), `birefnet`, `key` or `none`                                   |
| `--director <name>`        | `anthropic` (default) or `template` (offline, deterministic)                                      |
| `--editor <name>`          | `anthropic` (default) or `suggested` (offline)                                                    |
| `--model`, `--effort`      | Claude model and effort for the art director and the fix loop (default Sonnet 5.5, `medium`)      |
| `--brand-colors <list>`    | Hex colors the plan must use                                                                      |
| `--font <Family=path>`     | Register a font file the plan may use (repeatable; Inter is bundled)                              |
| `--logo`, `--image <path>` | Your logo / images; used as supplied                                                              |
| `--budget <usd>`           | Spend cap for this run (default $2); paid calls that could cross it are refused                   |
| `--ledger <path>`          | Persistent spend ledger, so a cap holds across runs                                               |
| `--seed`, `--no-attention`, `--no-vision`, `--format` | As expected                                                            |

Fully offline (no keys, no cost): `redline generate "…" --director template --provider mock --editor suggested`.

**Spend control.** Every paid call goes through a spend ledger. Before a call, the ledger checks a worst-case estimate against the cap; after it, the ledger records the real cost. A Claude call's worst case is priced at 30k input + 16k output tokens. For images, crossing the cap switches to the mock provider for candidates, or refuses a regeneration. In the fix loop, it stops the loop with `editor-error`. Image calls running in parallel count against the cap while they're in flight, so they can't all slip past it at once.

### Models and licenses

| Model                         | Used for                 | License                                                                                                                                                                                   | How it's obtained                                                                                                                                                            |
| ----------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Sonnet 5.5 (default)   | Art director, fix loop   | Anthropic API terms                                                                                                                                                                       | API (`ANTHROPIC_API_KEY`)                                                                                                                                                    |
| FLUX.1 [schnell]              | Backgrounds and subjects | **Apache-2.0**: the model card says it "can be used for personal, scientific, and commercial purposes" ([license](https://github.com/black-forest-labs/flux/blob/main/model_licenses/LICENSE-FLUX1-schnell), checked 2026-10-06) | Hosted on Replicate, `black-forest-labs/flux-schnell`, $0.003/image                                                                                                         |
| BiRefNet_lite                 | Subject cutouts          | **MIT** ([ZhengPeng7/BiRefNet_lite](https://huggingface.co/ZhengPeng7/BiRefNet_lite)); see NOTICE for training-data caveats                                                                 | ONNX from [`onnx-community/BiRefNet_lite-ONNX`](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) at commit `de15b22`, 224,005,088 bytes, SHA-256 `56000243…f03333`. Downloaded from Hugging Face into the Redline cache on first use (not re-hosted), verified before use, about 15 s per cutout on a laptop CPU |
| MSI-Net                       | Attention check          | MIT                                                                                                                                                                                       | See [Attention check](#attention-check)                                                                                                                                      |
| Pexels (optional)             | Stock backgrounds        | [Pexels License](https://www.pexels.com/license/)                                                                                                                                          | API (`PEXELS_API_KEY`)                                                                                                                                                       |

### Limits

- **The checker is still the judge.** A generated design that scores 100 passes the layout and attention rules. It isn't necessarily a good design. The eval below lists the cases I found that score well but look wrong.
- **Fonts:** only Inter is bundled. The art director can use other families only if you register them with `--font`.
- **Cutouts** are as good as BiRefNet on a plain backdrop: fine for products, people and animals, weaker on thin structures. The keying fallback leaves halos on shadows.
- **FLUX schnell** sometimes ignores parts of the brief, including "no text". The calm-area instruction is a request, not a guarantee, which is exactly what the regeneration op and the contrast rule are there to catch.
- **No visual-quality model** judges aesthetics yet. Best-of-N picks by rule score, so two very different candidates that both score 100 are a tie broken by warnings and CTA attention.

## Development

```bash
npm install
npm test                 # vitest: checker + agent (no test calls a real API)
npm run lint             # eslint (also blocks Node imports in isomorphic code)
npm run typecheck
npm run build                                 # checker, then agent
npm run redline -- check fixtures/worst.json --annotate out/worst.png
npm run redline -- fix fixtures/worst.json --editor suggested    # offline
npm run eval -- --no-llm
npm run fixture-images -w packages/checker   # regenerate placeholder images
npm run calibrate-attention -w packages/agent  # re-derive attention thresholds
npm run eval:generate -- --offline              # generation eval with mocks, free
npm run redline -- generate "poster for a bake sale" --director template --provider mock --editor suggested
```

**Reproducing the saliency model:** `packages/checker/scripts/convert-msi-net.py` (Python 3.11, TensorFlow 2.15.1, tf2onnx 1.16.1). On Windows, use a short venv path, because TensorFlow exceeds the 260-character path limit otherwise. A real-model smoke test runs only if the model is already in the cache, so CI never downloads it.

`npm run redline` runs the CLI straight from TypeScript source through a custom `@simonlunay/source` export condition, so you don't have to build first. Published builds ignore that condition.

LLM behaviour is tested with a scripted editor and a fake Anthropic client, and the CLI tests inject an empty environment, so tests never spend money.

```
packages/checker/            @simonlunay/redline
  src/core/     isomorphic: schema, engine, fixes, geometry, colour, text layout, rules/
  src/node/     Node-only: fonts, image sampler, renderer, pretty formatter
  src/cli.ts
  fonts/        Inter (SIL Open Font License), for identical results on every OS
packages/generate/           @simonlunay/redline-generate (private for now)
  src/          isomorphic: plan schema, art directors, image prompts, providers, assembly,
                best-of-N selection, spend ledger
  src/node/     generate command, pipeline, cutouts (BiRefNet), assets + manifest, contact sheet
  eval/         npm run eval:generate, prompts.json, results/ (incl. spend-ledger.json)
packages/agent/              @simonlunay/redline-agent
  src/          isomorphic: loop, edit schema + guardrails, prompt, editors/
  src/node/     redline fix command, sessions, output formatting
  eval/         npm run eval + saved results
fixtures/       sample designs: clean, one per defect, worst case, four messy ads
```

ESLint's `no-restricted-imports` rule forbids `node:*`, `fs`, `path` and `@napi-rs/*` inside `packages/checker/src/core` and `packages/agent/src` (except `src/node`). That keeps the core isomorphic.

## Roadmap

1. ~~**Checker**: rules, scoring, machine-readable fixes, CLI.~~ Done.
2. ~~**AI fix loop**: check → LLM edits → re-check with rollback, plus an eval harness.~~ Done.
3. ~~**Attention check**: a saliency model predicts where viewers look, key elements get per-element attention shares, and the fix loop improves them. Plus a harder `--strict` benchmark.~~ Done.
4. ~~**Generation**: produce designs in this format from a brief, then run them through the loop.~~ Done (see [Generation](#generation)).
5. **Resizing**: adapt a design across formats (Instagram post, story, banner) and re-check every version.
6. **Web app**: a React canvas editor (`apps/web`) that runs the checker live in the browser and replays fix-loop histories.

## License

MIT © Simon Lunay. The bundled Inter font is © The Inter Project Authors, licensed under the [SIL Open Font License 1.1](packages/checker/fonts/OFL.txt). The MSI-Net saliency model and the BiRefNet_lite cutout model (both downloaded on demand) are MIT-licensed; FLUX.1 [schnell] (called as an API) is Apache-2.0. See [NOTICE](NOTICE) for attributions and training-data caveats.
