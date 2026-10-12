# Image checks and the vision judge

The layout rules can't see what's _inside_ an image. In the first [generation eval](evaluation.md#generation-run-1-baseline-pipeline), 3 of 12 winners scored 100 and still looked wrong: the image model had drawn a gibberish "button" into a photo, and two cut-out products had bites and see-through holes. Two layers catch this:

1. **Two image rules** (deterministic, local, free): `image-text` and `cutout-quality`.
2. **A vision judge** (`redline generate` only): a different model looks at the finished render and reports what looks wrong.

## Image rules

```bash
npx redline setup image-checks                 # once: downloads + verifies the text detector
npx redline check ad.json --image-checks       # your own design: image issues are warnings for your photos
npx redline fix ad.json --image-checks         # reported, not fixed (redline fix never changes images)
```

They're an opt-in rule set (`imageRules`) like the attention rules. `redline generate` turns them on for every generated and stock image, and never checks the user's own images.

| Rule             | Flags                                                                                                            | Severity                                                       | Suggested fix                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `image-text`     | Lettering, fake signs, labels or buttons drawn into an image, where they're visible in the design                | error for generated/stock images (weight 3), warning for yours | Regenerate the image with "absolutely no text, lettering, signs, labels, buttons…"      |
| `cutout-quality` | A cut-out subject with bites or tears, see-through patches, stray fragments, leftover backdrop, or no cut at all | error or warning (weight 2)                                    | Re-cut it (BiRefNet), or regenerate the subject on a plain, evenly lit, opaque backdrop |

### `image-text`

Each image runs through PaddleOCR's **PP-OCRv5 mobile text detector** (DBNet, 4.8 MB), using the preprocessing from the model's own config. Every detected box is then read by the matching **English PP-OCRv5 recognizer**. A box only counts as text when it reads as at least 3 characters with a mean confidence of at least 0.8. No dictionary is needed: CTC decoding counts the non-blank steps, so gibberish counts as text too.

The verifier is there because the detector alone fires on rows of trees and crates of oranges. On the 48 backgrounds of the first generation eval plus the 10 fixture photos, the detector found boxes in 27 of the 58 images, and only the yoga pill survived the verifier. The yoga pill reads as 21 characters at 0.98 confidence; the row of trees reads as 4 at 0.71.

Boxes are mapped from image pixels to the canvas through the element's `fit`. Boxes under an opaque rectangle painted above the image, and very small marks (under 1.2% of the canvas's short side), are ignored.

### `cutout-quality`

It measures the cutout's alpha, and the backdrop color when the pipeline knows it (otherwise it's estimated from the soft edge). It's pure TypeScript and isomorphic:

| Signal            | Measured as                                                                             | Catches                                        |
| ----------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------- |
| bites             | area a morphological closing (radius 1.5% of the subject) adds, relative to the subject | tears and notches in a keyed edge              |
| see-through       | partly transparent pixels well inside the subject                                       | glass or frosted parts keyed away              |
| fragments         | small detached opaque pieces                                                            | stray bits of backdrop or torn-off edges       |
| leftover backdrop | flat, near-neutral, backdrop-colored regions                                            | slabs under a subject, discs inside a headband |
| uncut             | the subject runs along 3+ sides of the image                                            | a photo that was never cut out                 |
| jagged edges      | outline length against a smoothed outline                                               | ragged keyer edges                             |

An error needs a signal past its error level, two stray fragments, or two warnings at once. Leftover backdrop alone is only a warning, because a flat white laptop screen or white cup looks the same in pixels as a grey disc of backdrop. It becomes an error only when another signal backs it up.

The thresholds were tuned on the 26 subject cutouts of the first generation eval, labeled by eye first. On those 26: **7 of 9 damaged cutouts are errors, the other 2 are warnings, and none of the 17 good ones is an error**; 2 good ones get a warning. They were tuned on the same images they're scored on, so expect worse on new ones.

In `redline generate`, a keyed cutout that measures as damaged is **re-cut on the spot** with a tighter and a looser keyer. That costs no API call and takes a second or two. Whichever cut measures best is kept, and the manifest records the verdict and the re-cuts.

