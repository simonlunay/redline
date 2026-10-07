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
npx @simonlunay/redline check design.json
```

Node 20+. Rendering uses [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (Skia with prebuilt binaries), so nothing gets compiled on install on Windows, macOS or Linux.

## CLI

```bash
redline check <design.json> [options]
redline fix <design.json> [options]    # AI fix loop, see below
redline rules                          # list rules, defaults and weights
```

| Option                  | Description                                                 |
| ----------------------- | ----------------------------------------------------------- |
| `--format pretty\|json` | Coloured report (default) or JSON for tools and CI          |
| `--config <path>`       | JSON config file (see [Configuration](#configuration))      |
| `--render <out.png>`    | Render the design to PNG                                    |
| `--annotate <out.png>`  | Render with numbered issue boxes and the score drawn on top |

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
  | { op: 'setFontWeight'; elementId: string; fontWeight: number };
```

```ts
  | { op: 'insertShape'; behindElementId: string; kind: 'rect' | 'ellipse';
      x: number; y: number; width: number; height: number;
      fill: string; opacity: number; cornerRadius: number };
```

- **`setColor`** sets the text colour on text and the fill on shapes.
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

`DesignEditor` is a one-method interface (`proposeEdits(request) → { raw, usage, model }`), so other LLM providers plug in without touching the loop. Validation, guardrails and rollback all live in the loop, so every provider is treated the same. `createSuggestedFixesEditor()` is the deterministic, offline editor used in tests and as the eval's rules-only baseline.

## Evaluation

```bash
npm run eval                                              # default model
npm run eval -- --models claude-sonnet-5-5,claude-opus-5-5 --runs 3
npm run eval -- --no-llm                                  # baselines only, free
npm run eval -- --fixtures worst,promo-food --effort high
```

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

**Fixtures:** 14 in total:

- a clean poster
- one fixture per rule
- `worst.json`
- four messy, ad-like designs, each failing 5–8 rules at once: `ad-sneaker-sale`, `story-concert`, `banner-saas`, `promo-food`

<!-- EVAL-RESULTS -->

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
```

`npm run redline` runs the CLI straight from TypeScript source through a custom `@simonlunay/source` export condition, so you don't have to build first. Published builds ignore that condition.

LLM behaviour is tested with a scripted editor and a fake Anthropic client, and the CLI tests inject an empty environment, so tests never spend money.

```
packages/checker/            @simonlunay/redline
  src/core/     isomorphic: schema, engine, fixes, geometry, colour, text layout, rules/
  src/node/     Node-only: fonts, image sampler, renderer, pretty formatter
  src/cli.ts
  fonts/        Inter (SIL Open Font License), for identical results on every OS
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
3. **Attention check**: a rule that runs a visual saliency model on the rendered PNG to predict where viewers look. It will check that key elements (CTA, headline, logo, product) get enough of that attention, and report per-element attention shares. The plumbing is in place:
   - async rules
   - `requires: ['render']` with a lazy `ctx.render()`
   - `elementScores` in reports
   - `checkAsync` in the CLI and the fix loop
4. **Generation**: produce designs in this format from a brief, then run them through the loop.
5. **Resizing**: adapt a design across formats (Instagram post, story, banner) and re-check every version.
6. **Web app**: a React canvas editor (`apps/web`) that runs the checker live in the browser and replays fix-loop histories.

## License

MIT © Simon Lunay. The bundled Inter font is © The Inter Project Authors, licensed under the [SIL Open Font License 1.1](packages/checker/fonts/OFL.txt).
