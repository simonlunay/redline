# Phase 6 report: the web app

Branch `phase-6-web` (from `main` at `220b349`). Not pushed, not merged, not deployed. Date: 2026-10-12. Plan: [phase-6-plan.md](phase-6-plan.md) (revision 2, the static site, approved with your five answers).

## TL;DR

- **What got built:** `apps/web`, a Next.js (App Router) site exported as static files. It has no server, no API keys and makes no AI calls.
  - **Recorded runs** (`/gallery`, `/runs/<id>`): 22 runs, replayed on a timeline you can scrub. Generate runs show the plan, 4 candidates, the winner, the judge's reviews, every fix step with its edits and reasons, and the final design. Fix runs show every step next to the rules-only loop.
  - **Check and edit** (`/check`): open any of the 22 samples, any step of a run, or your own JSON. You can drag, resize and recolor elements, and the checker re-runs in the browser on every change. **Fix it with the rules (no AI)** runs the real fix loop in the browser, next to the recorded AI result.
  - **Export:** a full-size PNG, or self-contained JSON with images embedded.
  - **Landing page:** real eval numbers only, each linked to its README section, plus "run it yourself" commands.
  - **Demo:** `docs/media/redline-demo.gif` (2.9 MB) at the top of the README, and an MP4 (0.5 MB).
- **The browser's checker gives exactly the CLI's results.**
  - A unit test re-checks every stored snapshot of every run and sample with the browser's rule set and gets the stored report exactly, issue for issue.
  - An end-to-end test repeats this in real Chromium for all 22 samples. There, the browser's own canvas measures Inter, and the score and issue count match on every one.
