# Generation

`redline generate` turns a one-line prompt into a finished, editable design in the [Redline format](design-format.md). It plans the design, generates the images in layers, builds several candidates, scores them with the checker, picks the best, has a vision judge review it, and repairs it with the fix loop.

## Running generate from source

The generate package (`packages/generate`, `@simonlunay/redline-generate`) is **not published to npm**, so run it from a clone. Installing `@simonlunay/redline` and `@simonlunay/redline-agent` does not give you `redline generate`. The workspace links the three packages, and `npm run redline` runs the CLI from source (no build needed):

```bash
git clone https://github.com/simonlunay/redline.git && cd redline
npm install
cp .env.example .env     # set ANTHROPIC_API_KEY and REPLICATE_API_TOKEN (optional: PEXELS_API_KEY)

# Live: Claude plans, FLUX.1 schnell draws (about $0.05 to $0.10 per design, capped by --budget)
npm run redline -- generate "poster for a charity 5K, energetic, blue and orange" --out out/charity.json --render-steps out/steps

# Offline, no keys, no cost: template director, mock images, rule-based fixes
npm run redline -- generate "poster for a charity 5K" --director template --provider mock --editor suggested --out out/charity.json
```

Every example below that starts with `redline generate` means `npm run redline -- generate` in a clone. The output design is a normal Redline file: `npx @simonlunay/redline check out/charity.json` works on it from anywhere.

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

This sample was recorded before the `copy-grounded` check (step 7 below) existed. That check flags the invented date and venue in its copy as errors.

`--render-steps` writes `contact-sheet.png`: every candidate with its score, CTA/headline attention and heatmap, the winner outlined, and the final design after the fix loop. It also writes one annotated PNG (plus heatmap) per candidate and per fix-loop step.

## How it works

```
prompt ──► art director (Claude, JSON output) ──► plan: copy, palette, 2 layouts, image briefs
                                                      │
              ┌───────────────────────────────────────┘
              ▼
   images per slot: background (FLUX.1 schnell / Pexels / yours) · subject (generated on a
   plain backdrop → BiRefNet cutout) · logo and supplied images (used as-is)
              │
              ▼
   N candidates = layouts × background seeds ──► checkAsync (layout + attention + image rules)
              │                                       damaged cutouts are re-cut first
              ▼
   best of N (score, then errors, warnings, CTA attention) ──► vision judge ──► fix loop
              (+ image regeneration) ──► judge again ──► another round while it reports
              something severe (at most 3 judge calls)
```

1. **Art director.** One Claude call returns the design plan as structured JSON output (`output_config.format`, the whole response is the plan). The schema is generated from Zod, with the elements of each layout in per-kind arrays. The plan has the concept, a palette, all the copy, 1 to 3 alternative layouts (element roles, boxes, z-order, text styling) and an image brief per slot. Code then checks what a schema can't, and sends any problems back for **one retry**: exactly one headline, every image element points to a slot, boxes inside the canvas, hex colors, fonts that are actually available, a `calmAreas` description on every background ("keep the top third calm for the headline"), and **no copy inside any image brief**. Text is always a separate, editable text element. The image model is never asked to draw words. The copy must not **invent facts** either (see step 7): a plan whose copy states a date, place, price or similar that the prompt doesn't give also gets the retry, with the list. A retry for that alone never throws away a usable first plan.
2. **Image prompts.** The prompt sent to the image model is built in code: the brief, the art director's calm areas, a description of the text zones computed from the layout's boxes ("Text will be placed over the top 32% (headline, subheading) and the bottom 18%, center side (cta): keep those areas calm…"), the style, and "No text, no letters, no words, no logos". So the text-safe areas are right even when the model's own description is vague.
3. **Layered images.** Every source sits behind one `ImageProvider` interface:
   - **FLUX.1 [schnell]** on Replicate (`REPLICATE_API_TOKEN`), $0.003 per image. Seeds are derived from the prompt, so runs are reproducible.
   - **Pexels** stock search (`PEXELS_API_KEY`), using the slot's short `stockQuery`.
   - **Your images** (`--logo`, `--image`), copied into the assets folder and never modified.
   - A deterministic **mock** (seeded gradients and shapes) used by every test.

   Subjects (a product, a runner, a dog) are generated separately "isolated on a plain light-grey studio background", then cut out and trimmed to their visible pixels, so the element box matches the subject. The cut is made by, in order:
   1. **BiRefNet_lite** locally, through `onnxruntime-node`, when the model loads and at least 7.5 GB of memory is free.
   2. Otherwise **BiRefNet on Replicate** (`men1scus/birefnet`, pinned version, MIT), when `REPLICATE_API_TOKEN` is set and the images aren't mocked. About $0.001 a cutout (billed GPU seconds), guarded by and recorded in the spend ledger. `--cutout hosted` always uses it.
   3. Otherwise a flood-fill keyer removes the plain backdrop.

   Only the hosted model's alpha is used. It's applied to the original pixels and trimmed exactly like a local cut. A BiRefNet cut (local or hosted) is never replaced by a keyed one: the keyer is only for when no model cut is available.

   **Contact shadows.** The art director marks each subject slot `grounding: "surface"` (it rests on a table, floor, pedestal or ground in the scene, which it then also plans into the background brief) or `"floating"`. A cut-out subject on a surface gets a soft contact shadow: a blurred, semi-transparent black ellipse (`blur` on a `decoration` shape) painted directly behind it, in its group. It's deterministic: sized and placed from the subject's footprint, the opaque span of the bottom 12% of the cut. Default opacity 0.5, 22% as tall as it is wide, blurred by 30% of its height.

