# Phase 6 plan: the web app (static)

Branch `phase-6-web` (from `main` at `220b349`). **Status: approved 2026-10-12** (see [Approval](#approval-2026-10-12)).

**Revision 2 (2026-10-12):** no backend and no live AI calls. The site is fully static: replayed runs, a checker and editor that run in the browser, and export. It deploys for free. The code leaves a clean seam for a live backend later, which isn't built. The first version of this plan (Vercel + a job server) is in git history at `ed38103`.

The questions for you are in [Decisions I need from you](#decisions-i-need-from-you) at the end.

## Goal

A site anyone can click on that shows Redline working on real runs: the art director's plan, four candidates with scores and heatmaps, the winner, every fix iteration with its edits and reasons, the judge's findings, and the final design, all on a timeline you can scrub. Next to it, a real checker in the browser: open a design, drag things around, and watch the score and the issue outlines update instantly.

It has **no ongoing cost and nothing to abuse**: no server, no API keys, no accounts, no network calls except loading the site's own files.

## What exists and what it means for a static site

I checked these in the code and the stored data, not from memory:

| Existing piece                                                                                                                             | What the site does with it                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check()` in `@simonlunay/redline` is synchronous, pure and isomorphic (only `zod`)                                                        | Runs in the browser on every edit. `TextMeasurer` and `ImageSampler` are interfaces, so the browser supplies `canvas.measureText` (with the bundled Inter loaded through `FontFace`) and a sampler over decoded `ImageData`                                                                                           |
| The renderer (`packages/checker/src/node/render.ts`, 225 lines) draws with the Canvas 2D API through `@napi-rs/canvas`                     | Its drawing code moves into core as `paintDesign(ctx, design, images, measurer)`, typed against a small structural 2D-context interface. Node passes the Skia context, the browser passes a real `<canvas>`. **One renderer:** the editor, the checker's contrast sampling and the PNG export all see the same pixels |
| Generate records (`*.generation.json` + `*.candidates/` + `*.assets/`) from the phase 5b part 2 eval, in `out/eval-generate/` (gitignored) | **Complete histories:** the plan, every candidate's design and report, the ranking, every fix-loop step with its full design, report and edits (with element ids, values and reasons), every judgment with findings, and spend. These replay exactly                                                                  |
| Strict fix-eval records (`packages/agent/eval/results/2026-10-07T01-25-38-380Z_strict_*.json`, committed)                                  | **Partial histories:** the before design (the fixture), the best design, every step's score and status, rollback notes, and each edit's op and reason, but **not the intermediate designs or the edits' values**. See [Fix runs](#fix-runs-what-can-be-replayed-honestly)                                             |
| `runFixLoop` and `createSuggestedFixesEditor` are isomorphic                                                                               | The real fix loop can run in the browser with the **rules-only** editor (the checker's own suggested fixes, no AI, no network). Optional, see question 3                                                                                                                                                              |
| `cutout-quality` is pure TypeScript; `image-text` needs the OCR model                                                                      | The gallery build precomputes each image's `ImageAnalysis` (a few hundred bytes). Images never change while you edit, so **the image rules still run in the browser** on gallery and sample designs                                                                                                                   |
| The attention rules need MSI-Net (50 MB)                                                                                                   | **No model in the browser**, as you asked. Heatmaps are precomputed per recorded snapshot. The attention rules run in the browser **only on an unedited snapshot**, by feeding them its stored map. Once you edit, they're shown as paused, with a note, and the heatmap is labeled as the original's                 |
| `--render-steps` heatmap PNGs (20 MB per run)                                                                                              | Not used. The build stores the raw saliency map as an 8-bit grayscale PNG (the model's ~320×256 output, a few KB), and the browser colors and blends it. So the heatmap is a toggle with an opacity slider, not a baked-in image                                                                                      |

### Two different scores, labeled as such

The recorded runs were scored with every check that was on at the time: layout rules, attention, image rules, `copy-grounded` and the judge's findings. In the browser, an edited design can only get layout rules plus image rules. So the stage always shows:

- **Recorded score:** what the run actually measured, from the record. It never changes.
- **Live score:** what the browser's checker says now, with a small list of which rule sets are on ("layout · image · attention paused: edited").

A test checks that on every unedited gallery snapshot the live score equals the recorded rules score, so the two only differ when you've edited. Where today's checker scores an older record differently (the strict eval is from commit `db2a50f`, before `label-centered` and `blur` existed), the build reports it and the page says so, rather than quietly showing a different number.

### Fix runs: what can be replayed honestly

The strict eval didn't store intermediate designs. Of its 126 LLM runs, most have **exactly one accepted iteration** (for example Opus on `worst`: 5 → 100, `ad-sneaker-sale`: 11 → 100, `promo-food`: 11 → 100, `hard-busy-photo-tiny-cta`: 70 → 100). For those, before → best **is** the full history, so they replay exactly. The edit reasons are as recorded; which elements changed and how is computed by diffing before and best, and labeled that way.

My proposal, at no cost: the gallery's fix runs are **single-accepted-iteration runs only**, plus `banner-saas` as an honest "not solved" entry (Opus's best was 94 after 3–5 iterations). For that one, the timeline shows each step's score, status and rollback note, with canvases only for before and best, and says why. The alternative is a one-time local re-run of a few fixtures to capture full histories; see question 2.

## Product

All pages share one **stage** component: the canvas (shared renderer), numbered issue outlines like the CLI's `--annotate`, the heatmap layer, a score dial, and the issue list with each issue's measured value, threshold and suggested fix. Hovering an issue highlights its element, and clicking an element lists its issues.

1. **Landing (`/`).**
   - One sentence: _"Redline checks a design against real layout rules, then an AI fixes what it finds."_
   - A looping replay of a real run (before → after, the score counting up, the heatmap crossfading). It's the real player, not a video, so it's crisp and small.
   - Real numbers only, each linked to its README section. For example:
     - strict benchmark, 21 fixtures: mean score **62.1 → 98.8** (Sonnet 5.5) and **99.5** (Opus 5.5)
     - the blind pairwise judge preferred the fixed version in **40 of 42** pairs
     - generate: the judge would ship **9 of 14** designs
   - **Run it yourself:** copyable commands, each with a one-line note on what it needs.
     - `npx @simonlunay/redline check design.json` (free, no key)
     - `npm install @simonlunay/redline-agent`, then `redline fix design.json` (needs `ANTHROPIC_API_KEY`; about $0.03 per design in the eval)
     - `redline generate` from a clone, since it isn't on npm. The page says so plainly (needs Anthropic + Replicate keys, about $0.05–0.15 per design)
   - Links to GitHub and to both npm packages.
2. **Gallery (`/gallery`) and run pages (`/runs/[id]`).** Cards show the final design, first → final score, the prompt or fixture, and the judge's verdict.
   - **Runs the judge didn't approve are included and labeled**, e.g. "Judge: fix. The basket hovers mid-scene: no surface was planned under it (medium)", in the judge's own words from the record.
   - The run page is the **player**. In order:
     - the plan: concept, palette swatches, copy, the layouts as wireframes
     - the 4 candidates fanning out, each with score, heatmap toggle and CTA share
     - the winner lifted out, with the ranking reason
     - each fix iteration: edits with their reasons, rolled-back steps marked with what they broke, the score change
     - the judge's verdicts and findings (findings with a box are outlined on the canvas)
     - the final design
   - **Timeline scrubber:** one tick per event, drag or step with the arrow keys, play/pause, 1×/2×/4×. It plays at the run's real step durations, with long waits (waiting on images) collapsed.
   - "Open in editor" on any step.
3. **Check and edit (`/check`).**
   - Pick one of the 22 sample fixtures, or **upload a design JSON**: images embedded as data URLs only, 4 MB max per file, validated with `DesignSchema`. Errors are shown in place. Any remote or relative image `src` is refused with a clear message, so the page never fetches anything.
   - Issues are outlined immediately.
   - **Editor:** drag, resize (corner handles, Shift keeps the aspect ratio) and recolor (text color and shape fill), plus undo/redo and keyboard nudge. Every change re-runs `check()`, throttled to one check per animation frame. The layout rules take a few milliseconds, so it feels instant.
   - Heatmap: precomputed for the samples and gallery snapshots. **Uploads have none**, and the page shows the one-line CLI command that makes one (`redline check --attention --heatmap`).
   - Edits only change layout and style, through the same `applyFixes` ops the fix loop uses (`move`, `resize`, `setColor`), so every edited design stays schema-valid.
4. **Export.**
   - PNG at full resolution, rendered client-side with the shared renderer.
   - JSON: the design with images inlined as data URLs, so the file is self-contained, and `redline check` and `redline fix` work on it directly.
   - Both from the editor and from any step of a run.

Mobile: landing, gallery and the player work fully on a phone (canvas on top, timeline as a bottom sheet). The editor is desktop-first; on a phone it's view-only, with a note.

## Gallery data and size

**Build step:** `npm run gallery -w apps/web` (run locally, free, uses the attention and OCR models already on this machine). It:

- reads the selected records and the fixtures
- converts images to WebP
- computes a saliency map for every snapshot and an `ImageAnalysis` for every image
- strips anything private: absolute local paths, ledger tags and the eval's free-form fields
- writes one `run.json` per run plus its images to `apps/web/public/gallery/<id>/`

Its output is committed; the build itself never runs in CI.

**Selection (proposal):**

- **Generate:** all 14 prompts of phase 5b part 2 (13 from the main run, plus skincare-serum from its re-run), and the 3 tuned re-runs (coffee, pet, yoga) as "after shadow tuning".
- **Fix:** about 8 fixtures, as above.

The judge didn't ship 5 of the 14 part-2 designs; they stay in, labeled.

**Size (measured):** the raw assets of those 17 generate runs are about **21.7 MB** (JPEG backgrounds, PNG cutouts). WebP should bring that to roughly **8–10 MB**: cutouts with alpha shrink most. The fixture images are 0.3 MB. That's my estimate; the build measures the real total and **fails if it's over 15 MB**. If it is, I'll drop the 3 tuned re-runs first and tell you, not quietly lower image quality.

**Demo media:** a ~15–20 s replay of one gallery run, recorded from the real player with Playwright at a fixed frame rate, then encoded with ffmpeg (installed: 9.0.2):

- `docs/media/redline-demo.gif` for the top of the README. GitHub only plays GIFs inline from the repo; a committed MP4 doesn't autoplay in a README. Target **under 10 MB** (about 720 px wide, 12 fps, a shared palette).
- `docs/media/redline-demo.mp4` (H.264, ~1–3 MB) for anywhere a video works better.

The recording script is committed (`npm run demo-video -w apps/web`), so the media can be regenerated after any UI change. Playwright downloads its Chromium once, locally, for free.

## Tech

- **Next.js (App Router) + TypeScript in `apps/web`, with `output: 'export'`.** That turns the app into plain HTML, JS and assets.
  - Run pages are prerendered from the gallery index with `generateStaticParams`.
  - Uploads and editing are client-side.
  - Static export rules out route handlers, middleware and server image optimization. The site needs none of them, and images are already WebP at the right size.
  - Next.js is your preference and still a good fit. Vite would work as well; I don't see a reason to switch.
- **No network calls:** a strict Content-Security-Policy meta tag (`default-src 'self'`, `connect-src 'self'`) makes the browser refuse any request to another origin. It's a backstop, and a test checks it's present.
- **No keys:** a CI step greps the built output for key patterns (`sk-ant-`, `r8_`, `ANTHROPIC`, `REPLICATE`) and fails if any appear. The app doesn't depend on `@anthropic-ai/sdk`. If the agent package's index pulls it into the bundle (it exports `createAnthropicEditor`), I'll import the loop and the rules-only editor from their modules directly, and the bundle test will catch a regression.

### Hosting: GitHub Pages (recommended) or Vercel

Both are free for a static site like this.

|                    | **GitHub Pages (recommended)**                                                                                      | Vercel Hobby                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Account            | **None new.** It's the GitHub repo you already have                                                                 | A Vercel account linked to GitHub                                 |
| Deploy             | A GitHub Actions workflow builds and publishes on push to `main`                                                    | Automatic on push, with preview URLs per branch                   |
| URL                | `simonlunay.github.io/redline`, or a custom subdomain with one CNAME record                                         | `redline-….vercel.app`, or a custom subdomain                     |
| Limits that matter | 1 GB site, a soft 100 GB/month of bandwidth. Far above this site's needs                                            | Hobby is for personal, non-commercial use, which a portfolio fits |
| Caveat             | Served under `/redline/` unless you use a custom domain, so the app needs a `basePath`. I'll set it from an env var | –                                                                 |

**Recommendation: GitHub Pages.** It needs no new account, the site lives next to the code that a recruiter will click through to, and nothing about this site needs Vercel's features. Preview deployments are the one thing you'd miss.

I'll write the workflow (`.github/workflows/pages.yml`), but it only runs once you push and turn on Pages in the repo settings. I don't deploy anything.

### Seams for a live backend later (not built)

The code is shaped so a backend can be added without rewriting the UI:

- **`RunSource`**: the player consumes a stream of `RunEvent`s, which are the pipeline's own `GenerateEvent`s plus the fix loop's `IterationRecord`s, in their serialized form.
  - Today `StaticRunSource` turns a stored `run.json` into that stream.
  - Later a `LiveRunSource` would read the same events over Server-Sent Events from a job server. The first version of this plan (`ed38103`) describes that server, with rate limits and spend caps.
- **`AttentionProvider`**: `PrecomputedAttention` today; a `RemoteAttention` (or an onnxruntime-web model) later, behind the core's existing `SaliencyModel` interface.
- **`capabilities`**: a build-time config with `live: false`. Live-only controls (Generate, AI "Fix it") are already designed into the layout, but render as "Run it yourself" panels with the CLI commands. Turning `live` on later would add buttons, not restructure pages.

No backend code, no fetches, no env vars for keys.

## Visual design

- **Concept: a proofing table.** The page is quiet and neutral, like a light table, so the design under review is the only colorful thing on screen. Redline's red has exactly one job, **marking problems**, as a proofreader's pen does: outlines, numbered badges, the score while it's failing. Everything else is graphite and paper. The stage defaults to a dark surround, so designs stand out; the rest follows the system theme.
- **Type:** Inter for the UI (the designs use it too) and a monospaced face for measurements (`1.24:1 · threshold 3:1`), echoing the CLI.
- **Motion that explains:** candidates fan out from the plan, the winner lifts, outlines draw on and fade when an issue is fixed, the score counts between values, and the heatmap crossfades between steps. Every transition is under 300 ms, and all motion is off under `prefers-reduced-motion`.
- I'll use the frontend-design skill while building it, and check every page in a real browser at phone and desktop widths before calling it done.

## Testing

Nothing calls a paid API, so nothing can spend money.

- **Shared renderer:** the existing Node render tests pass unchanged after the refactor (same pixels).
- **Browser checker parity:** a Playwright test loads all 22 fixtures in Chromium, checks them with the browser measurer and sampler, and compares with `checkFile` in Node. Skia and Chromium measure Inter slightly differently, so text widths get a small tolerance; I'll report the actual differences, and whether any changes a wrap or a result.
- **Gallery build:**
  - every unedited snapshot's live score equals its recorded rules score (or the difference is listed and shown)
  - every referenced image exists
  - no absolute paths or private fields
  - the total stays under 15 MB
- **Player:** seeking to any tick gives the same state as stepping to it; event order matches the record.
- **Upload validation:** the size limit, data-URL-only images, schema errors with paths, non-JSON files.
- **Editor:** drag, resize and recolor produce schema-valid designs through `applyFixes`; undo/redo; attention pauses after an edit and resumes on undo back to the snapshot.
- **Export:** the PNG has the canvas's size; the JSON round-trips through `parseDesign` and `checkFile` to the same score.
- **Static guarantees:** the build output contains no key patterns; the CSP is present; no source file in `apps/web` calls `fetch` with a non-relative URL.
- **E2E smoke** with Playwright against the static export: landing, a gallery replay, the editor, export. Kept to a few tests so it stays fast.
- **Unchanged:** lint, typecheck, build and all 345 existing tests pass at every commit.

## Steps (each a small commit)

1. **Shared renderer:** move the drawing code to core `paintDesign`; Node rendering unchanged.
2. **Browser environment** for the checker (`createBrowserMeasurer`, `createBrowserSampler`) and the parity test.
3. **`apps/web` scaffold:** static export, design tokens, layout, CSP, workspace wiring into lint, typecheck, build and test.
4. **Stage component:** canvas, issue overlays, heatmap layer, score, issue list.
5. **Gallery build script.** I'll report the measured size to you **before** committing any images.
6. **`RunSource`, player and timeline;** run and gallery pages.
7. **Check and edit page:** samples, upload, editor, live checking.
8. **Export** (PNG, JSON).
9. **Landing page** with the looping replay, the real numbers and the run-it-yourself commands.
10. **Polish pass** in a real browser at phone and desktop widths; Lighthouse on landing and gallery.
11. **Demo GIF and MP4**, and the recording script.
12. **Pages workflow and README:** running the site locally (`npm run dev -w apps/web`), rebuilding the gallery, and how it deploys.
13. **Phase 6 report.**

Nothing is merged or pushed; you do that.

## Risks

- **Browser vs Skia text metrics.** In an edge case a line could wrap at a different word, changing a `text-overflow` or `label-centered` result between the browser and the CLI. The parity test measures it. If it matters, the browser can use Inter's metrics through the same path as Node rather than `measureText`.
- **Older records vs today's checker.** The strict eval predates two checker changes, so a few recorded scores may not reproduce. They're shown as recorded, with a note.
- **Repo size.** About 8–10 MB of gallery images plus up to 10 MB of GIF. It's a one-time addition; regenerating the GIF later adds another copy to the git history, so I'll keep regenerations rare.

## Decisions I need from you

1. **Hosting:** GitHub Pages at `simonlunay.github.io/redline`, or on a custom subdomain such as `redline.simonlunay.com` (you'd add one CNAME record)?
2. **Fix runs:** OK to show only runs that replay exactly (one accepted iteration), plus `banner-saas` as an "unsolved" entry without intermediate canvases? Or do you want a **one-time local re-run** of ~6 fixtures with `redline fix` to capture full multi-step histories? That's about $0.30, capped at $0.50 by the ledger, and needs your OK since it spends money.
3. **Rules-only "Fix it" in the browser:** run the real fix loop with the checker's own suggestions (no AI, free, instant), labeled clearly as rules-only, with the eval's numbers for what the AI adds (rules loop 81.8 vs Sonnet 98.8 in the strict mean)? I think it makes the editor much more fun, but it's scope you didn't ask for.
4. **Gallery selection:** all 14 phase 5b part 2 prompts plus the 3 tuned re-runs (est. 8–10 MB), and about 8 fix runs?
5. **Demo:** which run should the README GIF show? I'd suggest a generate run where the loop and the judge visibly change something, e.g. yoga-retreat after shadow tuning, where the judge goes from fix to ship.

## Approval (2026-10-12)

Approved with these answers:

1. **Hosting:** GitHub Pages at `simonlunay.github.io/redline` for now. The README documents the switch to `redline.simonlunay.com` (CNAME record and config change); it isn't set up.
2. **Fix runs:** a one-time local re-run of about 6 fixtures with `redline fix`, capped at $0.50 by the ledger, to capture full histories. Those are the gallery's fix replays.
3. **Rules-only "Fix it":** yes, clearly labeled as no AI. Where a gallery run exists for the same design, the rules-only result is shown next to the AI result.
4. **Gallery:** the proposed list, ordered with the strongest runs first and the judge-rejected or unsolved ones later, labeled honestly.
5. **Demo GIF:** yoga-retreat.
