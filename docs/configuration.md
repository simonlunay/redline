# Configuration and custom rules

## Config

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

The opt-in rule sets are configured the same way, for example the [attention](attention.md) minimums:

```json
{ "rules": { "attention-key-elements": { "options": { "minShare": { "cta": 0.08 } } } } }
```

## Custom rules

Custom rules are plain objects:

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

## Async and render-based rules

- A rule's `check` may return a Promise.
- It can declare `requires: ['render']` and read pixels with `await ctx.render()`.
- It can return `{ issues, elementScores }` to report per-element numbers (e.g. attention share).
- `check()` stays synchronous and skips such rules, listing them in `report.skipped`. `checkAsync(design, { render })` runs them.
- In Node, `createNodeEnv()` provides `render`, and the CLI always uses `checkAsync`.

This is how the [attention rules](attention.md) and the [image rules](judge-and-image-checks.md#image-rules) plug in.

See [Rules](rules.md#scoring) for how rule weights feed the score.