4. **Best-of-N.** Candidate _i_ uses layout `i mod L` and background variant `⌊i / L⌋`, so the default (4 candidates, 2 layouts) tries both layouts with two different backgrounds each. Subjects are made once per layout. Each candidate is assembled into the design format and scored with `checkAsync`, with layout and attention rules. The winner has the highest score, then fewest errors, then fewest warnings, then the most CTA attention. All candidates are kept.
5. **Fix loop.** The [fix loop](fix-loop.md) runs on the winner, with attention and vision on and a default target of 95.
6. **Image-aware fixing.** In generation mode the loop's editor gets one extra op, `regenerateImage {elementId, brief, reason}`. When an issue comes from the image itself, for example text contrast over a busy area or a background hot spot competing with the CTA, Claude can choose between layout edits (a scrim, moving text) and a new image from a revised brief ("…keep the top-left third plain and dark"). Details:
   - Regenerations run before the layout edits in the same response.
   - The new prompt's text zones come from the _current_ layout.
   - The result is accepted or rolled back like any edit.
   - Regenerations are capped per run (`--max-regenerations`, default 2) and counted when attempted, since they cost money even if rolled back.
   - Each one is recorded in history and in the manifest with its reason and the image it replaced.
   - A second generation-only op, `setShadow {elementId, opacity}`, adds, darkens, lightens or switches off (opacity 0) a subject's contact shadow, which is how the fixer answers the judge's "the product floats" findings. The fixer moves the subject, never the shadow: after every step the loop re-fits each shadow to its subject (`normalize`), so it follows moves, resizes and regenerations.
   - **`redline fix` on your own designs is unchanged.** These ops aren't in its tool schema or prompt, a regeneration request there fails validation, and the guardrail still rejects any change to an image `src`. A test runs `redline fix` with an editor that asks to regenerate and checks that every `src` is untouched.
7. **Content faithfulness (`copy-grounded`).** Generated copy is checked against the prompt (and any `--image` descriptions). Dates, weekdays, times, prices and discounts, numbers, phone numbers, URLs, emails, `@handles`, places ("· City Park", "at Riverside Park") and names ("featuring DJ Nova", "Acme Inc.") that the prompt doesn't give are an **error** (weight 3), so such a design can't reach the target. Other spellings of a given fact count as given ("June 14th" = "Sat 6/14", "9am" = "9:00 AM", "$2" = "$2.00"), and bracketed placeholders like `[Date]` are never flagged.
   - The fix loop gets a third generation-only op, `replaceText {elementId, find, replace}`. It may only replace flagged facts (plus their separators) with a placeholder or nothing. Anything else, like rewriting the headline, is refused. `redline fix` still has no op that can touch copy.
   - It's pattern-based on purpose: deterministic, free and testable. It doesn't know arbitrary proper nouns, so an invented venue without a place word ("Riverside") gets through, and a title-case headline starting with a place word isn't flagged ("Farmers Market"), to avoid false alarms.
