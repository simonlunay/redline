# Phase 5 report: catching designs that pass every rule but still look wrong

Branch `phase-5-judge` (from `main` at `5190ddf`). Not pushed, not merged. Run date: 2026-10-08. Plan: [phase-5-plan.md](phase-5-plan.md).

## TL;DR

- **What got built:**
  - two image rules: `image-text` (PP-OCRv5 det + rec, Apache-2.0, local) and `cutout-quality` (alpha analysis, pure TypeScript)
  - an independent **Opus 5.5 vision judge** whose findings drive the fix loop, plus a blind pairwise mode
  - Replicate timeouts, and an art-director retry and clear error for empty plans

  **306 tests pass; lint and typecheck are clean.**

- **The three phase 4 failures are all caught now.** On a replay of the phase 4 outputs, the image rules flag 4 of 4 broken winners with no false alarms. The judge flags the same 4, plus 5 more winners I had labeled fine. On a second look, all 5 have real defects.
- **Pairwise: the fixed version wins 40 of 42** blind before/after pairs; the 2 ties are identical designs. It says tie on 3 of 3 identity controls, and the two orders never disagreed.
- **Generate eval with everything on (14 prompts):**
  - all 14 completed (2 failed before)
  - the fix loop ran on 9 (0 before), with 15 regenerations (0 before)
  - the judge flagged 9 winners and shipped 6
  - every design it didn't ship still has a visible keyed-cutout defect that it named
  - the loop can't fix those, because BiRefNet never ran on this machine (under 7.5 GB free), so every regenerated subject goes through the same keyer
- **The eval found three real bugs in my own design.** All are fixed and tested:
  1. The fixer **hid the product** (opacity 0) to clear its issues.
  2. A regeneration that only **looked** like progress while the judge's finding was suspended got shipped.
  3. The judge was asked twice about the same design and **changed its mind**.
- **Spend: $5.45 of the $8 cap.** It's all in `packages/generate/eval/results/spend-ledger-phase5.json`.

## What got built

