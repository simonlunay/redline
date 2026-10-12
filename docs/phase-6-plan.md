# Phase 6 plan: the web app

Branch `phase-6-web` (from `main` at `220b349`). **Status: waiting for approval.** No code is written until you approve; nothing gets deployed, no accounts are created and no money is spent without asking.

The questions for you are collected in [Decisions I need from you](#decisions-i-need-from-you) at the end.

## Goal

A live site where anyone can watch Redline work: type a prompt or open a design, and see the candidates appear, the issues get outlined, the score climb and the heatmap shift as the agent fixes it. Most visitors will only see the **gallery of replayed runs**, so that path has to be free, fast and independent of the paid backend. Live generation is the expensive extra, and it turns itself off when the budget runs out.

## What already exists and what it means for the design

From the code (not assumptions):

| Existing piece                                                                                                                           | What the web app does with it                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check()` in `@simonlunay/redline` is synchronous, pure, isomorphic (only `zod`)                                                         | Runs **in the browser** on every edit. `TextMeasurer` and `ImageSampler` are interfaces, so the browser supplies `canvas.measureText` (with Inter loaded through `FontFace`) and a sampler over decoded `ImageData`                                                                                         |
| The renderer (`src/node/render.ts`, 225 lines) uses the Canvas 2D API through `@napi-rs/canvas`                                          | I'll move the drawing code into core as `paintDesign(ctx, design, images, measurer)` typed against a small structural 2D-context interface. Node passes the Skia context, the browser passes a real `<canvas>`. **One renderer, so what you see in the editor is what the checker and the PNG export see.** |
| `generateDesign({ onEvent })` emits `plan`, `image`, `candidate`, `winner`, `iteration`, `judge`, `warning`                              | These events become the SSE stream as they are. No pipeline changes are needed for live progress                                                                                                                                                                                                            |
| `runFixLoop({ onIteration })` and the replayable `IterationRecord` history (full design snapshot + report + edits with reasons per step) | Streams "Fix it" live, and drives the timeline scrubber. The README already promises this                                                                                                                                                                                                                   |
| `.generation.json` (plan, every candidate, ranking, loop history, judgments, spend) plus the assets folder                               | The gallery's data format. A finished live run produces the same file, so live runs and gallery runs replay through **the same player**                                                                                                                                                                     |
| `SpendLedger` (`guard` before, `record` after; synchronous) and `withRunBudget`                                                          | Every paid call in the app goes through it. The global daily cap is a ledger; each run is wrapped in `withRunBudget`                                                                                                                                                                                        |
| `createAutoRemover({ forceHosted })`, `--cutout hosted`                                                                                  | Production uses **hosted BiRefNet only**. The local 224 MB / 6 GB model is never downloaded on the server                                                                                                                                                                                                   |
| MSI-Net saliency (50 MB fp16 ONNX, ~0.3 GB RAM, 0.2–0.3 s per design on CPU) and PP-OCRv5 (13 MB)                                        | Run **server-side** on the job server. See [Where the saliency model runs](#where-the-saliency-model-runs)                                                                                                                                                                                                  |
| FLUX schnell provider never sets `disable_safety_checker`                                                                                | Replicate's safety checker stays on (it's the default). I'll add a test that pins this, so nobody can turn it off by accident                                                                                                                                                                               |

Two gaps I found that the plan has to close:

1. **`createFixSession` takes a file path, and `generateDesign` writes to an output directory.** On the server I'll add an in-memory `createFixSessionFromDesign(design, { images })` next to the file version (a thin refactor; the file version calls it), and give each generate job its own temp directory.
2. **Saliency maps aren't stored in the history**, only the PNG overlays in `--render-steps` (20 MB per run, too big for a page). The gallery build will recompute the maps locally (free) and store them as small 8-bit grayscale PNGs (the model's output is ~320×256, a few KB each). The browser colors and blends them, so the heatmap is a toggle with an opacity slider instead of a baked-in image.

## Architecture

```
                  Browser (Next.js app, React)
   ┌──────────────────────────────────────────────────────────┐
   │ canvas renderer (shared paintDesign) · issue overlays     │
   │ check() live on every edit · heatmap from saliency grid   │
   │ replay player (timeline over a .generation.json record)   │
   └──────────┬──────────────────────────────┬────────────────┘
              │ static, CDN                   │ SSE + JSON (CORS, origin-locked)
              ▼                               ▼
   Vercel: apps/web                   Job server: apps/worker (Node, one process)
   landing, gallery, editor           POST /runs/generate · POST /runs/fix
   gallery data in /public            GET  /runs/:id/events (SSE, resumable)
   (no API keys at all)               POST /attention · GET /status
                                      ── rate limits, daily cap, moderation
                                      ── generateDesign / runFixLoop, hosted cutouts
                                      ── MSI-Net + PP-OCR on CPU
                                      ── SQLite on a volume: ledger, quotas, run records
```

### Why Next.js, and why a separate job server

- **Next.js (App Router) + TypeScript in `apps/web`**, as you prefer. It fits well: the landing page and gallery are static and can be prerendered, the editor is a client component, and you already know it. I don't have a strong reason to pick something else.
- **The long jobs don't run in Next.js route handlers.** A generate run takes 60–120 s and can take longer (the phase 5 evals had runs with 8 fix iterations and up to 3 judge calls). Serverless functions are the wrong place for it:
  - Vercel Hobby functions stop at **300 s**, and the job can't outlive the request.
  - `onnxruntime-node` plus the models is too big and too slow to cold-start in a function.
  - The spend ledger is synchronous, which is simplest when one process owns it.
- **So the job server is a plain long-running Node process** (`apps/worker`, Hono or Fastify, I'd use Hono: small, typed, good SSE helper). It owns all keys, all paid calls, the models and the ledger.
- **Jobs are decoupled from the HTTP connection.** `POST /runs/generate` validates, checks quotas, reserves budget and returns a run id right away. The job runs in the process and appends every event to the run's record. `GET /runs/:id/events` streams them over SSE, and on reconnect (`Last-Event-ID`) it replays what was missed. So a dropped connection, a phone going to sleep or a proxy timeout never kills or repeats a paid run, and a finished run can be reopened by URL.
- **Concurrency:** at most 2 jobs run at once (CPU and memory), the rest queue with a visible position. A single machine is plenty at portfolio traffic.

### Where the saliency model runs

**Server-side**, on the job server, with `POST /attention` (design in, 8-bit map out), debounced by the editor so it fires ~400 ms after you stop dragging, and cached by render hash (already built in). It's free per call (CPU only) but still rate-limited, since it costs CPU.

Why not `onnxruntime-web` now: it would mean shipping **50 MB to every visitor** who opens the heatmap, which is too much for phones, and ORT-web's WASM backend has weaker fp16 support (I'd need an fp32 or int8 export and a new parity check against the TensorFlow original). It's a good follow-up: the core already has a `SaliencyModel` interface, so a browser model drops in without touching the rules. **The gallery needs neither**, because its maps are precomputed.

When the job server is down or asleep, the editor still works fully: **every layout rule runs in the browser**, and the attention rules show as "skipped (attention server unavailable)", which `check()` already reports via `report.skipped`. The image rules (OCR) stay server-only and only matter for generated images, which come with their results.

### Images in uploaded designs

An uploaded design JSON can only reference images that are **data URLs** (≤ 4 MB total) or the bundled sample images. Remote `http(s)` URLs are refused, so the server never fetches arbitrary URLs (no SSRF, no hotlinking). Missing images render as the existing placeholder, and the checker says contrast couldn't be verified, as it does today.

## Product

All four tools share one **stage** component: the canvas (shared renderer), issue outlines numbered like the CLI's `--annotate`, the heatmap layer, a score dial and the issue list. Hovering an issue highlights its element, and clicking an element shows its issues.

1. **Landing (`/`).** One sentence: _"Redline checks a design against real layout rules, then an AI fixes what it finds."_ Then a looping replay of a real run: before/after, the score counting up, the heatmap crossfading. It uses the gallery player, not a video, so it's crisp and small. Links to GitHub and npm. Numbers are **only from the README's evals**, each linked to its section, e.g. "strict benchmark: mean score 62.1 → 98.8 (Sonnet 5.5) on 21 fixtures", "the blind judge preferred the fixed version in 40 of 42 pairs". No testimonials, no user counts.
2. **Gallery (`/gallery`, `/runs/[id]`).** Precomputed runs that replay for free. Each card shows the final design, the first → final score and the prompt. The run page is the full player (below). It works with the job server off.
3. **Generate (`/generate`).** A prompt box, three size presets (square post 1080×1080, story 1080×1920, wide banner 1200×628), and "Generate". Then, live and in order:
   - the art director's plan: concept, palette swatches, copy, the layouts as wireframes
   - the 4 candidates fanning out as they finish, each with score, heatmap toggle and CTA attention share
   - the winner lifted out, with the ranking reason ("highest score, fewest errors")
   - each fix-loop iteration: the edits with their reasons, rejected or rolled-back steps marked, the score change
   - the judge's verdict and findings, outlined on the canvas
   - the final design, with export

   Afterwards the whole run stays on a **timeline scrubber** (one tick per event, keyboard-steppable), and gets a shareable URL. Generated runs aren't added to the public gallery automatically (see the questions).

4. **Check and fix (`/check`).** Pick a sample (the 22 fixtures, e.g. `worst`, `hard-story-hero`) or upload a design JSON. Issues are outlined immediately (browser check), the heatmap is a toggle, and **"Fix it"** streams the fix loop from the job server, step by step, into the same timeline.
5. **Editor.** On `/check` and on any finished run: drag, resize (corner handles, Shift keeps the ratio) and recolor elements (a color picker on text color and shape fill). The browser re-runs `check()` on every change, throttled to one check per animation frame; the layout rules take a few milliseconds. Undo/redo. You can hand an edited design back to "Fix it".
6. **Export.** PNG at full resolution (rendered client-side with the shared renderer) and JSON (the design, with images inlined as data URLs so the file is self-contained and `redline check` works on it).

### What the gallery contains

- **Generate runs** from the phase 5b part 2 eval, which are on disk in `out/eval-generate/` (gitignored). Since they're already paid for, they cost nothing. I'd pick about 8, chosen for variety in size and story, **not only the clean ones**: e.g. a run where the judge said "fix" and the loop recovered, and one where it still didn't ship, labeled honestly.
- **Fix runs** for 6–8 fixtures. These exist in the strict eval results (`packages/agent/eval/results/`), which store the per-step history and best design.
- **Build step:** `npm run gallery -w apps/web` reads those records, converts images to WebP (2 MB → ~300 KB per run), computes the saliency maps, strips anything private (local paths, the ledger's free-form tags), and writes `apps/web/public/gallery/<id>/`. A test re-checks every gallery snapshot to its recorded score, as the agent test already does for histories. I estimate **~10–15 MB committed** for ~15 runs; see the questions.
- **Replay pacing:** the records hold real durations for the loop and the run, so the player plays at real speed with a 2×/4× toggle and skips idle waits ("waiting for images… 14 s" collapses to a beat).

## Cost and abuse controls

All keys stay on the job server: `ANTHROPIC_API_KEY` and `REPLICATE_API_TOKEN` are never in the Next.js app, so they can't end up in a client bundle. A CI check greps the built `.next` output for key prefixes (`sk-ant-`, `r8_`) and fails if any appear.

**Layered, cheapest check first.** A request is refused at the first layer that says no, so a refused request costs nothing:

| Layer               | What it does                                                                                                                                                                                                                                                                                                                                                                                              | Cost     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Kill switch         | `LIVE_ENABLED=false` turns live features off without a deploy. The UI shows "Live generation is paused" and points to the gallery                                                                                                                                                                                                                                                                         | free     |
| Input validation    | Prompt 3–300 characters, size must be a preset, design JSON ≤ 4 MB and schema-valid, fixed candidates (4), iterations (4), regenerations (2), judge rounds (2). Visitors can't raise any of them                                                                                                                                                                                                          | free     |
| Bot friction        | Cloudflare Turnstile (free, invisible for most people) on Generate and Fix-it                                                                                                                                                                                                                                                                                                                             | free     |
| Per-visitor quota   | Keyed by a hash of IP + a signed cookie, counted in SQLite, so clearing cookies alone doesn't reset it. Proposed: **3 generates and 5 fixes per visitor per day**, plus a per-IP burst limit of 1 run in flight. `/attention` gets 60 per minute                                                                                                                                                          | free     |
| Local prompt screen | A small blocklist for clearly inappropriate requests (sexual content, minors, violence, hate). It errs on the side of passing; the next layer does the real work                                                                                                                                                                                                                                          | free     |
| Moderation call     | One Haiku 4.5 call classifies the prompt (`allow` / `refuse` + a short reason, structured output) **before any image or Sonnet call**. About $0.0005, recorded in the ledger like every paid call                                                                                                                                                                                                         | ~$0.0005 |
| Global daily cap    | Before a run starts it **reserves** its worst case (the run's own budget, below) against today's cap. If the reservation doesn't fit, the run is refused. When it finishes, the reservation is released and the real spend stays. Concurrent runs can't overshoot, since reservations count as spent. At the cap, `/status` reports `live: false`, and the UI switches to gallery mode until midnight UTC | free     |
| Per-run budget      | `withRunBudget(ledger, 0.40)`: the existing guard refuses any paid call that could cross it. The phase 5b runs cost $0.045–0.15 each, so $0.40 is a hard ceiling that a normal run never reaches                                                                                                                                                                                                          | –        |
| Monthly cap         | A second, monthly ceiling on the same ledger, so a month of maxed-out days can't surprise you                                                                                                                                                                                                                                                                                                             | free     |
| FLUX safety checker | On (Replicate's default). A test asserts the request body never contains `disable_safety_checker: true`. A filtered image (Replicate returns an error, or a black frame) fails that slot cleanly, and the run says why                                                                                                                                                                                    | –        |

- **Every paid call goes through the existing spend ledger**, including the moderation call. The server ledger is a SQLite-backed implementation of the same `SpendLedger` interface; entries are tagged with the run id, never the IP.
- **Spend visibility:** `/status` (public) returns only `live`, queue length and whether today's cap is reached. An admin route behind a bearer token returns today's and this month's spend and the last runs, so you can check spend from your phone.
- **Generated content:** a live run is only visible at its unguessable URL, and it's deleted after 7 days unless you promote it to the gallery.

## Hosting options

Prices are list prices I looked up today (2026-10-12), rounded. Check them again at signup. "Low traffic" means a few hundred visitors a month and a handful of live runs a day. **API spend is separate** and capped by the daily cap below.

|                        | A. Vercel + Fly.io job server (recommended)                                                                                               | B. One container on Fly.io                                                     | C. Railway (one service)                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| What runs where        | Next.js on Vercel Hobby (static pages + CDN); `apps/worker` on one Fly machine (shared CPU, 2 GB) with a 1 GB volume, auto-stop when idle | Next.js standalone + the job code in one process, always on, volume for SQLite | Same as B on Railway, with a volume                             |
| Monthly cost           | **~$0–3** idle-heavy (Fly bills per second while running) to **~$11** if the worker never sleeps. Vercel Hobby $0                         | **~$11** (the machine must stay on, or the landing page cold-starts)           | **$5 plan + usage**: 2 GB always on is ~$20 of RAM, so **~$20** |
| Gallery when jobs fail | **Unaffected**: static, on a CDN                                                                                                          | Down with the container                                                        | Down with the container                                         |
| First page load        | Fast everywhere (CDN)                                                                                                                     | One region; fine in the US/EU                                                  | One region                                                      |
| Cold start             | Only live features (~3–5 s to wake the worker; the UI says "warming up")                                                                  | None                                                                           | None                                                            |
| Complexity             | Two deploys, CORS locked to the site origin                                                                                               | Simplest: one deploy, one origin                                               | Simple, but the priciest here                                   |
| Caveats                | Vercel Hobby is for personal, non-commercial use, which a portfolio fits; Pro is $20/month if that ever changes. Fly needs a card on file | Cold-starting it would hurt the page recruiters see first                      | –                                                               |

**Recommendation: A.** It's the cheapest at your traffic and, more importantly, it matches the requirement that the gallery always works: the page most visitors see is static on a CDN and has no runtime dependency. The paid part sleeps when no one uses it. The cost of A is a second deploy target, which I'd keep small with a `Dockerfile` and a `fly.toml` in `apps/worker`.

**Daily cap and the worst case:** with a $3/day cap, the worst month is **$90 of API spend** plus hosting, so I'd also set a monthly cap (e.g. $30). At the phase 5b average of $0.09 per design, $3 is ~30 live generations a day.

## Visual design

- **Concept: a proofing table.** The page is quiet and neutral, like a light-table, so the design under review is the only colorful thing on screen. Redline's red is reserved for exactly one job: **marking problems**, as a proofreader's pen does. Score, outlines, numbered badges. Everything else is graphite and paper. Dark mode by default for the stage (designs pop on a dark surround), with a light theme.
- **Type:** Inter for the UI (the designs use Inter too, so measurement parity is free), with a monospaced face for measurements (`1.24:1 · threshold 3:1`), echoing the CLI.
- **Motion that explains:** candidates fan out from the plan, the winner lifts, outlines draw themselves on and fade out when fixed, the score counts between values, the heatmap crossfades between steps. All under 300 ms per transition, and turned off under `prefers-reduced-motion`.
- **Mobile:** gallery, run player and results are fully usable on a phone (canvas on top, timeline as a bottom sheet). The editor is desktop-first; on a phone it's view-and-scrub only, with a note.
- I'll use the frontend-design skill when building it, and check every page in a real browser at phone and desktop widths before calling it done.

## Testing

No test spends money: every test uses the existing mocks (scripted editor, scripted judge, mock image provider, fake saliency model, fake Anthropic client).

- **Job server API** (Hono's in-process `app.request`, no network): validation errors, 429 on quota, refusal when the cap is reached, SSE event order and `Last-Event-ID` replay, kill switch, CORS, moderation refusal **before any provider call** (asserted on the mocks' call counts).
- **Rate limiting:** per-visitor and per-IP counters, day rollover with an injected clock, concurrent requests.
- **Spend cap:** reservations under concurrency never exceed the cap; release on success, failure and client disconnect; the monthly cap; `/status` flips to `live: false`.
- **Safety:** the FLUX request never disables the safety checker; a filtered image fails the slot cleanly.
- **Client-side checker:** the shared renderer and the browser measurer in jsdom with `@napi-rs/canvas` standing in for the DOM canvas; **parity test** that the browser path gives the same score and issues as `checkFile` for all 22 fixtures (tolerance on text widths, since Skia and browsers measure Inter slightly differently; I'll report the actual difference).
- **Gallery:** every snapshot re-checks to its recorded score; every image referenced exists; the bundle contains no API key strings.
- **E2E smoke** with Playwright against `next build` output: landing, gallery replay and the editor, with the job server mocked. Kept to a few tests so it stays fast.
- **Unchanged:** lint, typecheck, build and all 345 existing tests keep passing at every commit.

## Steps (each a small commit)

1. **Core refactors, no behavior change.** Move the drawing code to core `paintDesign` (Node render unchanged, its tests untouched). Add `createFixSessionFromDesign`. Pin the FLUX safety-checker test.
2. **Browser environment** for the checker: `createBrowserMeasurer`, `createBrowserSampler`, parity tests.
3. **`apps/worker`:** run store (SQLite), SQLite ledger, quotas, reservations, moderation, `/runs/*` with SSE, `/attention`, `/status`, admin route. Tests.
4. **Gallery build script** and the first gallery runs.
5. **`apps/web` shell:** design tokens, layout, the stage component (canvas, overlays, heatmap, score).
6. **Replay player** and timeline scrubber; gallery and run pages; landing page with the looping demo.
7. **Check and fix** page, then the **editor** (drag, resize, recolor, undo) with live checking.
8. **Generate** page wired to the worker's SSE.
9. **Export** (PNG, JSON).
10. **Polish pass** in a real browser at phone and desktop widths; Lighthouse on landing and gallery.
11. **Deploy files** (`fly.toml`, `Dockerfile`, Vercel config, `.env.example` for both apps) and **README**: running the web app locally (`npm run dev -w apps/web` + `npm run dev -w apps/worker`, with an offline mode on mocks that needs no keys) and how it's deployed. I write the deploy config but **don't deploy**.
12. **Phase 6 report.**

Nothing is merged or pushed; you do that.

## Risks

- **Text measurement in browsers differs slightly from Skia.** Word wrapping could break at a different word in an edge case, changing a `text-overflow` result between the editor and the server. The parity test measures this; if it matters, the browser can use the same Inter metrics table the heuristic measurer is built from.
- **The heatmap lags edits** by the debounce plus a round trip (~0.5–1 s). The layout score is instant; the heatmap shows "updating…" until it catches up.
- **The worker cold start** (~3–5 s) shows up only on live features.
- **Gallery size in git** (~10–15 MB of images). The alternative is object storage (Cloudflare R2's free tier), which adds an account.

## Decisions I need from you

1. **Hosting:** OK with **A (Vercel Hobby + Fly.io worker, ~$0–11/month plus API spend)**? It needs a Vercel account and a Fly.io account with a card. I won't create either.
2. **Limits:** proposed **3 generates and 5 fixes per visitor per day**, **$3/day global cap**, **$30/month cap**, **$0.40 per run**. Change any of these?
3. **Domain:** e.g. `redline.simonlunay.com` for the site and `api.redline.simonlunay.com` for the worker? You'd add two DNS records yourself.
4. **Gallery runs:** OK to commit ~10–15 MB of gallery images, or would you rather use R2? And OK to include runs that didn't fully succeed (judge said "fix"), labeled honestly? I think it makes the demo more credible.
5. **Models for live runs:** same as the evals (Sonnet 5.5 director and fixer, Opus 5.5 judge, 2 judge rounds)? Dropping the Opus judge to 1 round, or using Sonnet as the judge, would roughly halve the cost per run, at the cost of the independence the phase 5 report argued for.
6. **Live runs in the gallery:** keep visitors' runs private (unguessable URL, deleted after 7 days), with you promoting good ones by hand? Or show a public "recent runs" strip (more alive, but needs moderation of outputs)?
7. **Turnstile:** OK to use Cloudflare Turnstile? It needs a free Cloudflare account.
8. **Upload limits:** designs with data-URL images only, 4 MB max, no remote URLs. OK?
