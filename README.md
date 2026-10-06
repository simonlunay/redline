# Redline

**ESLint for designs.** Give Redline a poster, social post or ad as JSON, and it returns a 0–100 score plus a list of problems tied to specific elements. Each problem comes with a **machine-readable fix**.

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

This package is phase 1 of a larger project: an AI design assistant that generates a design, checks it with Redline, applies the suggested fixes and loops until the design scores well (see [Roadmap](#roadmap)).

## Install

```bash
npm install @simonlunay/redline     # library + CLI
npx @simonlunay/redline check design.json
```

Node 20+. Rendering uses [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (Skia with prebuilt binaries), so nothing gets compiled on install on Windows, macOS or Linux.

## CLI

```bash
redline check <design.json> [options]
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

Each issue has `measured` and `threshold` values (e.g. `1.24` vs `3`, unit `:1`), so an agent can tell _how far off_ the design is, not only that it failed.

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

### Scoring

- Each issue removes `points × rule weight` percent of its rule's score. Points are error 8, warning 3 and info 0.5, so a contrast error (weight 3) removes 24%.
- The **overall score is the product of the rule scores**.
- A weighted average would let eight passing rules hide a real error: a design with a stretched image would still score 97. With a product, every failing rule pulls the total down, the score never goes negative, and issue order doesn't matter.
- `passed` is `false` whenever there's at least one error.

## Development

```bash
npm install
npm test                 # vitest: unit tests per rule + snapshot reports of every fixture
npm run lint             # eslint (also blocks Node imports inside src/core)
npm run typecheck
npm run build
npx tsx packages/checker/src/cli.ts check fixtures/worst.json --annotate out/worst.png
npm run fixture-images -w packages/checker   # regenerate placeholder images
```

```
packages/checker/
  src/core/     isomorphic: schema, engine, geometry, colour, text layout, rules/
  src/node/     Node-only: fonts, image sampler, renderer, pretty formatter
  src/cli.ts
  fonts/        Inter (SIL Open Font License), for identical results on every OS
fixtures/       sample designs: a clean poster plus one design per defect
```

The core stays isomorphic because ESLint's `no-restricted-imports` rule forbids `node:*`, `fs`, `path` and `@napi-rs/*` inside `src/core`.

## Roadmap

1. **AI fix loop**: an agent that applies `fix` operations (or reasons from the messages), re-checks, and stops when the score passes a target.
2. **Generation**: produce designs in this format from a brief, then run them through the loop.
3. **Resizing**: adapt a design across formats (Instagram post, story, banner) and re-check every version.
4. **Attention check**: use a vision model on the rendered PNG to judge what the eye lands on first.
5. **Web app**: a React canvas editor (`apps/web`) that runs the checker live in the browser.

## License

MIT © Simon Lunay. The bundled Inter font is © The Inter Project Authors, licensed under the [SIL Open Font License 1.1](packages/checker/fonts/OFL.txt).
