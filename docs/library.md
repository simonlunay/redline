# Library

## Checker (`@simonlunay/redline`)

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

Rules that need a render (the [attention](attention.md) and [image](judge-and-image-checks.md) rules) run through `checkAsync()`; see [Configuration](configuration.md#async-and-render-based-rules).

The Node entry point provides precise implementations of both interfaces, plus file loading and rendering:

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

Other core exports: `applyFixes`, `designJsonSchema()` and `fixJsonSchema()` (see [Rules](rules.md#fixes)), and `defineRule` / `builtinRules` (see [Configuration](configuration.md#custom-rules)).

## Fix loop (`@simonlunay/redline-agent`)

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

See [Fix loop](fix-loop.md) for what the loop sends, its guardrails and the `DesignEditor` interface.
