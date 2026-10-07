# Phase 4 report: text-to-design generation

Branch `phase-4-generation`, merged into `main` on 2026-10-07. Nothing published to npm; `packages/generate` stays private. Run dates: 2026-10-06/07.

## TL;DR

- **Built and tested:**
  - Phase 4a: the art director, layered images with cutouts, best-of-N, the fix loop, the manifest, the CLI and the contact sheet.
  - Phase 4b: image regeneration inside the fix loop, generation mode only, capped.
  - **265 tests pass. Lint, typecheck and build are clean.**
  - A new checker rule, `label-centered`, catches button labels that aren't centered as rendered (see below).
- **Works live:** `redline generate "poster for a charity 5K, energetic, blue and orange"` produced 4 candidates scoring 76 / 100 / 58 / 100. The winner was 100 and the run cost $0.052. The contact sheet is `out/live1/steps/contact-sheet.png`. That image predates the CTA-label fix, so the button labels sit high in it; re-assembling the same plan with today's code centers them (`out/verify-center/before-after.png`).
- **The full 14-prompt eval ran** (2026-10-07, `--concurrency 1 --budget 5`): 12 of 14 completed. The first candidate hit the target on 7 of 12, best-of-4 on 12 of 12, and neither the fix loop nor a regeneration was ever needed. Three of the twelve winners score 100 but look wrong (see below).
- **Total spend: $1.37 of the $15 cap.** That's Claude plus FLUX, including debugging calls. The ledger is `packages/generate/eval/results/spend-ledger.json`.

## What got built

| Piece                    | Where                                                               | Notes                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan format + validation | `packages/generate/src/plan.ts`                                     | Zod schema plus semantic checks: one headline per layout, slots exist and are used, boxes inside the canvas, hex colors, fonts available, `calmAreas` on every background, **no copy inside image briefs**. Errors are fed back for one retry |
| Art director (Claude)    | `src/director/anthropic.ts`                                         | Structured JSON output (`output_config.format`), cached system prompt, sees user images, spend-guarded                                                                                                                                        |
| Template director        | `src/director/template.ts`                                          | Deterministic, offline; for tests and `--director template`                                                                                                                                                                                   |
| Image prompts            | `src/image-prompt.ts`                                               | Text zones computed from the layout's boxes, plus "no text, no letters, no logos" on every prompt                                                                                                                                             |
| Image providers          | `src/providers/*`, `src/node/mock-provider.ts`                      | Replicate FLUX.1 [schnell] (rate-limit aware), Pexels (only tested against fakes; no key), user images, deterministic mock                                                                                                                    |
| Cutouts                  | `src/node/cutout.ts`                                                | BiRefNet_lite ONNX, pinned by commit, size and SHA-256 from Hugging Face (not re-hosted), with a backdrop-keying fallback                                                                                                                     |
| Assembly                 | `src/assemble.ts`                                                   | Cover-fit backgrounds, aspect-true subjects and logos, CTA labels centered in their buttons                                                                                                                                                   |
| Best-of-N                | `src/select.ts`, `src/node/pipeline.ts`                             | Layouts × background seeds, each scored with `checkAsync` (layout + attention), ranked by score, then errors, then warnings, then CTA attention                                                                                               |
| Fix loop                 | existing `runFixLoop`                                               | Runs on the winner                                                                                                                                                                                                                            |
| Regeneration op (4b)     | `packages/agent/src/{edits,loop,prompt}.ts`, `src/node/pipeline.ts` | `regenerateImage {elementId, brief, reason}`, generation mode only, cap 2, recorded in history and the manifest                                                                                                                               |
| Output                   | `src/node/assets.ts`                                                | `<name>.json`, `.assets/` + `manifest.json` (prompt, provider, model, seed, cost, license, cutout), `.candidates/`, `.generation.json`                                                                                                        |
| CLI                      | `redline generate`                                                  | All requested flags plus `--provider`, `--cutout`, `--director`, `--editor`, `--budget`, `--ledger`, `--max-regenerations`                                                                                                                    |
| Contact sheet            | `src/node/contact-sheet.ts`                                         | All candidates with score, CTA/headline share and heatmap, the winner outlined, the final design last                                                                                                                                         |
| Spend control            | `src/spend.ts`, `src/node/spend-file.ts`                            | Worst-case guard before each paid call, real cost after, persisted. The cap stored in the file can't be raised by a later run                                                                                                                 |
| Eval                     | `packages/generate/eval/` (`npm run eval:generate`)                 | 14 prompts, 5 sizes; `--offline` mode is free                                                                                                                                                                                                 |

