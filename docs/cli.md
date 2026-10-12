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
$ redline fix fixtures/worst.json --target 100 --max-iterations 5 --attention --out fixed.json

 redline fix  fixtures/worst.json  target 100 · max 5 · claude-sonnet-5-5 (medium) · attention on

  #0  start          5  █░░░░░░░░░       11 errors · 4 warnings
  #1  accepted      97  ██████████  +92  0 errors · 1 warning
        Restack the layout so the headline sits on top, the subheading is smaller, and nothing overlaps. Recolor text for contrast, fix the product ratio, and pull the logo and legal text inside the margins.
        • move logo by (-180, +24) — bring on canvas with margins
        • set headline color to #0f172a — contrast
        • set headline font size to 72px — most prominent
        • move headline by (+0, -120) — clear product overlap
        • resize headline to 900x90 — fit text
        • set subheading font size to 40px — below headline in hierarchy, fits one line
        • set subheading font weight to 600 — calmer
        • set subheading color to #7c4a03 — contrast
        … 11 more
  #2  accepted     100  ██████████  +3   0 errors · 0 warnings
        Align legal text left edge with headline at x=60.
        • move legal by (+6, +0) — Align left edge with headline and body

  ✔ 5 → 100 in 2 iterations · errors 11 → 0 · stop: no issues left
    2 LLM calls · 21.6k in (5.5k cached) / 1.8k out tokens · ≈ $0.054 · 22.6s
    wrote fixed.json (best version: iteration 2)
```

This is a recorded run (the same one the [web app](web-app.md) replays), printed by the tool as is.

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
