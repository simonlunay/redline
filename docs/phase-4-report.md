# Phase 4 report: text-to-design generation

Branch `phase-4-generation`, not merged, not pushed, nothing published. Run date: 2026-10-06/07.

## TL;DR

- **Built and tested:**
  - Phase 4a: the art director, layered images with cutouts, best-of-N, the fix loop, the manifest, the CLI and the contact sheet.
  - Phase 4b: image regeneration inside the fix loop, generation mode only, capped.
  - **228 tests pass. Lint, typecheck and build are clean.**
- **Works live:** `redline generate "poster for a charity 5K, energetic, blue and orange"` produced 4 candidates scoring 76 / 100 / 58 / 100. The winner was 100 and the run cost $0.052. The contact sheet is `out/live1/steps/contact-sheet.png`. That image predates the CTA-label fix, so the button labels sit high in it.
- **Not done: the full 14-prompt eval.** My first attempt found two real bugs, both fixed. The host then stopped the second attempt because the machine was low on memory, and I was told not to restart it on my own. The eval harness is ready; the table below holds only the live runs I have.
- **Total spend: $0.43 of the $15 cap.** That's Claude plus FLUX, including debugging calls. The ledger is `packages/generate/eval/results/spend-ledger.json`.

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

1. **The full live eval and the Opus comparison.**
   - **Attempt 1 failed for two reasons:**
     - The art director returned plans whose layouts had no elements.
     - Replicate throttled us: accounts with under $5 of credit get 6 predictions per minute, burst 1.
     - Both are fixed and tested (see the decisions below).
   - **Attempt 2:** Claude Code stopped it because the machine was critically low on memory. Its notice said not to restart such a job automatically, so I didn't.
     - Two prompts had already failed with `fetch failed` network errors, now retried as well.
     - Likely memory cause: BiRefNet (fp32, 1024×1024 Swin) and MSI-Net in ONNX Runtime, with two prompts running in parallel.
   - **The Opus comparison** was skipped because the Sonnet baseline doesn't exist yet.
2. **Live verification of 4b.** Regeneration is covered by unit tests: mock provider, scripted editor, cap, rollback, the `redline fix` refusal. It has never fired with real Claude and real FLUX.
3. **The Pexels provider** is implemented, but no `PEXELS_API_KEY` exists, so it's only tested against a fake `fetch`.

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

## Eval table (what exists)

Sonnet 5.5 (medium) + FLUX.1 schnell, 4 candidates, target 95, max 4 iterations, 2 regenerations allowed.

| Prompt                  | Size      | First candidate | Best-of-4 | Final | Iterations | Regenerations | CTA attention (winner → final) | Cost   |
| ----------------------- | --------- | --------------- | --------- | ----- | ---------- | ------------- | ------------------------------ | ------ |
| charity 5K (smoke run)  | 1080×1350 | 76              | 100       | 100   | 0          | 0             | 11% → 11%                      | $0.052 |
| charity 5K (eval run 1) | 1080×1350 | 100             | 100       | 100   | 0          | 0             | not saved                      | $0.088 |
| the other 13 prompts    |           | not run         |           |       |            |               |                                |        |

The offline harness (template director + mock images + rules editor) does run end to end. On three prompts it went first 52 → best-of-4 65.7 → final 73.7 on average. That number only shows the plumbing works; the template director isn't meant to design well.

## Total spend

**$0.43** across all Claude and Replicate calls, out of the $15 cap. Itemized in `packages/generate/eval/results/spend-ledger.json`:

- the two live runs above
- the aborted eval attempts
- about 6 art-director debugging calls

## Scores well, looks wrong

Both cases come from the live charity run:

1. **CTA label not centered in its button.** "Register Now" sat at the top of the orange button, yet every candidate still scored 100. The cause: text renders from the top of its box, and the art director gave the label the button's full box. Nothing overflows or overlaps, so no rule can see it. **Fixed** in assembly (`centerButtonLabels`), with a test.
2. **Invented facts.** The subheading read "Charity 5K · Saturday, June 14 · City Park", but the prompt had no date and no venue. It scored 100 because the checker can't know what's true. **Mitigated** with an explicit "never invent dates, places, prices…" rule in the director prompt. That rule is untested live, and it needs an eval check (see suggestions).

Also worth knowing:

- In the offline demo, the rules-only editor fixed contrast by turning the CTA label grey on orange. It passes but looks worse. Claude does better here, but nothing _measures_ it.

## Which images to look at first

1. `out/live1/steps/contact-sheet.png`: the demo. Four candidates (runners photo vs. cutout runner on a blue/orange background), their scores and heatmaps, and the final design.
2. `out/live1/charity.assets/`: the FLUX images. `layout2-sub2.png` is a BiRefNet cutout of the runner, trimmed to her visible pixels.
3. `out/live1/steps/candidate-3.png`: the 58-scoring candidate. Light text over the bright sunrise, which is exactly what the contrast rule and the 4b regeneration op are for.
4. `out/gen-smoke/steps/contact-sheet.png`: the offline pipeline (mock images, template director).

(`out/` is gitignored; these files exist only on this machine.)

## What you need to do

1. **Run the eval** on a machine with free memory, one prompt at a time:
   `npm run eval:generate -- --concurrency 1`
   It should cost about $1.5–3 for the 14 prompts and take about 30–45 minutes at Replicate's throttled rate. Then paste the summary into the README table, and optionally run `--model claude-opus-5-5 --prompts <subset>`.
2. **Consider adding $5+ of Replicate credit.** That lifts the 6-per-minute throttle. Without it, each prompt waits about 10 s per image.
3. **Optional:** add `PEXELS_API_KEY` to `.env` to try stock backgrounds (`--provider pexels`).
4. **Licenses before any commercial use:** see NOTICE. BiRefNet's training data (DIS5K and others) has mixed image licenses. FLUX.1 schnell is Apache-2.0. MSI-Net's caveats are as before.
5. **`packages/generate` is marked `"private": true`** so it can't be published by accident. Remove that when you want to publish it.

## Suggestions

- **Add an eval check for invented facts.** Diff every number, date and capitalized place name in the copy against the prompt, and flag what isn't in it. It's cheap, deterministic, and fits Redline's style as a rule (`copy-grounded`).
- **Add a vision-model aesthetic tie-breaker for best-of-N.** Several candidates often tie at 100, and they currently tie-break on warnings and CTA share.
- **Use BiRefNet fp16** (`model_fp16.onnx`, 115 MB) to halve the memory. Check its quality first, then pin it the same way.
- **Run the CTA-label snap in the fix loop as well**, as a post-step, since the LLM can resize buttons.
- **Pass the art director's `calmAreas` to the contrast rule as a hint.** If text over an image fails contrast in a zone the brief promised would be calm, regeneration is the right fix. That's a strong signal for when to prefer `regenerateImage` over a scrim.