8. **Image checks.** `image-text` and `cutout-quality` (see [Image checks and the vision judge](judge-and-image-checks.md#image-rules)) run on every generated and stock image, so they count in best-of-N and in the fix loop. A damaged keyed cutout is re-cut with two other keyer settings before it is used, and the best cut is kept. A BiRefNet cut is never re-cut, and its `cutout-quality` verdict is at most a warning. The fixer's prompt says these issues come from the pixels, so a regeneration is the expected fix.
9. **Vision judge.** Claude Opus 5.5 reviews the winner's clean render and reports visible defects the rules can't see. Its findings become `visual-judge` issues for the fix loop, and it reviews the result again (see [Vision judge](judge-and-image-checks.md#vision-judge)). Its verdicts and findings go into `.generation.json` and the CLI output.
10. **Reliability.** Every Replicate request (create, poll, download) has its own timeout, and each image has a 5-minute deadline that retries and rate-limit waits respect. An art-director plan whose layouts came back empty gets a third, more specific try at low effort. If only some layouts are usable, the plan keeps those. If no try works, it fails with an `ArtDirectorError` listing each try's problems.

### Assembly details

- The background fills the canvas with `fit: cover`, so any generated size works.
- Subjects, logos and supplied images get the largest box with their **real** aspect ratio inside the planned box (`fit: contain`). They're never stretched.
- CTA labels are snapped to their text's real height and centered in their button. Text renders from the top of its box, so a label box that fills its button sits visibly high. The `label-centered` rule catches that too, so the fix loop re-centers a label it has moved, and `redline check` / `redline fix` catch it in your own designs.

## Output files

`--out poster.json` writes:

| Path                          | Contents                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `poster.json`                 | The final design (relative image paths)                                                                                |
| `poster.assets/`              | Every image file                                                                                                       |
| `poster.assets/manifest.json` | Per image: prompt, provider, model, seed, cost, license, cutout model and license, and the reason for any regeneration |
| `poster.candidates/*.json`    | Every candidate as a standalone design you can `redline check`                                                         |
| `poster.generation.json`      | The plan, every candidate's score and attention, the ranking, the full fix-loop history, and the spend                 |

## CLI

```bash
redline generate "<prompt>" [options]
```

| Option                                                | Description                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `--out <path>`                                        | Design to write (default `generated/<slug>.json`)                                            |
| `--size <WxH>`                                        | Canvas size (default `1080x1350`)                                                            |
| `--candidates <n>`                                    | Candidates to build and score (default 4, max 12)                                            |
| `--layouts <n>`                                       | Distinct layouts among them (default `min(2, candidates)`)                                   |
| `--target <score>`                                    | Fix-loop target, with no errors (default 95)                                                 |
| `--max-iterations <n>`                                | Fix-loop iterations (default 4)                                                              |
| `--max-regenerations <n>`                             | Image regenerations the fix loop may use (default 2, `0` = layout edits only)                |
| `--render-steps <dir>`                                | Contact sheet, candidate renders and per-step PNGs + heatmaps                                |
| `--provider <name>`                                   | `replicate`, `pexels` or `mock`. Default: the first one with a key, otherwise `mock`         |
| `--cutout <name>`                                     | `auto` (local BiRefNet, then hosted, then keying), `hosted`, `birefnet`, `key`, `none`       |
| `--director <name>`                                   | `anthropic` (default) or `template` (offline, deterministic)                                 |
| `--editor <name>`                                     | `anthropic` (default) or `suggested` (offline)                                               |
| `--model`, `--effort`                                 | Claude model and effort for the art director and the fix loop (default Sonnet 5.5, `medium`) |
| `--brand-colors <list>`                               | Hex colors the plan must use                                                                 |
| `--font <Family=path>`                                | Register a font file the plan may use (repeatable; Inter is bundled)                         |
| `--logo`, `--image <path>`                            | Your logo / images; used as supplied                                                         |
| `--budget <usd>`                                      | Spend cap for this run (default $2); paid calls that could cross it are refused              |
| `--ledger <path>`                                     | Persistent spend ledger, so a cap holds across runs                                          |
| `--judge <name>`                                      | `anthropic` (default when `ANTHROPIC_API_KEY` is set) or `none`                              |
| `--judge-model <id>`                                  | Model for the vision judge (default `claude-opus-5-5`, not the fixer's model)                |
| `--judge-rounds <n>`                                  | Re-judgments after a fix loop (default 2, so at most 3 judge calls)                          |
| `--no-image-checks`                                   | Skip the image rules (text drawn into images, damaged cutouts)                               |
| `--seed`, `--no-attention`, `--no-vision`, `--format` | As expected                                                                                  |

Fully offline (no keys, no cost): `redline generate "…" --director template --provider mock --editor suggested`.

**Spend control.** Every paid call goes through a spend ledger. Before a call, the ledger checks a worst-case estimate against the cap; after it, the ledger records the real cost. A Claude call's worst case is priced at 30k input + 16k output tokens. For images, crossing the cap switches to the mock provider for candidates, or refuses a regeneration. In the fix loop, it stops the loop with `editor-error`. Image calls running in parallel count against the cap while they're in flight, so they can't all slip past it at once.

## Models and licenses

| Model                        | Used for                                       | License                                                                                                                                                                                                                                                      | How it's obtained                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Sonnet 5.5 (default)  | Art director, fix loop                         | Anthropic API terms                                                                                                                                                                                                                                          | API (`ANTHROPIC_API_KEY`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Claude Opus 5.5              | Vision judge                                   | Anthropic API terms                                                                                                                                                                                                                                          | API (`ANTHROPIC_API_KEY`), $4 / $20 per M tokens, about $0.02 per review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| FLUX.1 [schnell]             | Backgrounds and subjects                       | **Apache-2.0**: the model card says it "can be used for personal, scientific, and commercial purposes" ([license](https://github.com/black-forest-labs/flux/blob/main/model_licenses/LICENSE-FLUX1-schnell), checked 2026-10-06)                             | Hosted on Replicate, `black-forest-labs/flux-schnell`, $0.003/image                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| BiRefNet_lite                | Subject cutouts                                | **MIT** ([ZhengPeng7/BiRefNet_lite](https://huggingface.co/ZhengPeng7/BiRefNet_lite)); see [NOTICE](../NOTICE) for training-data caveats                                                                                                                     | ONNX from [`onnx-community/BiRefNet_lite-ONNX`](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) at commit `de15b22`, 224,005,088 bytes, SHA-256 `56000243…f03333`. Downloaded from Hugging Face into the Redline cache on first use (not re-hosted), verified before use, about 7 s per cutout on a 20-thread laptop CPU. **Needs about 6 GB of free memory** for one inference (fixed 1024×1024 input; fp16 weights don't lower it on CPU). Memory is returned after each cutout, cutouts never run in parallel, and with less than 7.5 GB free (`REDLINE_CUTOUT_MIN_FREE_MB`) the hosted model or the backdrop keyer is used for that cutout instead |
| BiRefNet (hosted)            | Subject cutouts, when local BiRefNet can't run | **MIT** ([code](https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE), [weights `ZhengPeng7/BiRefNet-legacy`](https://huggingface.co/ZhengPeng7/BiRefNet-legacy), checked 2026-10-11); same training-data caveats as BiRefNet_lite ([NOTICE](../NOTICE)) | Called as an API on Replicate, [`men1scus/birefnet`](https://replicate.com/men1scus/birefnet) pinned at version `f74986db`. A community wrapper, not an official model, with no published source. A100 80GB at $0.0014/s; a cutout takes 0.5 to 2 s, so about $0.001. The subject is uploaded to Replicate's file store and deleted after the cut                                                                                                                                                                                                                                                                                                                |
| PP-OCRv5 mobile det + en rec | `image-text` check                             | **Apache-2.0**                                                                                                                                                                                                                                               | See [Image checks](judge-and-image-checks.md#models-and-licenses)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| MSI-Net                      | Attention check                                | MIT                                                                                                                                                                                                                                                          | See [Attention check](attention.md#model-and-license)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Pexels (optional)            | Stock backgrounds                              | [Pexels License](https://www.pexels.com/license/)                                                                                                                                                                                                            | API (`PEXELS_API_KEY`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Results

On 14 prompts with every check on, the judge would ship 9 of the 14 final designs. Per-prompt tables, costs and every miss are in [Evaluation](evaluation.md#generation).

## Limits

- **The rules and the judge both have blind spots.** A design that passes every rule and that the judge ships is likely clean, not guaranteed: see the misses in [Image checks and the vision judge](judge-and-image-checks.md#limits) and the [generation results](evaluation.md#generation).
- **Fonts:** only Inter is bundled. The art director can use other families only if you register them with `--font`.
- **Cutouts** are as good as BiRefNet on a plain backdrop: fine for products, people and animals, weaker on thin structures. The keying fallback leaves halos on shadows.
- **Contact shadows are a black ellipse, not real light.** They show on light and mid-tone ground and vanish on black or under a panel that covers the subject's base. They don't fix a lighting mismatch (a front-lit subject on a backlit scene), which is the judge's most common note on a composited subject.
- **`cutout-quality` was tuned on keyed cutouts.** On BiRefNet cuts it still raises false `leftover-backdrop` and `bites` flags, but only as warnings.
- **FLUX schnell** sometimes ignores parts of the brief, including "no text". The calm-area instruction is a request, not a guarantee, which is exactly what the regeneration op and the contrast rule are there to catch.
- **The judge reviews only the winner.** Best-of-N still picks by rule score (including the image rules), so two candidates that both score 100 are a tie broken by warnings and CTA attention. The judge then reviews whichever won.
