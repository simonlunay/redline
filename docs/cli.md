# CLI reference

```bash
redline check <design.json> [options]
redline fix <design.json> [options]    # AI fix loop
redline rules                          # list rules, defaults and weights
redline setup attention                # download the saliency model (50 MB, once)
redline setup image-checks             # download the text detector for --image-checks (13 MB, once)
redline generate "<prompt>" [options]  # prompt to design, from a clone only
```

`redline check` and `redline rules` come with `@simonlunay/redline`. `redline fix` needs `@simonlunay/redline-agent` as well. `redline generate` is not published to npm; it runs from a clone of the repo (see [Generation](generation.md#running-generate-from-source)), and its options are listed there.

Node 20+. Rendering uses [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (Skia with prebuilt binaries), so nothing gets compiled on install on Windows, macOS or Linux.

## `redline check`

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
  label-centered      ██████████ 100  ok

  Errors (11)
  ✖ 1. headline "headline" has a contrast of 1.24:1 against what is behind it; large text needs 3:1. [text-contrast]
       measured 1.24:1 · threshold 3:1
       fix: set headline color to #000000
  ...
```

| Option                  | Description                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `--format pretty\|json` | Coloured report (default) or JSON for tools and CI                                           |
| `--config <path>`       | JSON config file (see [Configuration](configuration.md))                                     |
| `--render <out.png>`    | Render the design to PNG                                                                     |
| `--annotate <out.png>`  | Render with numbered issue boxes and the score drawn on top, numbered to match the report    |
| `--attention`           | Also run the [attention check](attention.md) (needs `onnxruntime-node`)                      |
| `--heatmap <out.png>`   | Write a predicted-attention overlay with per-element shares (implies `--attention`)          |
| `--image-checks`        | Also check the images: [text drawn into them and damaged cutouts](judge-and-image-checks.md) |

**Exit codes:** `0` means no errors, `1` means errors were found (so it can gate CI), and `2` means invalid input or usage.

Image `src` paths are resolved relative to the design file.

## `redline fix`

```
$ redline fix fixtures/worst.json --out fixed.json --render-steps steps/

 redline fix  fixtures/worst.json  target 90 · max 4 · claude-sonnet-5-5 (medium)

  #0  start          6  █░░░░░░░░░       11 errors · 3 warnings
  #1  accepted      94  █████████░  +88  0 errors · 2 warnings
        Reflow the layout: headline on top, subheading below it, product at its natural ratio, ...
        ...

  ✔ 6 → 94 in 1 iteration · errors 11 → 0 · stop: target reached
    1 LLM call · 8.9k in (0 cached) / 1.6k out tokens · ≈ $0.036 · 20.2s
```

| Option                 | Description                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--out <path>`         | Where to write the best design (default `<name>.fixed.json`)                                                                 |
| `--target <score>`     | Done when the score reaches this **and** no errors remain (default 90)                                                       |
| `--max-iterations <n>` | Max repair iterations (default 4)                                                                                            |
| `--model <id>`         | Claude model (default `claude-sonnet-5-5`)                                                                                   |
| `--effort <level>`     | `low` `medium` `high` `xhigh` `max` (default `medium`)                                                                       |
| `--editor <name>`      | `anthropic` (default) or `suggested`: applies the checker's own fixes, offline, no key needed                                |
| `--render-steps <dir>` | Annotated PNG per iteration (`00-initial.png`, `01-accepted.png`, …, `final.png`)                                            |
| `--no-vision`          | Don't send the annotated render to the model                                                                                 |
| `--attention`          | Add the attention rules to the loop; `--render-steps` also writes a heatmap per iteration                                    |
| `--image-checks`       | Also report text drawn into images and damaged cutouts (`redline fix` can't change images, so these are reported, not fixed) |
| `--config`, `--format` | Same as `check`                                                                                                              |

It needs `ANTHROPIC_API_KEY`, read from the environment or from `./.env` (copy `.env.example`). The exit code is `0` if the final design has no errors. See [Fix loop](fix-loop.md) for how it works.
