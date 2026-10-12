# Phase 5b report: hosted BiRefNet cutouts

Two parts: part 1 adds hosted BiRefNet and measures it; [part 2](#part-2-model-cuts-kept-contact-shadows) keeps model cuts, caps their `cutout-quality` verdicts and adds contact shadows.

Branch `phase-5b-cutouts` (from `main` at `aa11816`). Not pushed, not merged. Run date: 2026-10-11 (UTC 2026-10-12).

## TL;DR

- **What got built:** BiRefNet on Replicate as a third cutout path, behind the existing `BackgroundRemover` interface.
  - The auto remover tries local BiRefNet_lite first, then hosted BiRefNet (when memory is short or the local model can't load), then the keyer.
  - `--cutout hosted` forces it, in `redline generate` and in `eval:generate`.
  - Local BiRefNet is unchanged. **316 tests pass** (10 new, all mocked); lint and typecheck are clean.
- **License:** `men1scus/birefnet` is MIT on both counts: code (`ZhengPeng7/BiRefNet`) and weights (`ZhengPeng7/BiRefNet-legacy`). It's a community wrapper, not an official Replicate model, and its packaging source isn't published. The training-data caveat is the same as for the local model (NOTICE).
- **The judge would ship 8 of 14, against 6 of 14 in phase 5.** headphones, pizza, sneaker and bookstore are shipped; saas no longer is.
- **The hosted cuts are clean, and cutout defects are almost gone.** In phase 5, all 8 designs the judge didn't ship had a keyed-cutout defect. Now 1 of the 6 does: skincare. That one is a keyed cut the pipeline chose _over_ a clean hosted one, because of a false `cutout-quality` error (below).
- **The new bottleneck is compositing, not cutting.** 3 of the 6 unshipped designs are "the subject floats like a sticker, no contact shadow" (coffee, pet, saas). 2 aren't about subjects at all: fake text on race bibs, and a grey wash.
- **`cutout-quality` doesn't hold up on BiRefNet cuts:**
  - BiRefNet's soft edges trigger none of the edge signals.
  - But it raised 7 flags on 21 hosted cuts, 3 of them errors, and **all 7 are false alarms by eye**: backdrop-colored subjects, and natural steps in an outline.
  - On skincare, the false errors first swapped a clean bottle for a keyed one with no dropper. Then they made the final pick reject the loop's clean regeneration. The design that shipped is the headless bottle.
- **Spend: $1.31 of the $3 budget**, all in `packages/generate/eval/results/spend-ledger-phase5b.json`. 22 hosted cutouts in the eval cost $0.0295 ($0.0013 each, max $0.0021).

## What got built

| Piece              | Where                                                    | Notes                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replicate client   | `packages/generate/src/providers/replicate-client.ts`    | The retry, timeout, deadline and rate-limit code, moved out of the FLUX provider unchanged (its 10 tests pass untouched), plus a file upload. One client can be shared so a learned rate limit spaces both kinds of request       |
| Hosted remover     | `createReplicateBiRefNetRemover` in `src/node/cutout.ts` | Uploads the subject, runs the pinned version, deletes the upload, keeps only the returned alpha and applies it to the original pixels, then trims like a local cut. Guarded at $0.01 and recorded at billed GPU seconds × $0.0014 |
| Auto remover       | `createAutoRemover` in `src/node/cutout.ts`              | Local → hosted → keyer. `hosted` and `forceHosted` options; `onFallback(reason, usedRemover)`; a hosted failure falls through to the keyer with both reasons                                                                      |
| CLI                | `--cutout hosted`; `auto` gains the hosted step          | Auto only uses the hosted cutout when `REPLICATE_API_TOKEN` is set and images aren't mocked, so offline runs never spend money on cutouts                                                                                         |
| Eval               | `eval:generate --cutout auto\|hosted\|local\|key`        | Default `auto`. The summary counts cutouts by remover                                                                                                                                                                             |
| Tests (mocks only) | `test/cutout.test.ts`, `test/generate-command.test.ts`   | Routing (low memory, enough memory, hosted failure, forced), the HTTP contract (upload, pinned version, delete, token never in the body), cost recording, the spend guard refusing before any request, the alpha path             |

**Why this model.** It's the same family as the local path (BiRefNet), so cuts are comparable and the phase 5 thresholds are meaningful. Two other candidates were ruled out on license:

- `lucataco/remove-bg` ships BRIA RMBG-1.4 (non-commercial).
- `bria/remove-background` has no published license terms on its model page.

**Probe before writing code** (one call, $0.0007): the model returns an RGBA PNG at the input size, with a soft alpha matte, in 0.5 s on an A100.

## The eval

Same settings as phase 5's final run: Sonnet 5.5 (`medium`) director and fixer, Opus 5.5 judge with 2 rounds, 4 candidates, target 95, 4 iterations, 2 regenerations, `--concurrency 1`, `--cutout auto`.

The machine had 0.6–3 GB free throughout, so the auto remover sent every cutout to Replicate.

Results files:

- `packages/generate/eval/results/2026-10-12T01-50-47-382Z_generate_phase5b-hosted.json`: sneaker-drop.
- `…T01-57-32-671Z_generate_phase5b-hosted-rest.json`: the other 13.

| Prompt            | Phase 5 judge            | Phase 5b judge  | Final (rules) | It  | Regen | Subject cutouts (hosted, `cutout-quality` verdict)                    | What still looks wrong (judge, checked by eye)                                   | Cost   |
| ----------------- | ------------------------ | --------------- | ------------- | --- | ----- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| charity-5k        | reject → fix             | fix → fix       | 92            | 3   | 1     | none (the winning layout used a photo background only)                | Gibberish race-bib numbers (medium)                                              | $0.135 |
| coffee-latte      | reject → reject → reject | **fix**         | 93            | 2   | 0     | 2 ok                                                                  | The glass floats in mid-air, no table or shadow (medium)                         | $0.092 |
| sneaker-drop      | fix → fix                | **ship**        | 99            | 0   | 0     | 2 ok                                                                  | (low: no grounding shadow)                                                       | $0.063 |
| saas-banner       | ship → ship              | fix → fix       | 87            | 3   | 1     | 2, both warnings (false alarms: screen color, hinge step)             | The laptop floats over the desk, perspective off (medium)                        | $0.103 |
| jazz-night        | ship → fix               | ship            | 97            | 0   | 0     | 1 ok                                                                  | –                                                                                | $0.060 |
| summer-sale       | fix → fix                | fix → fix       | 85            | 4   | 0     | 1 ok                                                                  | The fixer's grey scrim washes out the photo (medium, color)                      | $0.129 |
| farmers-market    | fix → ship               | fix → ship      | 100           | 1   | 0     | none                                                                  | –                                                                                | $0.077 |
| headphones-launch | fix → reject → reject    | **fix → ship**  | 100           | 1   | 0     | 2 ok (the headband interior is clean, no grey disc)                   | –                                                                                | $0.073 |
| yoga-retreat      | ship → ship              | ship            | 100           | 0   | 0     | 1, warning (false alarm: cream clothing)                              | –                                                                                | $0.045 |
| pizza-delivery    | fix → fix                | **ship → ship** | 99            | 1   | 0     | 2 ok (no plate rim)                                                   | –                                                                                | $0.083 |
| tech-conference   | ship → ship              | ship            | 99            | 0   | 0     | 1 ok                                                                  | –                                                                                | $0.054 |
| pet-adoption      | reject → fix → fix       | fix → fix       | 93            | 1   | 1     | 3: 2 ok, 1 warning (false alarm: white cat)                           | The animals hover with no ground or shadow (medium)                              | $0.103 |
| skincare-serum    | fix → fix → fix          | fix → fix       | 70 (1 err)    | 4   | 2     | 3, **all errors (all false alarms)**; one was replaced by a keyed cut | **The shipped bottle has no cap or dropper** (high): the keyed re-cut, see below | $0.150 |
| bookstore-event   | ship → ship              | **fix → ship**  | 100           | 1   | 0     | 1 ok                                                                  | –                                                                                | $0.073 |

|                                        | Phase 5 (14 prompts) | Phase 5b                                    |
| -------------------------------------- | -------------------- | ------------------------------------------- |
| Judge would ship                       | 6                    | **8**                                       |
| Unshipped designs with a cutout defect | 8 of 8               | **1 of 6** (a keyed cut, chosen by mistake) |
| Regenerations                          | 15 (14 for cutouts)  | 5                                           |
| Fix-loop iterations                    | 31                   | 21                                          |
| Cost per design                        | $0.113               | $0.089                                      |

**How much to trust 8 vs 6:** it's one run of 14 prompts, and phase 5 measured the judge saying ship and then fix about the same pixels. The prompt-level change is the stronger evidence:

- every phase 5 rejection that named a keyed-cutout defect is gone;
- regenerations, which the loop used to spend on keyed subjects, fell from 15 to 5.

saas-banner went the other way: it shipped in phase 5 with a different design (the director's plans differ run to run), and this time the laptop floats.

## Do the `cutout-quality` thresholds hold up on BiRefNet edges?

I put every subject cutout in the manifests on magenta (the phase 5 labeling method) and checked every flagged one at full size, with its alpha map.

- That's 20 hosted cuts, plus the 1 keyed cut on skincare.
- I also re-ran the one hosted cut that was replaced, on the same FLUX image ($0.0012, tagged `diagnosis` in the ledger), so I could see it.
- That makes 21 hosted cuts in all.

| Signal                         | Fired on the 21 hosted cuts                          | Real defect by eye                                                                                 |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| see-through, jagged, fragments | 0                                                    | –                                                                                                  |
| `leftover-backdrop`            | 4 (3 alone as warnings, 1 alongside a `bites` error) | **0**: a white cat, a white laptop screen, cream clothing, a white dropper bulb. All subject color |
| `bites`                        | 4 (3 errors, 1 warning)                              | **0**: every alpha mask is solid. The closing fills natural steps in the outline (bottle, laptop)  |
| Any flag                       | **7 of 21, 3 errors**                                | 0                                                                                                  |

- **Soft edges: the thresholds hold.** BiRefNet's anti-aliased matte trips none of the edge signals.
- **Shape and color: they don't.**
  - `bites` closes the mask with a radius of 1.5% of the subject's size. On a dropper bottle (narrow bulb, wider collar, wider shoulder) and on a laptop (screen meets a wider base), that fills legitimate steps in the outline. Skincare's first cut measured 7.5% against an error limit of 5.5%.
  - `leftover-backdrop` can't tell a backdrop-colored subject from leftover backdrop. This was known for the laptop in phase 5, and it's now the most common flag.
- **On skincare, the false errors decided the design twice:**
  1. **At cutout time.** The clean hosted cut measured as an error, so `cutOutWithQualityCheck` re-cut with the two keyer settings and kept the better-measuring one (a warning): a bottle with its white dropper keyed away. The judge's first review: "no cap or dropper bulb… looks unfinished and malformed" (high).
  2. **At the final pick.** The loop regenerated the bottle, and the new hosted cut was clean, dropper and all. The judge's second review dropped the artifact and asked only for a contact shadow (medium). But that cut also measured as a `cutout-quality` error. The final pick counts rules errors, so it kept round 0's design. **The design that shipped is the headless bottle**, rules score 70.

**Recommendation (done in [part 2](#part-2-model-cuts-kept-contact-shadows), the first and third points):**

- Don't let a keyer re-cut replace a model cut. When the first cut came from BiRefNet, local or hosted, keep it and just report the verdict.
- Make `bites` relative to the subject's local width rather than its overall size, or require a second signal before it becomes an error, the way `leftover-backdrop` already does.
- Downgrade `cutout-quality` to a warning on BiRefNet cuts until it's re-tuned on them, so it can't outvote the judge in the final pick. The 20 hosted cuts in this run, with verdicts in the manifests, are a starting label set.

## What went wrong with the run

- **Run 1** (`…T01-50-47-382Z_generate_phase5b-hosted.json`):
  - charity-5k failed: the art director returned an empty layout on all 3 tries, the known phase 5 flake.
  - coffee-latte failed: Replicate failed a **FLUX** prediction server-side (`Director: unexpected error handling prediction (E9828)`). The hosted cutout for its subject had already succeeded. The FLUX provider retries HTTP and network errors but not a prediction that comes back `failed`. This was true before this branch.
  - sneaker-drop completed.
  - Then free memory fell to 764 MB, and the eval's own guard (I had set it to 1000 MB) skipped the other 11 prompts.
- **Run 2** (the 13 other prompts, guard lowered to 300 MB):
  - Physical memory was tight, but there were 24.7 GB of commit headroom, and the process peaked around 0.9 GB with no local model loaded.
  - charity-5k and coffee-latte both completed this time.
  - During skincare-serum, Claude Code reported that it had stopped the background run because the system was critically low on memory (other apps held about 14 of 16 GB). That only stopped the wrapper shell, though: the eval's node process kept going.
  - The eval finished all 13 prompts and wrote its results file normally. I noticed from its log, checked that it was the same process, and let it finish its last prompt, since it was within budget and memory had recovered to about 3 GB.

## Spend

**$1.31 of $3**, itemized in `packages/generate/eval/results/spend-ledger-phase5b.json` (173 entries):

| Item                                   | Cost    |
| -------------------------------------- | ------- |
| Probe call before writing the code     | $0.0007 |
| CLI smoke test (forced hosted cutout)  | $0.0071 |
| Eval run 1 (1 design + 2 failures)     | $0.127  |
| Eval run 2 (13 designs)                | $1.177  |
| Diagnosis re-cut of the skincare image | $0.0012 |

By kind: art director $0.37, judge $0.34, fix loop $0.32, FLUX $0.25, **hosted cutouts $0.031**.

The smoke test created the ledger with a $0.10 cap, and file-ledger caps only go down. I reset it to $3 by hand before the eval and added the probe call, which had run outside the ledger.

## Part 2: model cuts kept, contact shadows

Run date: 2026-10-12 (UTC). Commits `cdc5acc`, `79c7208` and `9af86a2` on the same branch. You approved the part 1 recommendations and asked for contact shadows.

### What changed

| Change                                            | Where                                                                       | Notes                                                                                                                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A model cut is never re-cut                       | `cutOutWithQualityCheck`, `RemoverKind`                                     | Removers declare `kind` (`model` or `keyer`), and each cut carries it (the auto remover chooses per cut). Only a keyed cut gets keyed re-cuts                                                                                         |
| Model-cut verdicts capped at a warning            | `judgeCutout({ source })`, image analyzer `cutoutSource`, `markImage`       | In the checker, so the pipeline's own assessment, the analyzer and the rule agree. The rule's message says the signal is often a false alarm on a model cut                                                                           |
| The six false alarms as tests                     | `packages/checker/test/cutout-model-cuts.test.ts`, `test/fixtures/cutouts/` | White cat, white laptop screen, cream clothing, white dropper, dropper bottle collar, laptop hinge: real BiRefNet cuts from part 1, with provenance in `SOURCES.md`. Each fires its signal, and each is only a warning as a model cut |
| `blur` on shapes                                  | design schema, renderer                                                     | Gaussian blur radius in px, default 0. Rules still use the box                                                                                                                                                                        |
| Contact shadows                                   | `src/shadow.ts`, `assembleDesign`, `measureFootprint`                       | Deterministic: a black ellipse sized from the subject's footprint (the opaque span of the bottom 12% of the cut), painted directly behind it in its group                                                                             |
| The director decides per subject                  | plan slot `grounding` (`surface` or `floating`), director prompt            | For `surface` the director also plans the surface into the background brief and puts the subject's base on it                                                                                                                         |
| `setShadow {elementId, opacity}`                  | agent `SetShadowEditSchema`, loop `shadows` option, editor prompt           | Generation mode only. Opacity 0 switches a shadow off (the loop's guardrail forbids removing elements). The prompt maps the judge's "floats / no contact shadow / pasted on" findings to it                                           |
| Shadows follow their subject                      | loop `normalize` hook, `syncContactShadows`                                 | After every step's edits, before the check: a moved, resized or regenerated subject keeps its shadow under it                                                                                                                         |
| Grouped shadows aren't competitors                | `attention-competition`, `isBacking`                                        | A decoration in the same group as the content above it counts as part of it, like a backing panel                                                                                                                                     |
| The record keeps the loop's copy and shadow edits | `serializeResult`                                                           | It only kept regenerations, so this run's records lack `shadowEdits`. I recovered them from each step's stored design                                                                                                                 |

**Tests: 345, all passing** (316 at the end of part 1, plus 29). Lint, typecheck and build are clean.

- **One flaky failure under load:** `is reproducible` once produced different scores for one candidate (63 vs 71) during a full-suite run. It passed in 3 isolated runs, 3 runs of its file and the next 2 full-suite runs. I couldn't reproduce it, so I'm reporting it rather than claiming it's fixed.

### The eval

Same settings as part 1, on a new ledger (`spend-ledger-phase5b-shadows.json`, capped at $2), `--cutout auto`. The machine had 2.6–4 GB free, so all 30 cutouts were hosted BiRefNet.

**First run** (`2026-10-12T03-00-16-784Z_generate_phase5b-shadows.json`, at `cdc5acc`): 13 of 14 completed.

- skincare-serum failed on the same Replicate FLUX server error as in part 1 (`E9828`). I re-ran it on its own (`…T03-32-59-260Z_generate_phase5b-shadows-skincare.json`).

"Judge" is the verdict on the design that shipped. The eval's own counter says 8/13, because it uses the last verdict: saas-banner went ship → fix, and the final pick kept the round-0 design the judge shipped. That's how phase 5 counted jazz-night too.

| Prompt            | Part 1 judge | Part 2 judge | Final (rules) | Subject grounding → shadow                        | What still looks wrong (judge, checked by eye)                                                                              |
| ----------------- | ------------ | ------------ | ------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| charity-5k        | fix          | **ship**     | 100           | floating → none                                   | –                                                                                                                           |
| coffee-latte      | fix          | fix          | 82            | surface → 0.35, raised to 0.7 by the fixer        | The glass is huge and front-lit against a backlit window; its base sits behind the panel, where no shadow can show (medium) |
| sneaker-drop      | ship         | ship         | 98            | floating → none                                   | (low: fake lettering on the tongue label)                                                                                   |
| saas-banner       | fix          | **ship**     | 93            | the winner has no subject                         | –                                                                                                                           |
| jazz-night        | ship         | ship         | 92            | surface → none (the winning layout has no shadow) | (low: an ambiguous second bass)                                                                                             |
| summer-sale       | fix          | **ship**     | 98            | surface → 0.5 (fixer)                             | (low: "sits mostly over the water")                                                                                         |
| farmers-market    | ship         | fix          | 87            | surface → 0.7 (fixer)                             | The basket hovers mid-scene: no surface was planned under it (medium)                                                       |
| headphones-launch | ship         | ship         | 92            | surface → 0.35, invisible on black                | –                                                                                                                           |
| yoga-retreat      | ship         | fix          | 94            | surface → 0.5 (fixer)                             | Hovers over the meadow, no visible shadow (medium)                                                                          |
| pizza-delivery    | ship         | ship         | 95            | floating → none                                   | (low: no contact shadow)                                                                                                    |
| tech-conference   | ship         | ship         | 98            | floating → none                                   | –                                                                                                                           |
| pet-adoption      | fix          | fix          | 93            | surface → 0.35 (the fixer's 0.7 wasn't picked)    | The puppy's paws float just above the floor line (medium)                                                                   |
| skincare-serum    | fix          | fix          | 87            | surface → 0.35                                    | **The bottle is intact, cap and dropper and all**, but FLUX drew a second, loose dropper beside it (medium, real)           |
| bookstore-event   | ship         | ship         | 99            | surface → none (no subject in the winner)         | –                                                                                                                           |

**The judge would ship 9 of 14** (8 in part 1).

- **skincare** now keeps BiRefNet's clean cut: 3 cuts, all warnings, none replaced. The headless bottle is gone. It still doesn't ship, for a real image artifact.
- **Model cuts:** 0 re-cuts on 22 hosted cuts. `cutout-quality` flagged 3 winners and 14 of 52 candidates, all as warnings.

**I looked at the renders: the first shadows were too faint.**

- On summer-sale's light sand the shadow grounds the hat and towels well. On grass, wood, dark panels and black they were invisible.
- pet's shadow covered only the front paws, since the bottom 6% of the cut missed the back paw, and the blur (half the height of a 26 px ellipse) washed the core out at 0.35.
- So "floating" stayed a medium finding on coffee, farmers, pet and yoga, even where the fixer raised the opacity with `setShadow` (5 prompts).

**Tuned (`9af86a2`).**

- **What changed:** the footprint band went from 6% to 12% of the cut, the ellipse got taller (22% of its width, was 14%), the blur dropped to 30% of its height, and the default opacity went from 0.35 to 0.5 (max 0.8).
- **How I chose it:** I compared both versions by rendering the pet, yoga and farmers finals with each. With the new one, yoga sits on the meadow and the puppy's paws have a shadow.
- **The re-run:** coffee, pet and yoga, on what was left of the $2 (`…T03-43-41-828Z_generate_phase5b-shadows-tuned.json`):

| Prompt       | First run (part 2) | Tuned re-run    | What still looks wrong                                                                                                                                 |
| ------------ | ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| coffee-latte | fix                | fix             | Murky mug shapes from the photo ghost through the brown panel (medium); the glass is front-lit against a sunrise (low). It no longer reads as floating |
| pet-adoption | fix                | **ship → ship** | (low) the shadow is faint on grass; flat lighting against a backlit park                                                                               |
| yoga-retreat | fix                | **fix → ship**  | (low) the shadow is light; front-lit against a backlit sunrise                                                                                         |

On coffee, pet and saas specifically:

- **coffee:** it no longer floats. The fixer set its shadow to 0.7, and the remaining findings are a ghosted panel (medium) and lighting (low).
- **pet:** grounded enough to ship. A faint shadow on grass, with the paws close to the panel's edge.
- **saas:** its winner, in both part-2 runs, had no subject at all, so there's nothing to ground.

**Counting the tuned re-run instead of the first-run results for those three prompts, 11 of 14 would ship.** That mixes two runs, so treat it as an estimate.

### What still looks wrong

- **Lighting, not floating, is now the top composite note.** A studio-lit, front-lit subject on a backlit scene (coffee, pet, yoga) reads as composited even with a good shadow. A shadow can't fix that.
- **A shadow can't show under a panel or on black.** coffee's first-run layout tucked the glass's base behind the brown panel, and headphones sits on black. The judge didn't object to headphones.
- **No surface, no grounding.** farmers' basket was planned mid-scene with nothing under it. The director's grounding instruction asks it to plan a surface, and it didn't. The shadow then makes things slightly worse.
- **FLUX artifacts in subjects:** skincare's loose second dropper, sneaker's fake tongue label. Real, and not cutout problems.
- **Replicate `E9828`** failed a FLUX prediction for the third time across the two parts (coffee in part 1, skincare twice). The client still doesn't retry a `failed` prediction.

### Spend

**$1.74 of $2** (`packages/generate/eval/results/spend-ledger-phase5b-shadows.json`, 201 entries):

- Main run: $1.29
- skincare re-run: $0.13
- Tuned re-run: $0.32

By kind:

- judge $0.51
- fix loop $0.47
- art director $0.43
- FLUX $0.30
- hosted cutouts $0.044 (30 cuts)

Part 1 and part 2 together: $3.06 across two ledgers ($1.31 + $1.74).

## What you need to do

1. **Review and merge `phase-5b-cutouts`.** Nothing is pushed.
2. **Decide on lighting.** It's the next composite problem. Two ways to fix it: brief the subject's lighting to match the background ("backlit, warm rim light from the right"), or have the director plan the light direction for both images.

## Suggestions

- **Retry `failed` predictions once in the Replicate client** when the error is a server-side `E…` code, as with a 5xx. It cost a prompt three times.
- **Hold the director to its surface:** when a "surface" subject's base doesn't land on anything in the background, warn or let the fixer move it. That needs a cheap check, such as the judge's finding or a background-edge test under the base.
- **Shadow color from the ground:** darken the ground's own color instead of using black, so shadows read on dark wood and grass.
- **Write the eval's results file incrementally**, so a stopped run keeps its summary.
