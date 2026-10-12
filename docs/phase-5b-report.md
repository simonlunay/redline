# Phase 5b report: hosted BiRefNet cutouts

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

**Recommendation (not done on this branch, since it changes the checker's tuned rule):**

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

## What you need to do

1. **Decide on the `cutout-quality` changes above.** I'd do the first and third before relying on hosted cutouts: keep model cuts over keyed re-cuts, and don't let the rule outvote the judge on BiRefNet cuts. As it stands, the checker can turn a clean hosted cut into a broken shipped design.
2. **Review and merge `phase-5b-cutouts`.** Nothing is pushed.

## Suggestions

- **Compositing is the next bottleneck.** Every remaining complaint about a correctly cut subject is "floats, no contact shadow". The assembler could add a soft contact shadow under any cut-out subject placed on a scene background, or the director could plan a surface for it. Either is cheaper than another regeneration.
- **Retry `failed` predictions once in the Replicate client** when the error is a server-side `E…` code, as with a 5xx.
- **Write the eval's results file incrementally**, so a stopped run keeps its summary.