**On cuts by a segmentation model (BiRefNet), every `cutout-quality` flag is a warning, never an error,** and the cut is never re-cut. The thresholds were tuned on keyed cutouts. On BiRefNet cuts in the [hosted-cutout eval](evaluation.md#generation-run-3-hosted-birefnet-cutouts), all 7 of the rule's flags on 21 cuts were false alarms: subjects colored like the backdrop (a white cat, a white laptop screen, cream clothing, a white dropper bulb) read as leftover backdrop, and stepped outlines (a dropper bottle's collar, a laptop's hinge) read as bites. As errors, they once swapped a clean bottle for a keyed one without its dropper, and then outvoted the judge in the final pick. Those six cuts are now tests (`packages/checker/test/fixtures/cutouts/`). The image analyzer is told what made each cut (`cutoutSource`).

## Vision judge

In `redline generate` (on by default when `ANTHROPIC_API_KEY` is set; `--judge none` turns it off):

```
best-of-N winner ──► judge ──► fix loop ──► judge ──► (still something severe?) fix loop ──► judge
```

- **What it sees:** the **clean** render (no annotations; the long side scaled to 1024 px), the element table (ids, roles, boxes, text), the rules' open issues so it reports what they missed, and the user's prompt.
- **What it never sees:** the fixer's reasoning or edit summaries, the history, the art director's plan, or any score. A test checks that.
- **Independence:** it uses **Claude Opus 5.5** by default (`--judge-model`), while the fixer and art director use Sonnet 5.5. It has its own system prompt and a fresh, stateless request each time. No server-side model fallback is enabled, so a refusal can't quietly hand the verdict to another model.
- **What it returns:** structured JSON (validated with Zod, retried once if invalid). That's a verdict (`ship`, `fix` or `reject`), a one- or two-sentence summary, and findings. Each finding has a category, a severity, an element, an optional box, a description and a suggested fix:
  - categories: `fake-text`, `cutout`, `artifact`, `cropping`, `color`, `composition`, `legibility`, `other`
  - suggested fixes: `regenerate-image`, `recut`, `layout`, `none`
- **Findings become `visual-judge` issues:**
  - Severity maps as high → error, medium → warning, low → info (weight 2).
  - The fixer acts on them like any issue, including regenerating the image.
  - The judge can't run on every re-check, so each finding is tied to a fingerprint of its element. It stays while the element is unchanged and is suspended once the element changes (a design-level finding: once anything changes). Then the **next judgment decides** whether the fix worked. Nudging an element can't fake a fix.
  - Bracketed placeholders like `[Date]` are intentional, and the judge is told not to report them.
- **Rounds:** another fix round runs only while the judge still reports something high-severity. That's at most 3 judge calls per design (`--judge-rounds 2`). The regeneration cap is shared across rounds.
- **Cost:** about $0.015 to $0.03 per review with Opus 5.5 at `medium` effort. The image is about 1.4k tokens.

### Blind pairwise mode

`comparePair`, used by `npm run eval:pairwise`, compares two renders for evaluation:

- The judge sees **only the two images and the brief**, as "Image 1" and "Image 2": no labels like before/after, no issues, no rules, no scores.
- Each pair is judged **in both orders**. Which one goes first is shuffled with a seeded RNG.
- A side wins only when both orders agree. Otherwise it's a tie, which cancels position bias.

## How well it works

Three measurements; the numbers and every miss are in [Evaluation](evaluation.md):

1. **[Replay against hand labels](evaluation.md#image-checks-and-judge-against-hand-labels)** on the first generation eval's 48 candidates and 12 winners: the image rules caught all 4 broken winners with no false alarms, and `cutout-quality` flagged 16 of 20 damaged candidates as errors with 0 false errors.
2. **[Blind pairwise](evaluation.md#blind-pairwise-judge)** on the fix-loop eval: the fixed version won 40 of 42 pairs, the original won 0.
3. **[Generation with everything on](evaluation.md#generation-run-2-image-checks-and-judge-on)**: the judge flagged 9 of 14 winners, the loop ran on 9, and the judge shipped 6.

## Limits

- **The text detector reads lettering, not every mark.** It missed neon-sign letters drawn vertically on a wall and very faint gibberish along the bottom of a SaaS background. The judge caught the second.
- **Product UI mocks contain text on purpose.** A generated laptop screen's kanban labels are flagged as `image-text`.
- **The cutout signals are measured on 26 images** from one eval, all made by the backdrop keyer, because the eval machine rarely had the ~7.5 GB free that local BiRefNet needs. They weren't tuned on BiRefNet cutouts.
- **The judge is a model, not a ground truth.** Its findings vary from run to run, and it sometimes puts a finding in the wrong category (it called the yoga gibberish button "composition" rather than "fake-text"). It also has its own tastes: "the bottom of the panel is a little empty" comes up as a low-severity finding.
- **The judge doesn't see the fixer's reasoning, but it does see the checker's issues.** Its in-loop findings are independent of the fixer, not of the rules. The pairwise mode is independent of both.

## Models and licenses

| Model                        | License                                                                                                                                                                                                                                | How it's obtained                                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PP-OCRv5 mobile det + en rec | **Apache-2.0** ([det](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx), [rec](https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx), checked 2026-10-08); see [NOTICE](../NOTICE) for the training-data caveat | Official ONNX exports from Hugging Face at commits `e6f4fa8` (4,826,518 bytes, SHA-256 `a4319856…b6e61d`) and `3fafbc3` (7,848,423 bytes, SHA-256 `b5f833df…abc557f`). Downloaded on first use (`redline setup image-checks`), verified, not re-hosted. About 0.2 to 0.4 s per image on a laptop CPU |
| Claude Opus 5.5 (judge)      | Anthropic API terms                                                                                                                                                                                                                    | API (`ANTHROPIC_API_KEY`), $4 / $20 per M tokens, about $0.02 per review                                                                                                                                                                                                                             |
