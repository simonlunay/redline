# Phase 5b report: hosted BiRefNet cutouts

Branch `phase-5b-cutouts` (from `main` at `aa11816`). Not pushed, not merged. Run date: 2026-10-11 (UTC 2026-10-12).

## TL;DR

- **What got built:** BiRefNet on Replicate as a third cutout path, behind the existing `BackgroundRemover` interface. The auto remover tries local BiRefNet_lite first, then hosted BiRefNet (when memory is short or the local model can't load), then the keyer. `--cutout hosted` forces it, in `redline generate` and in `eval:generate`. Local BiRefNet is unchanged. **316 tests pass** (10 new, all mocked); lint and typecheck are clean.
- **License:** `men1scus/birefnet` is MIT on both counts: code (`ZhengPeng7/BiRefNet`) and weights (`ZhengPeng7/BiRefNet-legacy`). It's a community wrapper, not an official Replicate model, and its packaging source isn't published. The training-data caveat is the same as for the local model (NOTICE).
- **Ships: 7 of 12 completed prompts, against 5 of the same 12 in phase 5** (6 of 14 overall then). Two prompts didn't complete (see "What went wrong with the run").
- **No final design has a cutout defect any more.** In phase 5, all 8 designs the judge didn't ship had a keyed-cutout defect. Now the judge names a cutout problem in none of the 5 it didn't ship. headphones, pizza and sneaker went from not shipped to shipped.
- **The new bottleneck is compositing, not cutting.** 3 of the 5 unshipped designs are "the subject floats like a sticker, no contact shadow" (coffee, pet, saas). The other 2 aren't about subjects at all (fake text on race bibs, a grey wash).
- **`cutout-quality` thresholds:** BiRefNet's soft edges trigger nothing (no see-through, jagged-edge or fragment flags on 17 hosted cuts). But all 5 flags it raised on hosted cuts are false alarms by eye: 3 `leftover-backdrop` warnings on subjects that are backdrop-colored (white cat, white laptop screen, cream clothing) and 2 `bites` on clean outlines. **One of those (skincare) was an error, and the re-cut logic swapped the near-perfect BiRefNet cut for a keyed bottle with its dropper missing.**
- **Spend: $1.17 of the $3 budget**, all in `packages/generate/eval/results/spend-ledger-phase5b.json`. 23 hosted cutouts cost $0.030 in total ($0.0013 each, max $0.0021).

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

The machine had 1.5–1.8 GB free throughout, so the auto remover sent every cutout to Replicate except one (skincare, see below).

| Prompt            | Phase 5 judge            | Phase 5b judge  | Final (rules) | It  | Regen | Subject cutouts (all hosted)                              | What still looks wrong (judge, checked by eye)              | Cost   |
| ----------------- | ------------------------ | --------------- | ------------- | --- | ----- | --------------------------------------------------------- | ----------------------------------------------------------- | ------ |
| charity-5k        | reject → fix             | fix → fix       | 92            | 3   | 1     | none (the winning layout used a photo background only)    | Gibberish race-bib numbers (medium)                         | $0.135 |
| coffee-latte      | reject → reject → reject | **fix**         | 93            | 2   | 0     | 2 ok                                                      | The glass floats in mid-air, no table or shadow (medium)    | $0.092 |
| sneaker-drop      | fix → fix                | **ship**        | 99            | 0   | 0     | 2 ok                                                      | (low: no grounding shadow)                                  | $0.063 |
| saas-banner       | ship → ship              | fix → fix       | 87            | 3   | 1     | 2, both warnings (false alarms: screen color, hinge step) | The laptop floats over the desk, perspective off (medium)   | $0.103 |
| jazz-night        | ship → fix               | ship            | 97            | 0   | 0     | 1 ok                                                      | –                                                           | $0.060 |
| summer-sale       | fix → fix                | fix → fix       | 85            | 4   | 0     | 1 ok                                                      | The fixer's grey scrim washes out the photo (medium, color) | $0.129 |
| farmers-market    | fix → ship               | fix → ship      | 100           | 1   | 0     | none                                                      | –                                                           | $0.077 |
| headphones-launch | fix → reject → reject    | **fix → ship**  | 100           | 1   | 0     | 2 ok (the headband interior is clean, no grey disc)       | –                                                           | $0.073 |
| yoga-retreat      | ship → ship              | ship            | 100           | 0   | 0     | 1, warning (false alarm: cream clothing)                  | –                                                           | $0.045 |
| pizza-delivery    | fix → fix                | **ship → ship** | 99            | 1   | 0     | 2 ok (no plate rim)                                       | –                                                           | $0.083 |
| tech-conference   | ship → ship              | ship            | 99            | 0   | 0     | 1 ok                                                      | –                                                           | $0.054 |
| pet-adoption      | reject → fix → fix       | fix → fix       | 93            | 1   | 1     | 3: 2 ok, 1 warning (false alarm: white cat)               | The animals hover with no ground or shadow (medium)         | $0.103 |
| skincare-serum    | fix → fix → fix          | not completed   |               |     |       | 2 (hosted); 1 replaced by a keyed re-cut, see below       |                                                             |        |
| bookstore-event   | ship → ship              | not run         |               |     |       |                                                           |                                                             |        |

|                                        | Phase 5 (same 12 prompts)   | Phase 5b   |
| -------------------------------------- | --------------------------- | ---------- |
| Judge would ship                       | 5                           | **7**      |
| Unshipped designs with a cutout defect | 7 of 7                      | **0 of 5** |
| Regenerations                          | 13 (nearly all for cutouts) | 3          |
| Fix-loop iterations                    | 28                          | 16         |
| Cost per completed design              | $0.114                      | $0.085     |

**How much to trust 7 vs 5:** it's one run of 12 prompts, and phase 5 measured the judge saying ship and then fix about the same pixels. The prompt-level change is the stronger evidence:

- every phase 5 rejection that named a cutout defect is gone;
- the regenerations the loop used to spend on keyed subjects mostly disappeared (13 down to 3).

saas-banner went the other way: it shipped in phase 5 with a different design (the director's plans differ run to run), and this time the laptop floats.

## Do the `cutout-quality` thresholds hold up on BiRefNet edges?

I put all 18 subject cutouts in the manifests (17 hosted, 1 keyed) on magenta (the phase 5 labeling method) and checked every flagged one at full size, with its alpha map.

| Signal                         | Fired on hosted cuts | Real defect by eye                                                                         |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------ |
| see-through, jagged, fragments | 0 of 17              | –                                                                                          |
| `leftover-backdrop` (warning)  | 3                    | **0**: a white cat, a white laptop screen, cream clothing. All subject color, not backdrop |
| `bites` (1 warning, 1 error)   | 2                    | **0**: both alpha masks are solid. The closing fills natural steps in the outline          |
| Any flag                       | 5 of 17              | 0                                                                                          |

- **Soft edges: the thresholds hold.** BiRefNet's anti-aliased matte trips none of the edge signals.
- **Shape and color: they don't.** `bites` closes the mask with a radius of 1.5% of the subject's size. On a dropper bottle (narrow bulb, wider collar, wider shoulder) and on a laptop (screen meets a wider base), that fills legitimate steps in the outline. Skincare measured 7.5% against an error limit of 5.5%. `leftover-backdrop` can't tell a backdrop-colored subject from leftover backdrop. This was known for the laptop in phase 5, and it's now the most common flag.
- **The re-cut made skincare worse.** Because the hosted cut measured as an error, `cutOutWithQualityCheck` re-cut with the two keyer settings and kept the one that measured better (a warning). That was a keyed bottle with its white dropper keyed away. I re-ran the hosted cut on the same FLUX image ($0.0012, tagged `diagnosis` in the ledger) to confirm: the hosted cut is clean, and the keyer's is broken. The design wasn't judged because the run was stopped, but this would ship a headless bottle.

**Recommendation (not done on this branch, since it changes the checker's tuned rule):**

- Don't let a keyer re-cut replace a model cut. When the first cut came from BiRefNet, local or hosted, keep it and just report the verdict.
- Make `bites` relative to the subject's local width rather than its overall size, or require a second signal before it becomes an error, the way `leftover-backdrop` already does.
- Re-tune both on BiRefNet cuts: 17 labeled hosted cuts are now in the reconstructed results file.

## What went wrong with the run

- **Run 1** (`…T01-50-47-382Z_generate_phase5b-hosted.json`):
  - charity-5k failed: the art director returned an empty layout on all 3 tries, the known phase 5 flake.
  - coffee-latte failed: Replicate failed a **FLUX** prediction server-side (`Director: unexpected error handling prediction (E9828)`). The hosted cutout for its subject had already succeeded. The FLUX provider retries HTTP and network errors but not a prediction that comes back `failed`. This was true before this branch.
  - sneaker-drop completed.
  - Then free memory fell to 764 MB, and the eval's own guard (I had set it to 1000 MB) skipped the other 11 prompts.
- **Run 2** (13 prompts, guard lowered to 300 MB):
  - Physical memory was tight, but there were 24.7 GB of commit headroom, and the process peaked around 0.9 GB with no local model loaded.
  - charity-5k and coffee-latte both completed this time.
  - 11 prompts finished. Then Claude Code itself stopped the background run during skincare-serum because the whole system was critically low on memory (other apps held about 14 of 16 GB).
  - The eval writes its summary only at the end, so run 2's rows were rebuilt from each prompt's `generation.json` and manifest: `…T01-57-32-671Z_generate_phase5b-hosted-rest.reconstructed.json`.
  - skincare-serum and bookstore-event have no result. I didn't restart it.

## Spend

**$1.17 of $3**, itemized in `packages/generate/eval/results/spend-ledger-phase5b.json` (158 entries):

| Item                                   | Cost    |
| -------------------------------------- | ------- |
| Probe call before writing the code     | $0.0007 |
| CLI smoke test (forced hosted cutout)  | $0.0071 |
| Eval run 1 (1 design + 2 failures)     | $0.127  |
| Eval run 2 (11 designs + skincare)     | $1.032  |
| Diagnosis re-cut of the skincare image | $0.0012 |

By kind: art director $0.34, judge $0.31, fix loop $0.25, FLUX $0.23, **hosted cutouts $0.030**.

The smoke test created the ledger with a $0.10 cap, and file-ledger caps only go down. I reset it to $3 by hand before the eval and added the probe call, which had run outside the ledger.

## What you need to do

1. **Finish the eval for skincare-serum and bookstore-event** when the machine has memory to spare: about $0.20.

   ```
   npm run eval:generate -- --prompts skincare-serum,bookstore-event --ledger packages/generate/eval/results/spend-ledger-phase5b.json --budget 1 --concurrency 1 --label phase5b-hosted-last
   ```

   Expect skincare to show the re-cut problem above.

2. **Decide on the re-cut and `bites` changes above.** I'd do the first (never swap a model cut for a keyed one) before relying on hosted cutouts.
3. **Review and merge `phase-5b-cutouts`.** Nothing is pushed.

## Suggestions

- **Compositing is the next bottleneck.** Every remaining subject complaint is "floats, no contact shadow". The assembler could add a soft contact shadow under any cut-out subject placed on a scene background, or the director could plan a surface for it. Either is cheaper than another regeneration.
- **Retry `failed` predictions once in the Replicate client** when the error is a server-side `E…` code, as with a 5xx.
- **Write the eval's results file incrementally**, so a stopped run keeps its summary.