| Piece                   | Where                                                                                       | Notes                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cutout-quality` rule   | `packages/checker/src/core/cutout-quality.ts`, `rules/cutout-quality.ts`                    | Six signals from the cutout's alpha (bites, see-through, fragments, leftover backdrop, uncut, jagged edges). Pure TypeScript, isomorphic                                                                                |
| `image-text` rule       | `packages/checker/src/core/rules/image-text.ts`, `src/node/image-analysis/text-detector.ts` | PP-OCRv5 mobile det finds text-like boxes; the en PP-OCRv5 recognizer confirms them (≥ 3 characters at ≥ 0.8). Both Apache-2.0, pinned by commit, size and SHA-256, downloaded from Hugging Face on first use           |
| Image analysis plumbing | `packages/checker/src/core/image-analysis.ts`, `src/node/image-analysis/index.ts`           | A new rule requirement, `images`: per-image analysis computed before the check (like saliency), cached by `src`. Opt-in `imageRules`; `--image-checks` on `redline check` / `redline fix`; `redline setup image-checks` |
| Generation integration  | `packages/generate/src/node/{workspace,pipeline,cutout}.ts`                                 | Image rules on by default for generated and stock images (never the user's). A damaged cutout is re-cut with two other keyer settings, and the best cut is kept                                                         |
| Vision judge            | `packages/generate/src/judge/`                                                              | Opus 5.5 by default, its own prompt, structured output (Zod), retried once. Findings become `visual-judge` issues with element fingerprints. Up to 3 reviews per design; the final design is the best reviewed one      |
| `key-element-visible`   | `packages/generate/src/key-elements.ts`                                                     | Generation mode: a planned product, headline, CTA or logo can't be faded, hidden, removed or pushed off-canvas (added after the eval caught the fixer doing it)                                                         |
| Blind pairwise mode     | `src/judge/pairwise.ts`, `eval/pairwise.ts`                                                 | Two renders and the brief only, both orders, a win only when both agree                                                                                                                                                 |
| Reliability             | `src/providers/replicate.ts`, `src/director/anthropic.ts`, `src/plan.ts`                    | Per-request timeouts and a 5-minute image deadline. Empty plans get a third, sharper try; partial plans keep their usable layouts; otherwise `ArtDirectorError`                                                         |
| Evals                   | `eval/replay.ts`, `eval/pairwise.ts`, `eval/run.ts`, `eval/labels-phase4.json`              | Replay on the phase 4 outputs against hand labels; pairwise over the fix-loop eval; the generate eval with catch and agreement stats                                                                                    |

## 1. Replay on the phase 4 outputs

`npm run eval:replay -w packages/generate`. Result: `packages/generate/eval/results/2026-10-08T17-11-27-484Z_replay-phase4.json`.

The phase 4 run (`2026-10-07T21-23-33-175Z`) has 12 winners and 48 candidates. Before running anything, I labeled every subject cutout by eye: I put them on a magenta background in a grid, and found 9 of 26 damaged. I also labeled every text-detector hit at full size. The labels are in `eval/labels-phase4.json`.

**Labeling corrections, both disclosed in the labels file:**

- `cutout-quality` flagged a pizza cutout that my first pass skipped, because its file isn't named `sub*`. I checked it, it's damaged, and I added it.
- A FLUX-drawn laptop UI with small labels is marked **debatable**, not text-in-image.

**Image rules:**

| Check                         | True positive | False positive           | Missed                       | True negative |
| ----------------------------- | ------------- | ------------------------ | ---------------------------- | ------------- |
| `image-text` (48 candidates)  | 1             | 2 (laptop UI, debatable) | 1 (vertical neon letters)    | 44            |
| `cutout-quality`, any flag    | 20            | 2 (laptop: warning)      | 0                            | 26            |
| `cutout-quality`, errors only | 16            | 0                        | 4 (headphones: warning only) | 28            |
| Winners flagged (either rule) | 4 of 4 broken | 0 of 8 fine              |                              |               |

The cutout thresholds were tuned on these same 26 images, so expect worse on new ones. The 4 warning-only misses are the grey disc inside the headphones' headband. In pixels it looks like a white laptop screen, so the rule only escalates leftover backdrop to an error when another signal backs it up.

**Judge on the 12 winners (Opus 5.5, `medium`, $0.19):**

- **It flagged all 4 labeled problems:**
  - yoga: "a ghost pill-shaped button with gibberish text…"
  - skincare: "upper half of the bottle eaten away…"
  - coffee: "glass floats… wrong scale and perspective". That's the composition problem no rule can see.
  - headphones
- **It flagged 5 winners I'd labeled fine, and all 5 hold up when I look again:**
  - a faint "Nlá… nlé" gibberish strip along the bottom of the SaaS background, which the OCR missed
  - a white halo around the pets
  - a hard overlay seam through the bookstore table
  - a leftover plate rim around the pizza
  - a shadow slab under the sneaker

  They're listed as `secondPass` in the labels file and scored separately, since the judge found them.

- **It passed 3:** charity and farmers-market are fine. Summer-sale's floating towel is a real miss.
- **With the prompt as first written,** it also flagged every `[Date]` / `[Venue]` placeholder, which the director writes on purpose (4 winners). I fixed the prompt and re-ran; the placeholder findings are gone, and the 4 real catches remained.

## 2. Blind pairwise on the fix-loop eval

`npm run eval:pairwise`. Result: `packages/generate/eval/results/2026-10-08T16-57-43-442Z_pairwise_claude-opus-5-5.json`. Renders: `out/eval-pairwise/2026-10-08T16-57-43-442Z/`.

The pairs come from the strict-mode fix eval (`2026-10-07T01-25-38-380Z`): each of the 21 fixtures before, and run 1's best design for Sonnet and for Opus. That's 42 pairs. As you asked, the judge saw **only the two renders and a one-line brief**. The 51 pairs took 102 calls and cost $1.13.

| Comparison                    | Result                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| Fixed vs original (42)        | **after 40, before 0, tie 2** (both ties are `clean-poster`, unchanged by the loop) |
| By fixer                      | Sonnet 20/21, Opus 20/21                                                            |
| Identity controls (3)         | **3 ties**                                                                          |
| LLM fix vs rules-once fix (6) | LLM 6, rules-once 0                                                                 |
| Orders that disagreed         | 0 of 51; first-shown pick rate 0.50                                                 |

**What this does and doesn't show:**

- **This benchmark is easy for a judge.** Most "before" fixtures are deliberately broken, so a 95% win rate mostly shows that the judge isn't contrarian, has no position bias, and isn't fooled by "something changed".
- **The subtle pairs are the informative ones,** and its reasons hold up: a few-pixel misalignment (`misaligned`), a recolored decoration (`hard-attention-burst`), a CTA grown from gray to orange (`hard-story-hero`).
- **It also names regressions inside wins.** On `hard-attention-badge` the fix left "SPOTS LEFT" nearly unreadable. On `off-canvas` it pulled a stray red circle into view. I confirmed both by eye, and both pass the rules.
- **Against rules-once, its reason is the known phase 4 weakness:** a washed-out grey headline, or a CTA label turned grey.

## 3. Generate eval with the checks and the judge on

The settings are the same as the phase 4 run, plus the image rules and the judge (Opus 5.5, `--judge-rounds 2`). I ran it twice; I fixed the bugs the first run found, then ran it again.

### First run (`2026-10-08T17-11-49-703Z`, $1.83): what it found

- **All 14 prompts completed.** jazz-night had failed on empty plans before, and tech-conference on the Replicate timeout.
- **The fix loop ran on 11 of 14,** with 13 regenerations; 12 were for cutouts.
- **Bug 1: the fixer hid the product.** On coffee-latte, out of regenerations, the fixer set the damaged product to opacity 0: "hide the damaged cutout to remove the ragged grey slab". That cleared `cutout-quality` (it skips invisible images) and suspended the judge's finding, so the rules scored 100. The re-judge said "the product image slot shows no visible latte", but it was the last round, so a latte ad shipped without its latte.
  - **Fix:** `key-element-visible`, plus a prompt line saying hiding isn't a fix. Tested.
  - **Live re-run:** the product stayed at opacity 1.
- **Bug 2: a regeneration that only looked like progress.** On the yoga re-run, the winner's subject was rules-clean, with one high-severity judge finding (a grey patch). A regeneration produced a subject with a rules-visible cutout error. The loop accepted it, because the judge's finding on the old image was suspended. Both later reviews said it was worse.
  - **Fix:** the final design is now **picked among the reviewed designs**: fewest errors (rules errors + high findings), then medium findings, then the rules' score. Tested.

### Final run (`2026-10-08T18-00-25-677Z` + bookstore, $1.58), at commit `664ae04`

The eval's own low-memory guard skipped bookstore-event (1.4 GB free), so I ran it separately right after.

| Prompt            | Size      | First | Best-of-4 (rules) | Image rules on winner | Judge verdicts           | Iterations | Regenerations | Re-cuts | Final (rules) | Final judge    | Cost   |
| ----------------- | --------- | ----- | ----------------- | --------------------- | ------------------------ | ---------- | ------------- | ------- | ------------- | -------------- | ------ |
| charity-5k        | 1080×1350 | 69    | 84                | cutout                | reject → fix             | 1          | 1 (1 kept)    | 1       | 100           | fix            | $0.121 |
| coffee-latte      | 1080×1080 | 53    | 64                | cutout                | reject → reject → reject | 8          | 2 (2 kept)    | 4       | 84 (1 err)    | reject         | $0.255 |
| sneaker-drop      | 1080×1920 | 100   | 100               | –                     | fix → fix                | 1          | 1 (1 kept)    | 0       | 100           | fix            | $0.090 |
| saas-banner       | 1200×628  | 67    | 100               | –                     | ship → ship              | 0          | 0             | 0       | 100           | ship           | $0.046 |
| jazz-night        | 1080×1350 | 94    | 100               | –                     | ship → fix               | 0          | 0             | 0       | 100           | ship (round 0) | $0.075 |
| summer-sale       | 1080×1080 | 94    | 94                | cutout                | fix → fix                | 1          | 1 (1 kept)    | 0       | 100           | fix            | $0.092 |
| farmers-market    | 1080×1920 | 76    | 100               | –                     | fix → ship               | 3          | 2 (2 kept)    | 1       | 94            | ship           | $0.132 |
| headphones-launch | 1500×500  | 88    | 94                | cutout                | fix → reject → reject    | 6          | 2 (2 kept)    | 0       | 94            | reject         | $0.132 |
| yoga-retreat      | 1080×1350 | 100   | 100               | –                     | ship → ship              | 0          | 0             | 1       | 100           | ship           | $0.052 |
| pizza-delivery    | 1200×628  | 74    | 97                | –                     | fix → fix                | 3          | 2 (1 kept)    | 1       | 100           | fix            | $0.109 |
| tech-conference   | 1080×1080 | 100   | 100               | –                     | ship → ship              | 0          | 0             | 0       | 100           | ship           | $0.053 |
| pet-adoption      | 1080×1350 | 84    | 100               | –                     | reject → fix → fix       | 5          | 2 (2 kept)    | 2       | 94            | fix            | $0.210 |
| skincare-serum    | 1080×1920 | 79    | 84                | cutout                | fix → fix → fix          | 3          | 2 (2 kept)    | 3       | 100           | fix (round 1)  | $0.166 |
| bookstore-event   | 1500×500  | 67    | 100               | –                     | ship → ship              | 0          | 0             | 1       | 100           | ship           | $0.050 |

**How often each check fires, and what the loop does:**

|                                                            | Phase 4 | Phase 5 final                                       |
| ---------------------------------------------------------- | ------- | --------------------------------------------------- |
| Prompts completed                                          | 12 / 14 | **14 / 14**                                         |
| Winners flagged by `image-text` / `cutout-quality` / judge | –       | 0 / 5 / **9**                                       |
| Candidates flagged by `image-text` / `cutout-quality`      | –       | 6 / 22 of 56                                        |
| Damaged cutouts re-cut at cutout time (re-cut kept)        | –       | 14 (10)                                             |
| Fix loop ran                                               | 0 / 12  | **9 / 14**                                          |
| Regenerations attempted (kept)                             | 0       | **15 (14)**: 14 for cutouts, 1 for text in an image |
| Judge reviews / cost                                       | –       | 32 / $0.46                                          |
| Final designs the judge would ship                         | –       | 6 / 14                                              |
| Cost per design                                            | $0.039  | $0.113                                              |

**Judge agreement with the rules** (all 32 reviews; "rules pass" means score ≥ 95 with no errors):

|                  | Rules pass | Rules flag |
| ---------------- | ---------- | ---------- |
| **Judge flags**  | 11         | 11         |
| **Judge passes** | 9          | 1          |

- **Judge flags what the rules passed: 11 of 32 reviews.** I looked at every final render and checked the subtle claims at full size. In every case I checked, the judge was right: a white patch between a runner's arm and torso, white fill between a tote's handles, a grey plate crescent around the pizza, a shadow ellipse under a sneaker, a ragged dropper bulb, and a malformed trumpet ("an elongated straight tube… bell pointing down", phase 5 first run).
- **Judge passes what the rules flagged: 1.** farmers-market, where `cutout-quality` warns about the basket edge. It looks acceptable to me.

**What's left:**

- **The 8 designs the judge didn't ship all still have a keyed-cutout defect,** and the judge named each one: coffee, headphones, pet, skincare, charity, pizza, sneaker, summer.
- **Regeneration doesn't fix them.** A new FLUX subject goes through the same keyer, and FLUX tends to draw a floor, mat or shadow under it, which comes out as a slab. This is the main finding of the eval. On this machine (under 7.5 GB free), cutout quality is the bottleneck, and the checks now **report** it honestly instead of shipping a 100.
- **`image-text` fired correctly in the wild:**
  - a fake white button behind the CTA (jazz-night candidate, first run)
  - an "ARKET" sign painted behind the headline (farmers-market #1)
  - fake book-spine lettering (bookstore)

  Each lost best-of-N. One 58×7 px hit on a headphones background I can't confirm, so I count it as a likely false alarm.

**One wasted call per prompt in this run:** when the loop made no edits, the judge reviewed the identical design again. On jazz-night it said ship, then fix, about the same pixels. That's a direct measurement of its run-to-run variance. Fixed after this run (`3f388f4`): an unchanged design isn't re-reviewed.

## What the judge gets wrong

- **Misses:**
  - summer-sale's floating towel (phase 4 replay)
  - a small teal blob above "DROP" on sneaker-drop (phase 4)
  - in the final run, nothing I could find in the 6 it shipped
- **Wrong category:** it called the yoga gibberish button "composition" in both replay runs, even after the prompt asked for `fake-text`. The description was right.
- **Understated severity:** pet-adoption's white slab under the animals got "fix", where I'd say "reject".
- **Run-to-run variance:**
  - the same jazz-night design got ship, then fix
  - the headphones' grey disc was high-severity in one replay run and absent in the next, which listed only the floating shadow
- **Taste findings:** low-severity notes like "skyline ends short of the right edge", "highway reads more as driving than running" or "panel bottom a little empty". Each costs 1 point in the CLI's combined score (0.5 × weight 2), never an error.
- **No hard false alarms on visual defects:** I couldn't find a high or medium finding that wasn't really there, once placeholders were excluded. That's over 95 reviews (24 in the replay, 71 in the generate runs), not all of which I checked at full size, so it's a small sample.

## Reliability fixes

- **Replicate:**
  - Every request has its own timeout: create 90 s (the server waits up to 60 s), poll 30 s, download 60 s.
  - Each image has a 5-minute deadline that retries and rate-limit waits respect.
  - The 2-hour stall was most likely a hung `fetch`: the ledger had nothing between 17:24 and 19:32, and the old 120 s limit only applied between polls.
  - **No timeout fired in either phase 5 run.** Tests cover a hung request and a deadline.
- **Art director:**
  - If both answers have empty layouts, there's a third try that says exactly what was missing, at effort `low`.
  - If only some layouts are empty, the usable ones are kept.
  - Otherwise it throws `ArtDirectorError` with each try's problems, and the eval records it as `director-failed`.
  - **In 30 live plans across the phase 5 runs, the first answer came back with an empty `layouts[0]` 4 times** (charity-5k, yoga-retreat twice, pet-adoption). The existing single retry fixed each one, and no prompt failed. The new third try and the partial-plan salvage were never needed live, so they're covered only by tests.

## Decisions worth explaining

- **The image checks live in the checker, not in `generate`.** They follow the attention rules' pattern: async analysis up front, synchronous rules after. That's how `redline check --image-checks` and `redline fix --image-checks` came for free. Generated and stock images get errors for `image-text`; your own images get warnings.
- **Detector plus recognizer, not detection alone.** The DBNet detector alone fires on rows of trees and crates of oranges. CTC character count and confidence from the recognizer separate those cleanly (trees: 4 characters at 0.71; the yoga pill: 21 at 0.98), with no dictionary needed.
- **Fingerprints, not re-judging every step.** The judge costs about $0.015 and a few seconds a call, so findings are tied to what they're about and suspended when that changes, and the next review arbitrates. The eval showed the weakness of that (bug 2), and the final-pick rule closes it.
- **Opus judges, Sonnet fixes.** Independence was the goal. The cost is about $0.46 for 32 reviews.
- **No server-side refusal fallback for the judge.** The Claude API skill suggests enabling `fallbacks` by default for Opus 5.5. I left it off, as for the fixer and the director: a silent switch to another model would break the judge's independence. No refusals happened.

## Spend

**$5.45 of $8**, itemized in `packages/generate/eval/results/spend-ledger-phase5.json` (529 entries):

| Item                                                      | Cost  |
| --------------------------------------------------------- | ----- |
| Pairwise eval (incl. a 1-fixture cost probe)              | $1.22 |
| Replay judge, two runs                                    | $0.39 |
| Generate eval, first run                                  | $1.83 |
| Live re-run of coffee-latte + yoga-retreat with the guard | $0.43 |
| Generate eval, final run + bookstore                      | $1.58 |

**One accounting slip:** a relative `--ledger` path was resolved inside `packages/generate` (npm runs workspace scripts there), so the first generate run wrote to a second ledger file. The spend was still capped by that run's own `--budget 4`. I merged the entries back into the phase ledger and fixed the path handling (`c1a3146`).

## What you need to do

1. **Run the generate eval on a machine with ~8 GB free memory,** so BiRefNet does the cutouts. About $1.60, and it uses the phase 5 ledger if you pass `--ledger packages/generate/eval/results/spend-ledger-phase5.json`. Every remaining defect in this eval came from the keyer, so this is the biggest open question: how much of it BiRefNet removes, and whether `cutout-quality`'s thresholds (tuned on keyer cutouts) hold up on BiRefNet's soft edges.
2. **Licenses:** PP-OCRv5 det and rec are Apache-2.0, but their training data isn't documented (NOTICE). Get the same legal review as for BiRefNet and MSI-Net before commercial use.
3. **Review and merge `phase-5-judge`** when you're happy. Nothing is pushed.

## Suggestions

- **Ask for a transparent background, or use BiRefNet as a hard requirement for subjects,** instead of the keyer. Alternatively, have FLUX draw the subject _in_ the scene and skip the cutout.
- **Teach regeneration about the cutout.** Today the brief says "no shadow, no surface", and FLUX still draws one. Re-cutting with BiRefNet first, or rejecting a regenerated subject that fails `cutout-quality` before it reaches the loop, would save the regeneration budget.
- **Use the judge as a best-of-N tie-breaker.** Several candidates often score 100 by the rules, while the judge would rank them. That's about $0.06 per prompt for 4 candidates.
- **Calibrate the judge's severities against a few human ratings,** and consider making its low findings free, so taste doesn't move scores.