## What didn't get done, and why

1. **The Opus comparison.** The Sonnet baseline now exists (below); the Opus run hasn't been done.
2. **Earlier eval attempts** (before the full run succeeded):
   - **Attempt 1 failed for two reasons:**
     - The art director returned plans whose layouts had no elements.
     - Replicate throttled us: accounts with under $5 of credit get 6 predictions per minute, burst 1.
     - Both are fixed and tested (see the decisions below).
   - **Attempt 2:** Claude Code stopped it because the machine was critically low on memory. Its notice said not to restart such a job automatically, so I didn't.
     - Two prompts had already failed with `fetch failed` network errors, now retried as well.
     - The cause was ONNX Runtime keeping BiRefNet's ~6 GB peak; fixed, and cutouts fall back to keying below 7.5 GB free.
3. **Live verification of 4b.** Regeneration is covered by unit tests: mock provider, scripted editor, cap, rollback, the `redline fix` refusal. It still has never fired with real Claude and real FLUX: in the full eval, best-of-4 always reached the target first.
4. **The Pexels provider** is implemented, but no `PEXELS_API_KEY` exists, so it's only tested against a fake `fetch`.

## Decisions worth explaining in interviews

- **A new package rather than a module in the agent.** Generation brings image APIs, a 224 MB cutout model and file I/O. `redline fix` users shouldn't pay for that. The dependency also only runs one way: generation uses the loop. The loop gets a small, generic, opt-in hook (`LoopOptions.regenerate`), and knows nothing about images or providers.
- **Structured output instead of a strict tool, for the plan.** I first used a strict tool, like `submit_edits`. Live, Sonnet 5.5 returned `layouts: [{ elements: [] }]` almost every time.
  - With `strict: false` the cause showed up: Claude was sending the deeply nested `layouts` parameter as a JSON _string_. With `strict: true` the grammar then forced an array, which collapsed to an empty one.
  - Moving the plan to `output_config.format` (the whole response is the JSON object) fixed it at once: two complete layouts.
  - I also flattened the element union into per-kind arrays, which turned out not to be the cause but is simpler.
  - Lesson: strict schemas guarantee the _shape_, not that the content is there. Validate the semantics too, which `validatePlan` does, and that's how this was caught.
- **The text-safe areas are computed, not trusted.** The image prompt always includes text zones derived from the actual layout boxes, on top of the art director's own `calmAreas`. In 4b, regeneration recomputes them from the _current_ (already edited) layout.
- **Text never goes into images.** This is enforced in three places:
  - the prompt rules
  - validation: a brief that contains the copy is rejected and retried
  - code: every image prompt ends with "No text, no letters…"
- **Subjects as separate layers.** A subject is generated on a plain backdrop and cut out locally. Its box is then trimmed to the visible pixels. That matters because overlap and attention are computed from boxes, so transparent padding would credit the subject with attention it doesn't get.
- **Best-of-N is cheap, and it's where most of the quality comes from.** On the one live run, candidate #1 scored 76, while two of the four scored 100 with no fix loop needed. Images cost $0.003 each; Claude calls cost $0.03–0.05 each.
- **The regeneration op only exists in generation mode.**
  - It's a separate Zod schema, and `parseEditResponse` accepts it only when asked to.
  - In `redline fix` it isn't in the tool schema or the prompt, and the src guardrail is unchanged. A test proves `redline fix` keeps every `src` even when the editor asks for a regeneration.
  - Regenerations are counted **when attempted**, because they cost money even when rolled back.