- **Tests:** 387 unit tests pass (345 before, plus 42 for the web app), and 34 end-to-end tests pass in Chromium (desktop and phone). Lint, typecheck and build are clean.
- **Spend: $0.262 of the $0.50 you approved,** for the one-time fix re-run. It's all in `apps/web/gallery-src/spend-ledger-phase6.json` (11 Sonnet calls).
  - **Only 3 of the 6 planned fixtures completed** (worst, story-concert, ad-sneaker-sale). After $0.26, the ledger's guard refused further calls. It prices each call at its worst case ($0.245), so $0.255 was the most that could be spent under a $0.50 cap.
  - For two of the other three, the gallery uses exact replays from the strict eval instead. See [What you need to do](#what-you-need-to-do).
- **Size:** 5.67 MB of gallery images plus 0.93 MB of JSON (budget 15 MB), and 3.5 MB of demo media.

## What got built

| Piece                       | Where                                                                                 | Notes                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared renderer             | `packages/checker/src/core/paint.ts`                                                  | The CLI's drawing code, moved to core and typed against a small 2D-context interface. Node passes Skia; the browser passes a `<canvas>`. Node's output is unchanged (its render tests pass untouched)                            |
| Shared sampler and measurer | `packages/checker/src/core/environment.ts`                                            | `createRasterSampler`, `createContextMeasurer`. Node wraps them as before                                                                                                                                                        |
| Gallery build               | `apps/web/scripts/build-gallery.ts`, `gallery-sources.ts`                             | Free, local. Converts images, re-checks every snapshot twice (below), stores attention results, image analyses and heatmaps, and enforces the size budget                                                                        |
| Fix-run recording           | `apps/web/scripts/record-fix-runs.ts`                                                 | Sonnet 5.5, strict settings, every call through the $0.50 file ledger                                                                                                                                                            |
| Browser environment         | `apps/web/src/lib/env/`, `lib/rules.ts`                                               | Design fonts as WOFF2 under their own family name; images decoded without color conversion; the rule set in the CLI's order                                                                                                      |
| Player and timeline         | `src/lib/run/timeline.ts`, `src/components/Player.tsx`, `Timeline.tsx`, `Stage.tsx`   | The timeline is a pure function of the record, so seeking and stepping always agree (tested). Red boxes are issues (solid: error, dashed: warning), blue corner marks are the agent's edits, dashed `J` boxes are judge findings |
| Check workspace             | `src/components/CheckWorkspace.tsx`, `lib/edit.ts`, `lib/history.ts`, `lib/upload.ts` | Edits go through `applyFixes`, so an edited design is always schema-valid. A drag is one undo step                                                                                                                               |
| Live-backend seam           | `src/lib/run/source.ts`                                                               | `RunSource` yields the record as it grows. Only the static source exists                                                                                                                                                         |
| Static hosting              | `scripts/flatten-segments.mjs`, `serve-static.mjs`, `.github/workflows/pages.yml`     | See [Decisions](#decisions-worth-explaining)                                                                                                                                                                                     |
| Safety checks               | `scripts/check-no-secrets.mjs`, CSP meta tag                                          | The build fails on key patterns, paid API hosts or the Anthropic SDK in `out/` (tested with a planted key). The CSP blocks requests to other origins                                                                             |

## How the browser gets the CLI's exact results

The attention model (50 MB) and the text detector don't ship to the browser, as you asked. Everything else runs client-side.

- **Attention.** The build ran MSI-Net on every recorded design. It stores the two attention rules' outputs (issues, element shares and details), not the raw map. In the browser, "frozen" rules with the same id, weight and severity return those outputs, so the scoring code computes exactly the build's score.
  - Once you edit, the attention rules pause and the page says so ("Layout rules only now…").
  - Undoing back to the original restores them (tested).
  - The heatmap is a separate 8-bit image for display only, downsampled to at most 160 px.
- **Image rules.** Each image's text regions and cutout verdict are stored with the run. Editing never changes an image, so `image-text` and `cutout-quality` keep running in the browser.
- **Two checks per snapshot in the build:**
  1. On the **original images** with every rule the run used. This is compared with the score the run recorded, and it's where the attention results come from.
  2. On the **images as served**, with exactly the browser's rule set. This is the report the site shows.

  I added the split after the first build. WebP compression shifted predicted attention enough to flip a CTA sitting at exactly 5% to a warning, which changed yoga's candidate 1 from 94 to 88.

- **Fixture images stay lossless PNG** (0.3 MB in total). With lossy WebP, contrast sampled near a threshold changed 5 of `worst`'s 8 snapshots.

**Today's checker against what the runs recorded:**

- Every candidate of all 17 generate runs, and every step of the 3 recorded fix runs, re-checks to its recorded score, with two exceptions: coffee-latte's candidates 2 and 4, recorded at 86, re-check at 91.
- **Why:** the pipeline measured those cutouts against the backdrop color of the uncut FLUX image, which the run didn't keep. So a `leftover-backdrop` warning can't be reproduced. The run page says so in "Where this run comes from".
- Loop steps in generate runs aren't compared, because their recorded scores include the judge's findings. The stage shows the rules score and the judge's findings separately, with a note.

## The gallery

**22 runs**, in the order you asked for (strongest first, generate and fix runs alternating within a tier):

1. **11 generate runs the judge would ship** (9 of the 14 part-2 designs, plus pet and yoga after shadow tuning), and 4 fix runs that reach 100. `charity-5k` comes first.
2. Then the rest, with what still looks wrong in the judge's or the loop's own words. In order: yoga-retreat, fix-ad-sneaker-sale (stopped at 91, no improvement), coffee-latte-tuned, pet-adoption, farmers-market, skincare-serum, coffee-latte. All are "the judge still asked for fixes", except ad-sneaker-sale.

- **Generate:** the 13 prompts of the phase 5b part 2 run, skincare-serum from its re-run, and coffee, pet and yoga again from the tuned re-run, labeled "after shadow tuning". The judge verdicts match the 5b report: 9 of 14 part-2 designs shipped.
- **Fix runs, recorded for the gallery** (Sonnet 5.5, target 100, attention on, max 5 iterations):

  | Run             | Result                                    |
  | --------------- | ----------------------------------------- |
  | worst           | 5 → 100 in 2 iterations                   |
  | story-concert   | 16 → 100 in 5 iterations, with a rollback |
  | ad-sneaker-sale | 9 → 91, then stopped (no improvement)     |

- **Fix runs from the strict eval:** `hard-story-hero` (Opus, run 2: 79 → 100) and `hard-busy-photo-tiny-cta` (Opus, run 1: 70 → 100). Each has exactly one accepted step, so before → after is the whole history. The eval kept each edit's op and reason but not its target or values, so those pages show the recorded reasons and the changes computed from the two designs, and say so.
- **Not in the gallery:** `banner-saas`. Its re-run was cut off by the cap, and none of its strict-eval runs has a single accepted step.
- **Rules only vs AI:** every fix run also has a rules-only loop, computed by the build with the same checker and target. The final panel shows both side by side. On `/check`, a sample with a gallery run shows the recorded rules-only and AI results next to the live rules-only button.

## Checks

| Check                                | Result                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests (`npm test`)              | 387 pass: 345 existing, plus 42 web (gallery data, report parity for every snapshot, timeline, editor ops, history, diff, upload)                                                                                                                                                                                                                                       |
| End-to-end (`npm run e2e`, Chromium) | 34 pass: landing (real numbers, the demo advances, CSP present), gallery order and labels, run replay (keyboard seek, panels, heatmap), every run page loads, **browser parity on all 22 samples**, editing, undo, rules-only fix, upload accept/refuse, PNG/JSON export, no request leaves the site, no console errors, and 5 pages on a phone with no sideways scroll |
| Lint, typecheck, build               | Clean. `npm run build` now also builds the site                                                                                                                                                                                                                                                                                                                         |
| Bundle                               | No Anthropic SDK, no API hosts, no key patterns (`check-no-secrets`). The agent package's index exports the Anthropic editor, but tree-shaking drops it                                                                                                                                                                                                                 |
| Base path                            | Built with `NEXT_PUBLIC_BASE_PATH=/redline` and served under `/redline/`: no errors on the landing, run and check pages                                                                                                                                                                                                                                                 |

**Lighthouse** (mobile, simulated slow 4G, on the local static build):

| Page            | Performance | Accessibility | Best practices | SEO |
| --------------- | ----------- | ------------- | -------------- | --- |
| Landing         | 77          | 100           | 96             | 100 |
| Gallery         | 73          | 100           | 100            | 100 |
| Run (fix-worst) | 73          | 96            | 96             | 100 |
| Check           | 54          | 95            | 96             | 100 |

- **Before the polish pass, performance was 55, 80, 47 and 48.** The landing and run pages improved a lot. The gallery measured 80 before and 73 after: either run-to-run variance (Lighthouse's simulated scores moved by several points between identical runs here) or the font change, which I didn't separate. The changes:
  - the design fonts went from TTF to WOFF2 (1.6 MB → 571 KB; same tables, and parity still holds)
  - the UI font now loads through `next/font`
  - design fonts and images start only after the page has painted
  - muted text was 3.97:1 and is now ≥ 4.5:1
  - issue rows no longer misuse `aria-selected`
  - there's a favicon
- **What's left:**
  - The run and check pages decode every image to pixels on the main thread, which is the blocking time.
  - The check page's script also runs a full check on load.
  - Best practices loses a few points on a generic CSP notice that comes with no details.

**One unreproduced failure:** one `npm run e2e` run right after the full unit suite reported a failure, and the output didn't show which test. Six later runs passed, including 102 of 102 with `--repeat-each=3` on 8 workers. I'm reporting it rather than claiming it can't happen. CI allows one retry; local runs don't.

## Decisions worth explaining

- **GitHub Pages, via an Actions workflow.** It needs no new account. It runs on every push to `main` once you turn Pages on, and it lints, typechecks, runs both test suites and checks for secrets before deploying. `BASE_PATH` is one line in the workflow, and the README documents the switch to `redline.simonlunay.com` (CNAME record, Pages setting, `BASE_PATH: ''`).
- **Next 16's static export needed one workaround.** It writes route-segment prefetch files as nested folders (`gallery/__next.gallery/__PAGE__.txt`), but the client requests a dotted name (`gallery/__next.gallery.__PAGE__.txt`). A plain static host can't rewrite URLs, so every prefetch 404'd. `postbuild` writes the dotted copies (25 files).
- **The site imports the packages' built `dist`,** the same artifacts npm users get, so `npm run build:packages` comes before the site in every path. Tests use the source, as before.
- **Red means a problem, blue means the agent's fix.** These are the copy editor's two pencils. I validated both colors with the dataviz palette checker (they pass on paper). Every mark also has a number or letter and a solid, dashed or corner style, so color is never the only cue. The heatmap is a single-hue highlighter wash (yellow, with the rest veiled), with no red.
- **Uploads get layout rules only.** Their images have no stored analysis and there's no model, so the page shows the CLI command for attention instead.

## Differences from the plan

- **Fix runs:** 3 recorded (not 6), plus 2 exact replays from the strict eval; `banner-saas` isn't in the gallery. The cause is in the TL;DR.
- **Playback pacing:** the plan said the player would use each run's real step durations. Generate records don't keep per-step durations (only the total), so every frame kind has a fixed hold time, with 2× and 4× options. The recorded fix runs do keep durations, but I used the same pacing everywhere for consistency.
- **The editor works on phones,** with touch drag. The plan said view-only. The stage takes over touch scrolling only while you drag on it.
- **Visual checks used Playwright's Chromium,** because the Chrome extension wasn't connected. All screenshots and the demo come from it.
- **Not tested in Firefox or Safari.** Their canvas text measurement could differ slightly from Chromium and Skia, which would show up as a small score difference in an edge case. The Chromium parity test is the only browser evidence.

## Spend

**$0.262 of $0.50:** 11 Claude Sonnet 5.5 calls in `apps/web/gallery-src/spend-ledger-phase6.json`.

| Fixture         | Calls | Cost   |
| --------------- | ----- | ------ |
| worst           | 2     | $0.054 |
| ad-sneaker-sale | 3     | $0.068 |
| story-concert   | 5     | $0.121 |
| hard-story-hero | 1     | $0.019 |

`hard-story-hero`'s run was cut off after that one call, so it's kept as `hard-story-hero.incomplete.json` and not used. Nothing else cost money. The gallery build, the demo recording, Lighthouse and all tests are free and local.

## What you need to do

1. **Decide on the last 3 fix runs** (hard-story-hero, hard-busy-photo-tiny-cta, banner-saas). Recording them would cost about $0.20–0.30 more at the average of $0.024 per call. But the guard needs $0.245 of headroom per call, so the cap would have to be about **$0.80** for them to run. Or keep the gallery as it is: the first two are already exact replays from the strict eval.
2. **Review the branch, then push and merge** when you're happy. Nothing is pushed.
3. **Turn on Pages:** Settings → Pages → Source: GitHub Actions. The first push to `main` then deploys to `simonlunay.github.io/redline`.
4. **Later, for the custom domain:** follow "Deploying" in the README.

## Suggestions

- **A guard for small budgets:** for a short recording script, pricing each call at its worst case leaves half the cap unusable. A per-call estimate from the previous call's real usage (with a margin) would have finished all six fixtures under $0.50.
- **Decode images off the main thread** (a worker with `OffscreenCanvas`) to bring the run and check pages' blocking time down.
- **Keep per-step durations in `serializeResult`** so generate replays can play at real speed.
- **Add Firefox and WebKit to the end-to-end parity test.** It's a two-line config change and about 250 MB of browsers.
