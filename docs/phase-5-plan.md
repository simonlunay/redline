# Phase 5 plan: catch designs that pass every rule but still look wrong

Written 2026-10-08. **Waiting for approval before any code.** Branch `phase-5-judge` (created from
`main` at `5190ddf`). Small commits, no push, no merge.

## The problem, from the last eval

In `2026-10-07T21-23-33-175Z`, 3 of 12 winners scored 100 but look wrong. I re-opened the renders:

| Prompt                    | What's wrong                                                                                     | What a check would need to see                                |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| yoga-retreat              | FLUX drew a pill with "Fore tob'x cort terte" under the CTA; it reads as a second, broken button | Text-like pixels inside the background image                  |
| skincare-serum            | The keyer bit a notch out of the bottle's shoulder and left it see-through                       | A cutout whose alpha has bites / partial transparency inside  |
| coffee-latte              | The latte glass is torn and partly see-through; it also floats oddly above a cup on the table    | Same alpha problem; the floating/scale problem is a judge job |
| (minor) headphones-launch | A white disc of leftover backdrop under the headphones                                           | Opaque backdrop-colored regions kept inside the cutout        |

Non-winners with the same defects also scored 100 (sneaker-drop #2/#4: whole photo rectangle kept;
charity-5k #2/#4: white backdrop slabs). Today best-of-N could pick them on a tie.

Two reliability failures: **jazz-night** (empty layouts from the art director on both tries) and
**tech-conference** (Replicate timeout). Also, **charity-5k took 2 h 10 min**: the ledger shows
nothing between 17:24:13 and 19:32:48. The provider's 120 s timeout only applies between polls; a
single `fetch` that never returns (POST with `Prefer: wait=60`, a poll, or the image download)
has no timeout at all. That is the most likely cause; a sleeping laptop is the other.

## Overview

```
candidates ──► checkAsync + image-text + cutout-quality (deterministic, cached per image)
                 │
                 ▼
            best of N (these rules now affect the ranking)
                 │
                 ▼
            vision judge (independent model + prompt) on the winner's clean render
                 │ findings → visual-judge issues (errors / warnings / info)
                 ▼
            fix loop (layout edits, regenerateImage, re-cut) ──► re-judge best ──► one more
            round if the judge still reports errors (capped)
```

## 1. Deterministic image checks

Both run once per image file (generated or stock, **never user-supplied images**, since logos and
product shots legitimately contain text), are cached by `src`, and are exposed to the synchronous
checker as two **generation-mode rules** in `packages/generate`, passed through the existing
`extraRules` hook next to `copy-grounded`. Doing the async work up front matches how the checker
already treats pixels ("decoded ahead of time, `check()` stays synchronous").

Because they're rules, they count in the **best-of-N ranking** too, so broken candidates lose ties.

### 1a. `image-text`: text drawn into an image

- **Model:** PaddleOCR **PP-OCRv5_mobile_det** (DBNet text detector, ~4.7 MB, **Apache-2.0**), ONNX
  export from Hugging Face. Run with `onnxruntime-node`, which we already ship for BiRefNet.
  Downloaded on first use into the Redline cache, pinned by commit, size and SHA-256 like
  BiRefNet and MSI-Net (I'll verify the license file and pin the exact revision before using it).
  Detection only, no recognition: gibberish isn't recognizable anyway, and detection is what
  catches it. If I find the detector alone gives too many false alarms on textures, I'll add the
  matching PP-OCRv5 mobile recognition model (also Apache-2.0) as a filter, and say so.
- **Fallback:** no model available (offline, download failed) → the rule reports nothing and the
  run prints a warning. It never blocks generation.
- **Mapping:** detected boxes are mapped from image pixels to canvas pixels through the element's
  fit/crop (cover or contain), clipped to the canvas, and dropped if they're fully under an
  opaque element (a box hidden behind a panel doesn't matter).
- **Issue:** `error` in generation mode, weight 3 (like `copy-grounded`, so a design with baked-in
  text can't reach the target). Message: "background has text-like marks at (x, y, w, h), about N
  px tall". Suggested fix: `regenerateImage` with the brief plus a stronger suffix ("absolutely no
  text, lettering, signs, labels, buttons or UI elements"), which the loop's existing
  regeneration path accepts. Small boxes (under ~1% of the canvas's short side tall) and
  low-confidence ones are ignored.
- **Threshold tuning:** on the existing eval images (48 candidates' backgrounds + subjects in
  `out/eval-generate/2026-10-07T21-23-33-175Z_*`) and the 10 fixture photos. I'll report the
  hit list and every false alarm.

### 1b. `cutout-quality`: damaged cutout edges

Computed from the cutout PNG's alpha (and the backdrop color estimated from the pre-cutout image,
which the pipeline already has), all pure TypeScript, unit-testable on synthetic masks:

| Signal                   | How                                                                                                                                        | Catches                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| **Bites / holes**        | Area gained by a morphological closing of the opaque mask with a radius of ~3% of the subject's size, relative to the mask area            | skincare notch, latte tears  |
| **Partial transparency** | Share of the subject's pixels with alpha between 10% and 90%, excluding a thin edge band (soft edges are fine, a see-through bottle isn't) | see-through latte and bottle |
| **Edge noise**           | Contour length of the raw mask vs. the same mask after open+close smoothing (jaggedness ratio)                                             | jagged keyer edges           |
| **Fringe / halo**        | Share of the edge band whose color is within ΔE ~8 of the backdrop color                                                                   | grey/white halos             |
| **Leftover backdrop**    | Largest connected opaque region within ΔE ~6 of the backdrop color, as a share of the subject                                              | headphones disc, white slabs |
| **Uncut**                | Opaque mask touches ≥ 3 image borders, or covers > 90% of the image                                                                        | sneaker photo rectangle      |

- Severity: `error` when a signal is clearly past its threshold (or two are past the warning
  level), `warning` otherwise. Thresholds tuned on the eval's 18 keyed cutouts, which I'll label
  by eye first (good / damaged), and on synthetic masks in tests. I'll report the confusion
  table rather than claim it works.
- **Fixes, in order of cost:**
  1. **Automatic re-cut at cutout time, no LLM:** if a keyed cutout fails and BiRefNet can run
     (memory permitting), re-cut with BiRefNet; else re-key with a tighter tolerance. Keep
     whichever scores better on these signals.
  2. **In the fix loop:** the issue suggests `regenerateImage` for the subject ("isolated on a
     plain, evenly lit mid-grey backdrop, no reflections, no shadow, no transparent or glass
     parts against the backdrop"), using the existing op and cap. A new image goes through
     cutout + checks again.
- **Limit to state in the README:** this machine usually has < 7.5 GB free, so BiRefNet rarely
  runs here and the keyer is what gets checked. The checks are model-agnostic.

## 2. Vision judge

New module `packages/generate/src/judge/` (isomorphic) with a `VisualJudge` interface, an
Anthropic implementation, and a scripted judge for tests.

### Independence

- **Different model by default:** the fixer and art director use Sonnet 5.5, so the judge
  defaults to **Opus 5.5** (`--judge-model`). If you set the same model for both, it still gets a
  separate system prompt and a fresh, stateless request.
- **What it sees:** the **clean** final render (not the annotated one, whose numbered boxes
  would look like defects), a compact element table (id, role, type, box), and the current issue
  list (rule id, severity, message, element ids) so it doesn't spend its findings on what the
  checker already reports. **It never sees** the fixer's edit reasons, summaries, history, the
  art director's plan or concept, or scores. The prompt text it gets is the user's prompt, so it
  can judge fit.
- **Output:** structured JSON (`output_config.format`, the same approach that fixed the director's
  empty plans), validated with Zod:

  ```ts
  { verdict: 'ship' | 'fix' | 'reject', summary: string,  // one or two sentences
    findings: [{ category: 'fake-text' | 'cutout' | 'artifact' | 'cropping' | 'color'
                           | 'composition' | 'legibility' | 'other',
                 severity: 'high' | 'medium' | 'low', elementId: string | null,
                 box: {x,y,width,height} | null, description: string,
                 suggestion: 'regenerate-image' | 'recut' | 'layout' | 'none' }] }
  ```

  Unknown element ids are kept but unattached (a whole-design finding); one retry on invalid JSON.

### How findings become issues

- A generation-mode rule `visual-judge` turns each finding into an issue: high → `error`, medium
  → `warning`, low → `info`; weight 2. The message is the judge's description; the suggested fix is
  `regenerateImage` (for `regenerate-image` / `fake-text` / `cutout` on a generated image), a
  re-cut, or none (the fixer decides the layout edit).
- **Staleness:** the judge can't run on every re-check (cost), so a finding is tied to a
  fingerprint of its element (src, box, crop, opacity). While the fingerprint is unchanged, the
  issue stays. Once the element changes, the issue is suspended until the next judgment. That
  lets the loop make progress, and the **re-judge is the arbiter**, so hiding or nudging an
  element can't fake a fix.
- **Rounds:** judge the winner → fix loop → judge the loop's best → if the judge still reports an
  error and rounds are left, one more fix loop from there. Defaults: `--judge-rounds 2`, so at
  most **3 judge calls** per design. The final verdict and findings go into `.generation.json`
  and the contact sheet.
- Flags: `--judge anthropic|none|scripted` (default `anthropic` when there's a key, else `none`),
  `--judge-model`, `--judge-rounds`. All judge calls go through the spend ledger.

### Blind pairwise mode (for evaluation)

`judgePair(prompt, imageA, imageB)` → `{ winner: 'A' | 'B' | 'tie', confidence, reasons }`. The
order is shuffled with a seeded RNG, the prompt names them only "Image 1 / Image 2", and the caller
maps the answer back. Each pair is judged **in both orders**; a pair counts as a win only if both
orders agree, otherwise as a tie (this cancels the judge's position bias, which I'll also report).
No scores, issue lists or labels like "before/after" are shown.

## 3. Generation reliability

- **Replicate timeouts:** every request (`POST`, each poll, the download) gets its own
  `AbortSignal.timeout` (POST 90 s, since it waits up to 60 s server-side; poll 30 s; download
  60 s), and the whole `generate()` call gets an overall deadline (default 5 min, including
  429 waits) that the retry loop respects. An aborted request counts as a network failure and is
  retried within the deadline. On a final timeout the error names the stage and the prediction id,
  and the pipeline already falls back per image. Tests use fake timers / a never-resolving fetch.
- **Empty plans from the art director:** today an empty layout on both tries fails the prompt.
  - Retry 1 (as now) quotes the problem. A plan with no usable layout gets **one extra retry**
    with a sharper message ("your previous response had layouts with no elements; each layout
    needs texts, shapes and images arrays with at least a background image, a headline and a
    CTA") and a different sampling path (effort `low`). That's a guess, not something phase 4
    measured, so the eval will report how often each retry was needed and whether it worked.
    Maximum 3 director calls, all budget-guarded.
  - If only some layouts are empty, keep the valid ones instead of failing (one good layout is
    still a usable plan; candidates then vary by background).
  - If all tries fail, throw a clear `ArtDirectorError` with the attempts and the problem list;
    the eval records it as `director-failed` rather than a generic failure.

## 4. Eval

Budget: **$8 for the whole phase**, enforced by a new ledger file
`packages/generate/eval/results/spend-ledger-phase5.json` with `capUsd: 8` (the old one stays
as the phase 4 record). Pricing from `packages/agent/src/pricing.ts` (Opus $4/$20, Sonnet $2/$10
per M tokens).

| Step                                                                                                                                                     | Estimate      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **A. Replay on the phase 4 outputs.** Deterministic checks on all 48 old candidates (free); judge on the 12 old winners                                  | ~$0.40        |
| **B. Full generate eval**, 14 prompts, checks + judge on, Sonnet fixer, Opus judge ≤ 3 calls                                                             | ~$2.5–3.5     |
| **C. Pairwise judge** on the strict-mode fix eval: 21 fixtures × run 1 of Sonnet and Opus = 42 before/after pairs, both orders (84 calls), plus controls | ~$2.0         |
| Development smoke runs                                                                                                                                   | ~$0.5         |
| **Total**                                                                                                                                                | **~$5.5–6.5** |

- **A** gives the cleanest catch-rate numbers, because we already know the ground truth (3
  winners + 4 non-winners with visible defects). Report per check: winners caught, candidates
  caught, false alarms.
- **B** report: per prompt, which check fired on the winner, whether the fix loop ran,
  iterations, regenerations attempted / kept, re-cuts, judge verdict before/after, final score,
  cost; plus totals vs. the phase 4 run (fix loop ran 0/12, regenerations 0/12).
- **C** report: win rate of the fixed version (both-orders agreement), ties, position-bias rate
  (how often the verdict flips with order). Controls: `clean-poster` vs. itself (should be a tie)
  and a few **rules-once** outputs known to look worse (e.g. the grey CTA label), to check the
  judge isn't just preferring "after".
- **I'll look at every output myself** and list where the judge is wrong: false alarms, misses,
  wrong element ids, and anything it calls fine that I'd call off.
- If the ledger gets within $1 of the cap I stop and report what's left instead of trimming
  silently.

## 5. Tests, docs, commits

- **Tests, all mocked, no network, no spend:** text-detector post-processing on a fixture image
  with drawn text vs. a plain photo (real model only if cached, like the saliency smoke test);
  box mapping through cover/contain; each cutout signal on synthetic masks (notch, hole,
  see-through, halo, slab, uncut); the judge with a fake Anthropic client (schema, retry, unknown
  ids, that the request contains no fixer reasoning or annotated image); staleness and judge
  rounds in the pipeline with a scripted judge; pairwise order shuffling and mapping back;
  Replicate per-request timeouts and the overall deadline; director empty-plan retry, partial
  plans and the final error.
- **README:** a "Visual checks and the judge" section: how each check works, what it can't see,
  the judge's independence rules, the pairwise mode, costs, and the model/license table updated
  (PP-OCRv5 det Apache-2.0; NOTICE too). Eval results replace the phase 4 "looks off" column with
  measured catches.
- **Report:** `docs/phase-5-report.md` at the end, same shape as phase 4's.
- **Commit order:** reliability fixes → cutout-quality → image-text → judge + rules → pipeline
  rounds + CLI → pairwise + eval scripts → eval results → docs. Lint, typecheck and tests pass at
  every commit.

## Decisions I'd like you to confirm

1. **Judge model: Opus 5.5** (independent from the Sonnet fixer, ~2× the cost per call). The
   alternative is Sonnet with a separate prompt, which halves judge cost but is less independent.
2. **New checks only in `redline generate`**, not in `redline check` / `redline fix` for user
   designs (user photos and logos legitimately contain text). Easy to expose later as opt-in.
3. **Separate $8 ledger** for this phase, rather than raising the cap in the old one.