- **Spend safety.**
  - Worst-case guard before each call, real cost after, persisted.
  - Parallel image calls count against the cap while in flight, because a test caught three parallel calls all passing the guard at once.
  - Past the cap, candidate images fall back to the mock, while regenerations and Claude calls stop.
- **Deterministic seeds.** Seeds are derived from the prompt, so the same prompt gives the same candidates (tested with the mock).

## Eval table

Sonnet 5.5 (medium) + FLUX.1 schnell, 4 candidates, target 95, max 4 iterations, 2 regenerations allowed, `--concurrency 1 --budget 5`. Raw data: `packages/generate/eval/results/2026-10-07T21-23-33-175Z_generate_claude-sonnet-5-5.json`. Renders: `out/eval-generate/2026-10-07T21-23-33-175Z_claude-sonnet-5-5/<prompt>/steps/contact-sheet.png`.

| Prompt            | Size      | First  | Best-of-4 | Final | Iterations | Regenerations | CTA attention | Cost   |
| ----------------- | --------- | ------ | --------- | ----- | ---------- | ------------- | ------------- | ------ |
| charity-5k        | 1080×1350 | 100    | 100       | 100   | 0          | 0             | 12.2%         | $0.047 |
| coffee-latte      | 1080×1080 | 100    | 100       | 100   | 0          | 0             | 8.5%          | $0.052 |
| sneaker-drop      | 1080×1920 | 100    | 100       | 100   | 0          | 0             | 15.7%         | $0.040 |
| saas-banner       | 1200×628  | 100    | 100       | 100   | 0          | 0             | 9.9%          | $0.035 |
| jazz-night        | 1080×1350 | failed |           |       |            |               |               |        |
| summer-sale       | 1080×1080 | 56     | 100       | 100   | 0          | 0             | 8.8%          | $0.039 |
| farmers-market    | 1080×1920 | 100    | 100       | 100   | 0          | 0             | 8.9%          | $0.038 |
| headphones-launch | 1500×500  | 94     | 100       | 100   | 0          | 0             | 7.0%          | $0.039 |
| yoga-retreat      | 1080×1350 | 100    | 100       | 100   | 0          | 0             | 15.5%         | $0.031 |
| pizza-delivery    | 1200×628  | 100    | 100       | 100   | 0          | 0             | 8.6%          | $0.040 |
| tech-conference   | 1080×1080 | failed |           |       |            |               |               |        |
| pet-adoption      | 1080×1350 | 58     | 100       | 100   | 0          | 0             | 5.3%          | $0.040 |
| skincare-serum    | 1080×1920 | 94     | 100       | 100   | 0          | 0             | 7.1%          | $0.039 |
| bookstore-event   | 1500×500  | 88     | 100       | 100   | 0          | 0             | 7.0%          | $0.031 |
| **mean (12)**     |           | 90.8   | 100       | 100   | 0          | 0             | 9.6%          | $0.039 |

- **First candidate at target: 7 of 12.** The misses: text contrast over the photo (summer-sale 56, pet-adoption 58) and attention (headphones 94, skincare 94, bookstore 88).
- **Best-of-4 at target: 12 of 12.**
- **Needed the fix loop: 0. Needed a regeneration: 0.**
- **Failed: 2 of 14.** jazz-night: the art director returned plans with empty layouts on both tries. tech-conference: a Replicate prediction timed out.
- **Every cutout used the backdrop keyer**, since the machine had under 7.5 GB free, so BiRefNet never ran.

## Total spend

**$1.37** across all Claude and Replicate calls, out of the $15 cap. Itemized in `packages/generate/eval/results/spend-ledger.json`:

- the two charity smoke runs
- the aborted eval attempts
- the full eval run ($0.52)
- about 6 art-director debugging calls

## Scores well, looks wrong

From the first live charity run:

1. **CTA label not centered in its button.** "Register Now" sat at the top of the orange button, yet every candidate still scored 100. The cause: text renders from the top of its box, and the art director gave the label the button's full box. **Fixed twice:** assembly snaps labels (`centerButtonLabels`, verified on a fresh assembly of the same plan: text center 2px from the button center), and the new **`label-centered`** checker rule measures the wrapped text where it actually renders (via the `TextMeasurer`) against the shape it labels (same `groupId`, or the only text inside a shape below it). It suggests a resize + move, so `redline check`, `redline fix` and the fix loop catch it in any design. It scores the saved live design 84 instead of 100. Fixture: `fixtures/off-center-label.json`.
2. **Invented facts.** "Charity 5K · Saturday, June 14 · City Park" from a prompt with no date or venue. **Fixed** with the director rule plus the `copy-grounded` check. In the full eval: no invented facts; the director used `[Date]` / `[Venue]` placeholders instead.

From the full eval (winners that scored 100):

3. **yoga-retreat: text in the background image.** FLUX drew a gibberish pill ("Fore tob'x cort terte") right under the CTA despite "no text, no letters". It reads like a second, broken button. No rule looks for text baked into images.
4. **skincare-serum: broken cutout.** The keyer cut a notch out of the bottle's shoulder.
5. **coffee-latte: ragged cutout.** The latte glass has torn, partly see-through edges.
6. **headphones-launch (minor):** a white disc of leftover backdrop under the headphones.

Non-winners that also scored 100 but are clearly broken: sneaker-drop #2 and #4 (the "cutout" is the whole photo rectangle with a leg in it) and charity-5k #2 and #4 (white slabs of backdrop under the runner). Best-of-N happened to pick other candidates, but on a tie it could have picked these. All of 4–6 and these come from the keyer; BiRefNet would likely avoid most of them.

Also worth knowing:

- In the offline demo, the rules-only editor fixed contrast by turning the CTA label grey on orange. It passes but looks worse. Claude does better here, but nothing _measures_ it.

## Which images to look at first

1. `out/live1/steps/contact-sheet.png`: the demo. Four candidates (runners photo vs. cutout runner on a blue/orange background), their scores and heatmaps, and the final design.
2. `out/live1/charity.assets/`: the FLUX images. `layout2-sub2.png` is a BiRefNet cutout of the runner, trimmed to her visible pixels.
3. `out/live1/steps/candidate-3.png`: the 58-scoring candidate. Light text over the bright sunrise, which is exactly what the contrast rule and the 4b regeneration op are for.
4. `out/gen-smoke/steps/contact-sheet.png`: the offline pipeline (mock images, template director).

(`out/` is gitignored; these files exist only on this machine.)

## What you need to do

1. **Optional: rerun the eval with BiRefNet** on a machine with ~8 GB free (it costs about $0.55), to see how many of the cutout problems above go away, and run `--model claude-opus-5-5 --prompts <subset>` for the Opus comparison.
2. **Consider adding $5+ of Replicate credit.** That lifts the 6-per-minute throttle. Without it, each prompt waits about 10 s per image.
3. **Optional:** add `PEXELS_API_KEY` to `.env` to try stock backgrounds (`--provider pexels`).
4. **Licenses before any commercial use:** see NOTICE. BiRefNet's training data (DIS5K and others) has mixed image licenses. FLUX.1 schnell is Apache-2.0. MSI-Net's caveats are as before.
5. **`packages/generate` is marked `"private": true`** so it can't be published by accident. Remove that when you want to publish it.

## Suggestions

- **Check cutout quality.** Every broken design in the eval was a keyed cutout. A cheap check: compare the cutout's alpha coverage and edge roughness with what BiRefNet would give, or simply reject a keyed cutout whose mask touches the image border or keeps a large flat light region. Rejected cutouts can be regenerated.
- **Detect text inside generated images.** OCR (or a vision call) on each background; a hit triggers `regenerateImage`. The yoga-retreat winner is the case.
- **Add a vision-model aesthetic tie-breaker for best-of-N.** Several candidates often tie at 100, and they currently tie-break on warnings and CTA share.
- **Use BiRefNet fp16** (`model_fp16.onnx`, 115 MB) to halve the memory. Check its quality first, then pin it the same way.
- **Pass the art director's `calmAreas` to the contrast rule as a hint.** If text over an image fails contrast in a zone the brief promised would be calm, regeneration is the right fix. That's a strong signal for when to prefer `regenerateImage` over a scrim.
