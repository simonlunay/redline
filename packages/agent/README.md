# @simonlunay/redline-agent

The AI fix loop for [Redline](https://github.com/simonlunay/redline#readme), "ESLint for designs". It checks a design, lets Claude repair the problems, re-checks, and repeats until the design is good. It returns the best version plus a full, replayable history.

```
$ npx @simonlunay/redline fix poster.json --out fixed.json --render-steps steps/

 redline fix  poster.json  target 90 · max 4 · claude-sonnet-5-5 (medium)

  #0  start          6  █░░░░░░░░░       11 errors · 3 warnings
  #1  accepted      94  █████████░  +88  0 errors · 2 warnings
        • move headline by (+0, -130) — move the headline above the product
        • set headline color to #0f172a — contrast on the sky
        … 19 more

  ✔ 6 → 94 in 1 iteration · errors 11 → 0 · stop: target reached
```

## Install

```bash
npm install @simonlunay/redline @simonlunay/redline-agent
```

Installing this package enables the `redline fix` command of [`@simonlunay/redline`](https://www.npmjs.com/package/@simonlunay/redline). Set `ANTHROPIC_API_KEY` in the environment or in a `.env` file. Use `--editor suggested` to run offline: it applies the checker's own suggested fixes and needs no key.

## CLI

| Option                 | Description                                                            |
| ---------------------- | ---------------------------------------------------------------------- |
| `--out <path>`         | Where to write the best design (default `<name>.fixed.json`)           |
| `--target <score>`     | Done when the score reaches this **and** no errors remain (default 90) |
| `--max-iterations <n>` | Max repair iterations (default 4)                                      |
| `--model <id>`         | Claude model (default `claude-sonnet-5-5`)                             |
| `--effort <level>`     | `low` `medium` `high` `xhigh` `max` (default `medium`)                 |
| `--editor <name>`      | `anthropic` (default) or `suggested` (offline, deterministic)          |
| `--render-steps <dir>` | Annotated PNG per iteration                                            |
| `--no-vision`          | Don't send the annotated render to the model                           |
| `--config`, `--format` | Checker config file; `pretty` or `json` output                         |

The exit code is `0` if the final design has no errors, `1` if errors remain, and `2` for usage errors.

## Library

```ts
import { createAnthropicEditor, runFixLoop } from '@simonlunay/redline-agent';
import { createFixSession } from '@simonlunay/redline-agent/node';

const session = await createFixSession('poster.json');
const result = await runFixLoop(session.loaded.design, {
  editor: createAnthropicEditor({ model: 'claude-sonnet-5-5', effort: 'medium' }),
  check: session.check,
  renderImage: session.renderImage, // optional: let the model see the render
  target: 90,
  maxIterations: 4,
});

result.best.design; // the best design seen
result.history; // every iteration: design snapshot, report, edits + reasons, usage
result.stopReason; // 'target-reached' | 'no-issues' | 'max-iterations' | 'no-improvement' | 'editor-error'
```

The main entry point is isomorphic. `./node` adds file loading, rendering, and the CLI command.

## How the loop works

**Each iteration:** check → the editor proposes edits → `applyFixes` → guardrails → re-check.

- **The model receives:** the score, every issue with the checker's suggested fix, a layout table, feedback from failed attempts, the design JSON, and the annotated render.
- **The model answers through a strict `submit_edits` tool.** The edit format is the same one `applyFixes` uses: `move`, `resize`, `setColor`, `setFontSize`, `setFontWeight`, `insertShape`, each with a short `reason`.
- **Layout and style only:** no op can change text content, font family or image `src`, and a backstop compares those fields against the original after every step.
- **Validation:** invalid responses are retried once with the validation error.
- **Rollback:** an iteration is kept only if the score doesn't drop. Otherwise it's rolled back, and the next request explains what it broke.
- **Stopping:** the loop stops when score ≥ target with no errors, no issues remain, max iterations is reached, two iterations in a row don't improve, or the editor fails.
- **Reproducibility:** no server-side model fallback is enabled, so every response comes from the requested model.

`DesignEditor` is a one-method interface, so other LLM providers can plug in. `createSuggestedFixesEditor()` is the deterministic editor used for tests and as a rules-only baseline.

## Evaluation

Mean score on 14 fixtures, 3 runs per model: **55.1 before, 80.0 with rules alone, 98.8 with Sonnet 5.5, 99.1 with Opus 5.5**. Both models cleared every error in every run. See the [main README](https://github.com/simonlunay/redline#evaluation) for the full table, the method and the caveats.

## License

MIT
