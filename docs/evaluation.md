# Evaluation

Every number on this page comes from a committed result file, linked next to it. Runs are listed in the order they were made.

## Summary

| What                                                   | Result                                                                                      | Section                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Fix loop, strict benchmark (21 fixtures, 3 runs/model) | Mean score 62.1 before → 98.8 Sonnet 5.5 / 99.5 Opus 5.5; 81.8 looping the rules' own fixes | [Fix loop: strict mode](#fix-loop-strict-mode)                        |
| Fix loop, strict goal rate (target 100, attention on)  | Sonnet 55/63 runs, Opus 59/63; rules loop 8/21                                              | [Fix loop: strict mode](#fix-loop-strict-mode)                        |
| Blind pairwise judge, before vs after the fix loop     | Fixed version won 40 of 42, original won 0, 2 ties                                          | [Blind pairwise judge](#blind-pairwise-judge)                         |
| Generation, 14 prompts, every check on                 | The judge would ship 9 of 14                                                                | [Generation run 4](#generation-run-4-model-cuts-kept-contact-shadows) |

## Fix loop

```bash
npm run eval                                              # default model
npm run eval -- --models claude-sonnet-5-5,claude-opus-5-5 --runs 3
npm run eval -- --no-llm                                  # baselines only, free
npm run eval -- --fixtures worst,promo-food --effort high
npm run eval -- --strict --models claude-sonnet-5-5,claude-opus-5-5 --runs 3
npm run eval -- --strict --fixtures 'hard-*'
```

Every fixture is measured four ways, all with the same precise checker the CLI uses:

| Column     | What it measures                                                                  |
| ---------- | --------------------------------------------------------------------------------- |
| Before     | The original design                                                               |
| Rules once | Apply the checker's suggested fixes once, with no LLM                             |
| Rules loop | The same fix loop, but the editor only applies the checker's suggestions (no LLM) |
| _model_    | The fix loop with Claude (`--runs N`: mean and min-max)                           |

**The two rules columns are deterministic.** They separate what _iterating_ adds from what the _LLM_ adds.

**`--strict`** is the harder benchmark: target **100** (every warning counts), the **attention rules on**, and up to **5 iterations**. It adds a table with each fixture's CTA and headline share of predicted attention, how often the CTA is predicted to be seen first or second, and how many designs fall below the attention minimums. Rollbacks per run are reported too.

**Results** are saved to `packages/agent/eval/results/*.json` with the git commit and settings, per-step history, every accepted edit with its reason, the best design, token usage and estimated cost, and the model ids the API returned.

**Fixtures:** 21 in total (normal mode used the first 14):

- a clean poster
- one fixture per rule
- `worst.json`
- four messy, ad-like designs, each failing 5 to 8 rules at once: `ad-sneaker-sale`, `story-concert`, `banner-saas`, `promo-food`
- seven **hard** ones (`hard-*`):
  - a busy photo with a tiny CTA
  - a flyer with six competing stickers
  - a 728×90 leaderboard
  - a 300×1050 skyscraper
  - a story whose hero face pulls attention from the CTA
  - two designs that **pass every layout rule but fail attention** (`hard-attention-burst`, `hard-attention-badge`)

### Fix loop: normal mode

Commit `c64f2d5`, 2026-10-07, before the hard fixtures and the attention check existed. Effort `medium`, target 90, max 4 iterations, vision on, **3 runs per model**, 14 fixtures. Raw data: [`2026-10-07T00-10-51-680Z_claude-sonnet-5-5+claude-opus-5-5.json`](../packages/agent/eval/results/2026-10-07T00-10-51-680Z_claude-sonnet-5-5+claude-opus-5-5.json).

Each cell is score / errors. For the models, the score is the mean (min-max) over the 3 runs.

| Fixture                  | Before  | Rules once | Rules loop | Sonnet 5.5       | Opus 5.5         |
| ------------------------ | ------- | ---------- | ---------- | ---------------- | ---------------- |
| ad-sneaker-sale          | 11 / 7  | 28 / 4     | 35 / 4     | 97 (94-100) / 0  | 97 (94-100) / 0  |
| banner-saas              | 27 / 5  | 88 / 0     | 97 / 0     | 98 (97-100) / 0  | 99 (97-100) / 0  |
| clean-poster             | 100 / 0 | 100 / 0    | 100 / 0    | 100 / 0          | 100 / 0          |
| competing-headline       | 84 / 1  | 100 / 0    | 100 / 0    | 100 / 0          | 100 / 0          |
| low-contrast-on-image    | 58 / 2  | 100 / 0    | 100 / 0    | 100 / 0          | 100 / 0          |
| misaligned               | 94 / 0  | 100 / 0    | 94 / 0     | 94 / 0           | 94 / 0           |
| off-canvas               | 79 / 1  | 97 / 0     | 97 / 0     | 100 / 0          | 100 / 0          |
| overlap-headline-product | 58 / 2  | 76 / 1     | 100 / 0    | 100 / 0          | 100 / 0          |
| promo-food               | 11 / 8  | 27 / 5     | 27 / 5     | 97 (97-97) / 0   | 100 / 0          |
| story-concert            | 22 / 5  | 40 / 3     | 67 / 1     | 99 (97-100) / 0  | 100 / 0          |
| stretched-image          | 84 / 1  | 100 / 0    | 100 / 0    | 100 / 0          | 100 / 0          |
| text-overflow            | 58 / 2  | 53 / 2     | 58 / 2     | 100 / 0          | 100 / 0          |
| tiny-text                | 79 / 1  | 91 / 0     | 91 / 0     | 100 / 0          | 100 / 0          |
| worst                    | 6 / 11  | 21 / 6     | 54 / 2     | 98 (97-100) / 0  | 98 (97-100) / 0  |
| **Mean score**           | 55.1    | 72.9       | 80.0       | **98.8**         | **99.1**         |
| **Errors (total)**       | 46      | 21         | 14         | 0 (every run)    | 0 (every run)    |
| **Reached goal**         | 2/14    | 7/14       | 9/14       | **42/42 runs**   | **42/42 runs**   |
| **Cost (3 runs)**        | n/a     | n/a        | n/a        | $0.67 (42 calls) | $1.26 (37 calls) |

- **The checker's own suggestions only go so far.** Applied once, they lift the mean score from 55 to 73. Looped, they reach 80, but the four messy ads stay at 27 to 97, and `text-overflow` doesn't improve at all. Growing the text box pushes it into the button, so the loop correctly rolls that back.
- **The LLM adds what the rules can't.** It reasons across rules and repairs the whole layout. It moves text off photos, adds translucent backing shapes (`insertShape` was used in 9 of 42 Sonnet runs), and rebalances type sizes. It cleared every error in every run, usually in **one iteration**.
- **Sonnet 5.5 vs Opus 5.5:** almost identical quality on this set, and Sonnet costs about half as much (about $0.016 per fixed design). That's why Sonnet is the default.
- **`misaligned` stays at 94 for every loop.** 94 with no errors already meets the goal, so the loop never runs. The "rules once" column applies its suggestions unconditionally, which is why it shows 100 there.
- **The benchmark was saturated.** Both models solved every fixture, so it couldn't separate them, and no rollback fired. That's why `--strict` and the hard fixtures were added.

### Fix loop: strict mode

Commit `db2a50f`, 2026-10-07. `--strict` (target 100, attention on, max 5 iterations), effort `medium`, vision on (annotated render + heatmap), **3 runs per model**, 21 fixtures. Raw data: [`2026-10-07T01-25-38-380Z_strict_claude-sonnet-5-5+claude-opus-5-5.json`](../packages/agent/eval/results/2026-10-07T01-25-38-380Z_strict_claude-sonnet-5-5+claude-opus-5-5.json).

Cells are score / errors. For the models, the score is the mean (min-max) over 3 runs, and the errors are the mean.

| Fixture                    | Before  | Rules once | Rules loop | Sonnet 5.5         | Opus 5.5         |
| -------------------------- | ------- | ---------- | ---------- | ------------------ | ---------------- |
| ad-sneaker-sale            | 11 / 7  | 28 / 4     | 33 / 4     | 100 / 0            | 100 / 0          |
| banner-saas                | 23 / 5  | 78 / 0     | 78 / 0     | 84.3 (79-88) / 0.3 | 92 (88-94) / 0   |
| clean-poster               | 100 / 0 | 100 / 0    | 100 / 0    | 100 / 0            | 100 / 0          |
| competing-headline         | 79 / 1  | 97 / 0     | 97 / 0     | 100 / 0            | 100 / 0          |
| hard-attention-badge       | 88 / 0  | 71 / 1     | 88 / 0     | 100 / 0            | 100 / 0          |
| hard-attention-burst       | 94 / 0  | 94 / 0     | 100 / 0    | 100 / 0            | 100 / 0          |
| hard-busy-photo-tiny-cta   | 70 / 1  | 70 / 1     | 70 / 1     | 98 (94-100) / 0    | 100 / 0          |
| hard-cluttered-flyer       | 63 / 1  | 94 / 0     | 94 / 0     | 100 / 0            | 98 (94-100) / 0  |
| hard-leaderboard           | 79 / 1  | 88 / 0     | 88 / 0     | 96 (94-100) / 0    | 100 / 0          |
| hard-skyscraper            | 88 / 0  | 70 / 1     | 88 / 0     | 100 / 0            | 100 / 0          |
| hard-story-hero            | 79 / 1  | 79 / 1     | 100 / 0    | 100 / 0            | 100 / 0          |
| low-contrast-on-image      | 58 / 2  | 100 / 0    | 100 / 0    | 100 / 0            | 100 / 0          |
| misaligned                 | 94 / 0  | 100 / 0    | 100 / 0    | 100 / 0            | 100 / 0          |
| off-canvas                 | 79 / 1  | 97 / 0     | 100 / 0    | 100 / 0            | 100 / 0          |
| overlap-headline-product   | 46 / 3  | 60 / 2     | 94 / 0     | 100 / 0            | 100 / 0          |
| promo-food                 | 11 / 8  | 26 / 5     | 26 / 5     | 100 / 0            | 100 / 0          |
| story-concert              | 16 / 6  | 32 / 4     | 56 / 2     | 96 (94-100) / 0    | 100 / 0          |
| stretched-image            | 84 / 1  | 100 / 0    | 100 / 0    | 100 / 0            | 100 / 0          |
| text-overflow              | 58 / 2  | 53 / 2     | 58 / 2     | 100 / 0            | 100 / 0          |
| tiny-text                  | 79 / 1  | 91 / 0     | 100 / 0    | 100 / 0            | 100 / 0          |
| worst                      | 5 / 11  | 20 / 6     | 47 / 3     | 100 / 0            | 100 / 0          |
| **Mean score**             | 62.1    | 73.7       | 81.8       | **98.8**           | **99.5**         |
| **Reached goal**           | 1/21    | 4/21       | 8/21       | **55/63 runs**     | **59/63 runs**   |
| **Rolled-back iterations** | n/a     | n/a        | n/a        | 12 (0.19 per run)  | 3 (0.05 per run) |
| **Mean iterations**        | n/a     | n/a        | n/a        | 1.75               | 1.37             |
| **Cost (3 runs)**          | n/a     | n/a        | n/a        | $1.94 (110 calls)  | $3.62 (86 calls) |

Predicted attention: share of the best design's attention, with the mean over all fixtures and runs.

| Attention                                 | Before | Rules loop | Sonnet 5.5 | Opus 5.5 |
| ----------------------------------------- | ------ | ---------- | ---------- | -------- |
| Designs with the CTA below the 5% minimum | 4/21   | 4/21       | **0/63**   | **0/63** |
| Designs with the headline below 19%       | 5/21   | 5/21       | 2/63       | 1/63     |
| CTA predicted to be seen 1st or 2nd       | 17/21  | 16/21      | 51/63      | 52/63    |
| Mean CTA share                            | 9.4%   | 8.8%       | 9.6%       | 10.6%    |
| Mean headline share                       | 25.4%  | 26.1%      | 29.1%      | 29.1%    |

Selected CTA shares (mean, with min-max over 3 runs):

| Fixture                  | Before | Rules loop | Sonnet 5.5        | Opus 5.5          |
| ------------------------ | ------ | ---------- | ----------------- | ----------------- |
| hard-busy-photo-tiny-cta | 0.1%   | 0.1%       | 8.7% (6.6-10.4)   | 7.7% (7.1-8.4)    |
| hard-story-hero          | 1.1%   | 5.5%       | 6.0% (5.8-6.2)    | 8.9% (6.6-11.2)   |
| hard-skyscraper          | 2.6%   | 2.6%       | 6.9% (6.9-7.0)    | 8.5% (7.3-10.1)   |
| hard-leaderboard         | 4.2%   | 4.2%       | 7.8% (6.4-10.1)   | 9.5% (9.3-9.7)    |
| hard-attention-badge     | 7.6%   | 7.6%       | 15.5% (13.1-18.3) | 16.0% (15.7-16.5) |

- **The strict benchmark separates the models where the normal one couldn't.**
  - Opus reaches the goal in 59/63 runs and Sonnet in 55/63.
  - Sonnet needs more iterations (1.75 vs 1.37 on average).
  - The gap shows up on the hardest designs: `banner-saas` (Sonnet 84 vs Opus 92), the busy photo, the leaderboard and `story-concert`.
  - Opus costs about 1.9× as much ($0.057 vs $0.031 per fixed design).
- **Rollback fires in real runs.** Sonnet had 12 rolled-back iterations (0.19 per run) and Opus 3. After each one the next attempt was steered by the "you broke X" feedback, and those runs still converged.
- **Rules alone can't fix attention.** Looping the checker's suggestions leaves 4/21 CTAs below the minimum and doesn't change the mean CTA share. Both LLMs bring **every CTA above the minimum in every run**: the starved CTAs go from 0.1-4% to 6-16%.
- **Mean CTA share is the wrong headline metric.** Over-attended CTAs (e.g. `low-contrast-on-image` at 29.8%) drop to a normal share as their layout problems are fixed, while starved ones rise. "Below the minimum" is what the rule enforces, and it's what to quote.
- **The two layout-clean but attention-failing designs** (`hard-attention-badge`, `hard-attention-burst`) score 88 and 94 before. Every run fixes them to 100, mostly by boosting the CTA and toning down the decoration.
- **`banner-saas` is still unsolved.** At 1200×628 with a long headline, the model gives the headline about 50% of attention, and the small CTA stays near the 5% line.

### Fix loop caveats

- **The checker is also the judge in these tables.** A high score means "passes these rules", not "is a good design". Spot checks of the fixed renders (`redline fix --render-steps`) show genuine layout repairs rather than games played against the rules, and the [blind pairwise judge](#blind-pairwise-judge) measures quality independently of the rules.
- **LLM runs vary.** Results come from the requested model only (no fallbacks), but sampling isn't deterministic. That's why the tables report min-max over 3 runs.

## Blind pairwise judge

`npm run eval:pairwise`. The vision judge in [blind pairwise mode](judge-and-image-checks.md#blind-pairwise-mode) compares the before and after renders of the [strict-mode fix-loop eval](#fix-loop-strict-mode): 42 pairs (21 fixtures × the Sonnet and Opus fixes), each judged in both orders, 84 calls, $1.13. Raw data: [`2026-10-08T16-57-43-442Z_pairwise_claude-opus-5-5.json`](../packages/generate/eval/results/2026-10-08T16-57-43-442Z_pairwise_claude-opus-5-5.json).

- The fixed version won **40 of 42**. The 2 ties are `clean-poster`, where before and after are identical. The before version won 0.
- In 3 of 3 identity controls (the same design twice) it said tie.
- The LLM fix beat the checker's own one-shot fixes 6 of 6.
- The two orders never disagreed. Its reasons name concrete differences, including regressions inside wins: one fix left a badge unreadable, another pulled a stray decoration into view.

## Image checks and judge against hand labels

`npm run eval:replay -w packages/generate` runs the [image rules and the judge](judge-and-image-checks.md) on the 48 candidates and 12 winners of [generation run 1](#generation-run-1-baseline-pipeline), against hand labels. Raw data: [`2026-10-08T17-11-27-484Z_replay-phase4.json`](../packages/generate/eval/results/2026-10-08T17-11-27-484Z_replay-phase4.json).

- **Image rules, 12 winners:** caught all 4 labeled as broken (yoga's fake button; coffee, skincare and headphones cutouts), with no false alarms.
- **Image rules, 48 candidates:** `image-text` 1 hit, 1 miss and 2 debatable flags (a laptop's UI labels). `cutout-quality` flagged 16 of 20 damaged-cutout candidates as errors and the other 4 as warnings, with 0 false errors.
- **Judge, 12 winners:** flagged the same 4, plus 5 labeled fine. On a second look, all 5 are real: a faint gibberish strip, halos, a hard overlay seam, a leftover plate rim, a shadow slab. It passed the other 3, which included one real miss (a floating towel).

## Generation

```bash
npm run eval:generate                       # 14 prompts, Sonnet 5.5 + FLUX.1 schnell, about $0.10/prompt
npm run eval:generate -- --prompts charity-5k,saas-banner
npm run eval:generate -- --offline          # template director + mock images + rules editor, free
```

[`packages/generate/eval/prompts.json`](../packages/generate/eval/prompts.json) has 14 prompts covering ads, posters and social posts in five sizes: 1080×1350, 1080×1080, 1080×1920 (story), 1200×628 and 1500×500 (wide banners). The styles range from photographic to flat illustration. For each prompt the eval reports the score of candidate #1 alone (what you'd get without best-of-N), the best-of-N winner's score, the final score after the fix loop, iterations and regenerations used, the CTA's share of predicted attention before and after the loop, and the cost. With the image checks and the judge on, it also reports what each check caught on the winners and candidates, re-cuts, what the regenerations were for, and the judge's agreement with the rules.

Every paid call goes through a persistent spend ledger (`--ledger`, default `packages/generate/eval/results/spend-ledger.json`), which also enforces a cap.

| Run | Date       | What changed                     | Judge would ship |
| --- | ---------- | -------------------------------- | ---------------- |
| 1   | 2026-10-07 | Baseline pipeline, no judge      | n/a              |
| 2   | 2026-10-08 | Image checks and judge on        | 6 of 14          |
| 3   | 2026-10-11 | Hosted BiRefNet cutouts          | 8 of 14          |
| 4   | 2026-10-12 | Model cuts kept, contact shadows | **9 of 14**      |

"Judge would ship" counts the judge's verdict on the design that shipped, which isn't always the last review: the final pick can keep an earlier round's design (jazz-night in run 2, saas-banner in run 4: ship, then fix, and round 0's design shipped). Each result row records it as `judgeShipped` and `judgeShippedRound`, and `summary.judge.finalShip` counts it. Results saved before the counter worked this way were recounted from their stored `.generation.json` records with `npm run eval:recount-shipped -w packages/generate`, with no new API calls.

### Generation run 1: baseline pipeline

Sonnet 5.5 (`medium`) + FLUX.1 schnell, 4 candidates, target 95, max 4 iterations, 2 regenerations allowed, `--concurrency 1 --budget 5`. No image checks or judge. Raw data: [`2026-10-07T21-23-33-175Z_generate_claude-sonnet-5-5.json`](../packages/generate/eval/results/2026-10-07T21-23-33-175Z_generate_claude-sonnet-5-5.json). Analysis: [generation report](phase-4-report.md).

| Prompt            | Size      | First  | Best-of-4 | Final | Iterations | Regenerations | CTA attention | Cost   | Looks off despite 100?                                                    |
| ----------------- | --------- | ------ | --------- | ----- | ---------- | ------------- | ------------- | ------ | ------------------------------------------------------------------------- |
| charity-5k        | 1080×1350 | 100    | 100       | 100   | 0          | 0             | 12.2%         | $0.047 |                                                                           |
| coffee-latte      | 1080×1080 | 100    | 100       | 100   | 0          | 0             | 8.5%          | $0.052 | Yes: ragged, partly see-through edges on the keyed latte glass            |
| sneaker-drop      | 1080×1920 | 100    | 100       | 100   | 0          | 0             | 15.7%         | $0.040 |                                                                           |
| saas-banner       | 1200×628  | 100    | 100       | 100   | 0          | 0             | 9.9%          | $0.035 |                                                                           |
| jazz-night        | 1080×1350 | failed |           |       |            |               |               |        | Art director returned empty layouts twice                                 |
| summer-sale       | 1080×1080 | 56     | 100       | 100   | 0          | 0             | 8.8%          | $0.039 |                                                                           |
| farmers-market    | 1080×1920 | 100    | 100       | 100   | 0          | 0             | 8.9%          | $0.038 |                                                                           |
| headphones-launch | 1500×500  | 94     | 100       | 100   | 0          | 0             | 7.0%          | $0.039 | Slightly: a white disc of leftover backdrop under the headphones          |
| yoga-retreat      | 1080×1350 | 100    | 100       | 100   | 0          | 0             | 15.5%         | $0.031 | **Yes: FLUX drew a gibberish "Fore tob'x cort terte" pill below the CTA** |
| pizza-delivery    | 1200×628  | 100    | 100       | 100   | 0          | 0             | 8.6%          | $0.040 |                                                                           |
| tech-conference   | 1080×1080 | failed |           |       |            |               |               |        | A Replicate prediction timed out                                          |
| pet-adoption      | 1080×1350 | 58     | 100       | 100   | 0          | 0             | 5.3%          | $0.040 |                                                                           |
| skincare-serum    | 1080×1920 | 94     | 100       | 100   | 0          | 0             | 7.1%          | $0.039 | **Yes: the keyer cut a notch out of the serum bottle's shoulder**         |
| bookstore-event   | 1500×500  | 88     | 100       | 100   | 0          | 0             | 7.0%          | $0.031 |                                                                           |
| **mean (12 run)** |           | 90.8   | 100       | 100   | 0          | 0             | 9.6%          | $0.039 |                                                                           |

- **Target (95, no errors) on the first candidate: 7 of 12.** The five misses were text contrast over the photo (summer-sale, pet-adoption) and attention (headphones, skincare, bookstore: the CTA or headline drew too little of the predicted attention, or a background hot spot competed with it).
- **On best-of-4: 12 of 12.** Another layout or background rescued every miss.
- **Needed the fix loop: 0. Needed an image regeneration: 0.** This run doesn't exercise the loop or the regeneration op.
- **`label-centered` fired on none of the 48 candidates**, because assembly already centers CTA labels.
- **Invented facts: none.** Where the prompt gave no date or venue, the director wrote `[Date]` / `[Venue]` placeholders (charity, farmers market, pet adoption, bookstore). A person still has to fill them in before publishing.
- **2 of 14 failed:** one Replicate timeout, and one art-director plan with empty layouts on both tries. Both are now handled (see [Reliability](generation.md#how-it-works)).
- **Every cutout in this run used the backdrop keyer, not BiRefNet**, because the machine had under 7.5 GB free. The keyer caused every cutout problem in the table. It also produced clearly broken candidates that didn't win but still scored 100: an uncut photo rectangle with a leg in it (sneaker-drop #2 and #4) and white slabs left under the runner (charity-5k #2 and #4). The layout rules can't see cutout quality, which led to the [image checks and judge](judge-and-image-checks.md).
- Cost: $0.52 spent this run, including the failed prompts ($0.039 per completed design on average).

Before this run, one attempt was stopped for low memory at the first local BiRefNet cutout: one inference needs about 6 GB, and the machine had about 7 GB free. The fallback threshold is 7.5 GB, so such a machine keys subjects instead of crashing. ONNX Runtime's CPU arena also kept BiRefNet's ~6 GB inference peak for the life of the session; turning it off (identical output and speed) changed memory as follows:

|                                | Before  | After   |
| ------------------------------ | ------- | ------- |
| Peak RSS (OS)                  | 7.66 GB | 6.35 GB |
| Resident after the run         | 7.59 GB | 0.72 GB |
| Resident after 3 runs in a row | 6.96 GB | 0.73 GB |

### Generation run 2: image checks and judge on

Same settings as run 1, plus the image rules and the Opus 5.5 judge (2 rounds), `--concurrency 1`. Raw data: [`2026-10-08T18-00-25-677Z_generate_phase5-final.json`](../packages/generate/eval/results/2026-10-08T18-00-25-677Z_generate_phase5-final.json) (13 prompts) and [`2026-10-08T18-28-47-917Z_generate_phase5-final-bookstore.json`](../packages/generate/eval/results/2026-10-08T18-28-47-917Z_generate_phase5-final-bookstore.json) (bookstore-event, which the eval's low-memory guard had skipped). Analysis: [image checks and judge report](phase-5-report.md).

"Final (rules)" is the rules-only score of the design that shipped; the final score the CLI prints also counts the judge's findings.

| Prompt            | Size      | First | Best-of-4 (rules) | Image rules on winner | Judge verdicts           | Iterations | Regenerations | Re-cuts | Final (rules) | Final judge    | Cost   |
| ----------------- | --------- | ----- | ----------------- | --------------------- | ------------------------ | ---------- | ------------- | ------- | ------------- | -------------- | ------ |
| charity-5k        | 1080×1350 | 69    | 84                | cutout                | reject → fix             | 1          | 1 (1 kept)    | 1       | 100           | fix            | $0.121 |
| coffee-latte      | 1080×1080 | 53    | 64                | cutout                | reject → reject → reject | 8          | 2 (2 kept)    | 4       | 84 (1 err)    | reject         | $0.255 |
| sneaker-drop      | 1080×1920 | 100   | 100               | none                  | fix → fix                | 1          | 1 (1 kept)    | 0       | 100           | fix            | $0.090 |
| saas-banner       | 1200×628  | 67    | 100               | none                  | ship → ship              | 0          | 0             | 0       | 100           | ship           | $0.046 |
| jazz-night        | 1080×1350 | 94    | 100               | none                  | ship → fix               | 0          | 0             | 0       | 100           | ship (round 0) | $0.075 |
| summer-sale       | 1080×1080 | 94    | 94                | cutout                | fix → fix                | 1          | 1 (1 kept)    | 0       | 100           | fix            | $0.092 |
| farmers-market    | 1080×1920 | 76    | 100               | none                  | fix → ship               | 3          | 2 (2 kept)    | 1       | 94            | ship           | $0.132 |
| headphones-launch | 1500×500  | 88    | 94                | cutout                | fix → reject → reject    | 6          | 2 (2 kept)    | 0       | 94            | reject         | $0.132 |
| yoga-retreat      | 1080×1350 | 100   | 100               | none                  | ship → ship              | 0          | 0             | 1       | 100           | ship           | $0.052 |
| pizza-delivery    | 1200×628  | 74    | 97                | none                  | fix → fix                | 3          | 2 (1 kept)    | 1       | 100           | fix            | $0.109 |
| tech-conference   | 1080×1080 | 100   | 100               | none                  | ship → ship              | 0          | 0             | 0       | 100           | ship           | $0.053 |
| pet-adoption      | 1080×1350 | 84    | 100               | none                  | reject → fix → fix       | 5          | 2 (2 kept)    | 2       | 94            | fix            | $0.210 |
| skincare-serum    | 1080×1920 | 79    | 84                | cutout                | fix → fix → fix          | 3          | 2 (2 kept)    | 3       | 100           | fix (round 1)  | $0.166 |
| bookstore-event   | 1500×500  | 67    | 100               | none                  | ship → ship              | 0          | 0             | 1       | 100           | ship           | $0.050 |

- **14 of 14 prompts completed** (2 failed in run 1).
- **The fix loop ran on 9 of 14** (0 of 12 in run 1), with **15 regenerations**: 14 for cutouts, 1 for text in an image. 14 of them were kept.
- **The judge flagged 9 of 14 winners.** The image rules flagged 5, all cutouts, and `image-text` flagged 6 candidates. Across all 32 of its reviews, the judge flagged 11 designs the rules passed and passed 1 the rules flagged.
- **It shipped 6 of 14.** By eye, 5 are clean, and farmers-market keeps a minor `cutout-quality` warning on the basket edge. The 8 it didn't ship all still have a visible keyed-cutout defect (slabs, discs, patches, halos), and the judge named each one.
- **The loop can't fix those 8**, because regenerating a subject sends it through the same keyer. The eval machine never had the ~7.5 GB free that local BiRefNet needs, so every cutout was keyed.
- **Cost: $1.58 for 14 designs** ($0.113 per design, against $0.039 in run 1), of which the judge was $0.46.

### Generation run 3: hosted BiRefNet cutouts

Same settings as run 2, with `--cutout auto`. The machine had under 3 GB free, so every cutout went to BiRefNet on Replicate. Raw data: [`2026-10-12T01-50-47-382Z_generate_phase5b-hosted.json`](../packages/generate/eval/results/2026-10-12T01-50-47-382Z_generate_phase5b-hosted.json) (sneaker-drop; that run stopped on low memory) and [`2026-10-12T01-57-32-671Z_generate_phase5b-hosted-rest.json`](../packages/generate/eval/results/2026-10-12T01-57-32-671Z_generate_phase5b-hosted-rest.json) (the other 13). Analysis: [hosted cutouts report](phase-5b-report.md).

- **The judge would ship 8 of 14** (6 in run 2). headphones, pizza, sneaker and bookstore are newly shipped; saas no longer is.
- **Cutout defects are almost gone.** In run 2, all 8 designs the judge didn't ship had a keyed-cutout defect. Now 1 of 6 does, skincare, and that's a keyed cut chosen over a clean hosted one by mistake (below).
- **What's left is compositing:** 3 of the 6 are a subject floating with no contact shadow (coffee, pet, saas). 2 are fake text on race bibs and a grey scrim the fixer added.
- **Regenerations fell from 15 to 5**, and cost per design from $0.113 to $0.089. The 22 hosted cutouts in the ledger cost $0.03 in total.
- **`cutout-quality` didn't hold up on BiRefNet cuts.** Its edge signals stay quiet on the soft matte. But it raised 7 flags (3 errors) on 21 hosted cuts, and all 7 are false alarms: backdrop-colored subjects (`leftover-backdrop`) and natural steps in an outline (`bites`). On skincare, the false errors swapped a clean dropper-bottle cut for a keyed one with no dropper, then made the final pick reject the loop's clean regeneration, so the headless bottle shipped. Run 4 fixes this: model cuts are kept and their flags are warnings.

### Generation run 4: model cuts kept, contact shadows

Same settings, `--budget 2`. Raw data: [`2026-10-12T03-00-16-784Z_generate_phase5b-shadows.json`](../packages/generate/eval/results/2026-10-12T03-00-16-784Z_generate_phase5b-shadows.json) (13 prompts) and [`2026-10-12T03-32-59-260Z_generate_phase5b-shadows-skincare.json`](../packages/generate/eval/results/2026-10-12T03-32-59-260Z_generate_phase5b-shadows-skincare.json) (skincare-serum, re-run after a Replicate server error). A re-run of 3 prompts with the tuned shadows: [`2026-10-12T03-43-41-828Z_generate_phase5b-shadows-tuned.json`](../packages/generate/eval/results/2026-10-12T03-43-41-828Z_generate_phase5b-shadows-tuned.json). Analysis: [model cuts and contact shadows report](phase-5b-report.md#part-2-model-cuts-kept-contact-shadows).

- **The judge would ship 9 of 14** (8 in run 3). In the re-run of coffee, pet and yoga with the tuned shadows, pet and yoga shipped too. Counting that re-run for those three prompts gives 11 of 14, but that mixes two runs, so treat it as an estimate.
- **skincare-serum's bottle is intact**, cap and dropper and all, with a visible shadow. The judge still didn't ship it: FLUX drew a second, loose dropper beside the bottle.
- **"Floating subject" findings dropped from medium to low once the shadows were visible.** The first shadows were too faint on anything but light, flat ground (medium findings on coffee, farmers, pet and yoga), so they were tuned. In the re-run, the remaining notes on coffee, pet and yoga are low: a faint shadow on grass, and a front-lit subject on a backlit scene.
- **No model cut was re-cut** (0 re-cuts on 22 hosted cuts). `cutout-quality` flagged 3 winners, all as warnings.
