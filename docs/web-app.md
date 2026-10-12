# Web app

Live at **[simonlunay.github.io/redline](https://simonlunay.github.io/redline/)**. `apps/web` is a Next.js (App Router) site, exported as static files: no server, no API keys, no AI calls. It has three parts:

- **Recorded runs** (`/gallery`, `/runs/<id>`): 17 generate runs from the [hosted-cutout and contact-shadow evals](evaluation.md#generation) and 5 fix-loop runs, replayed on a timeline you can scrub with the mouse or the arrow keys. Red marks are the checker's issues (solid: error, dashed: warning), blue corner marks are what the fix loop changed, and dashed red `J` boxes are the vision judge's findings. The heatmap shows predicted attention. Runs the judge didn't ship, or the loop didn't solve, are included and labeled with what still looks wrong.
- **Check and edit** (`/check`): open one of the 22 sample designs, a step of any run, or your own design JSON (images embedded as data URLs, 4 MB max). Drag, resize (Shift keeps the ratio) and recolor elements; the checker re-runs on every change. **Fix it with the rules (no AI)** runs the real fix loop in your browser with the checker's own suggested fixes, next to the recorded AI result for that design.
- **Export** a PNG at full size, or the design as self-contained JSON that `redline check` and `redline fix` accept.

## How the browser checks

The isomorphic `check()` runs client-side with the same Inter files, the same shared renderer (`paintDesign` in the checker's core, which the CLI's PNGs use too), the same pixel sampler and the same rule order as the CLI. The models stay out of the browser:

- **Attention:** the gallery build ran MSI-Net on every recorded design and stored the attention rules' results plus a small heatmap. The browser replays those results for an unedited design, so its score is exactly what was measured. Once you edit, the attention rules pause (the page says so) until you undo back.
- **Image rules:** each image's text detection and cutout analysis is stored with the run, since editing never changes an image.

A unit test re-checks every stored snapshot with the browser's rule set and gets the stored report exactly. An end-to-end test does the same for all 22 samples in Chromium, where text is measured by the browser's own canvas. It runs on Windows and on Linux (CI).

**Text is measured unhinted.** The canvases that measure and draw design text use `textRendering = 'geometricPrecision'`. Without it, Linux Chromium hints glyphs and rounds each advance to a whole pixel, so a label measured 90 px instead of the CLI's 87.69 and wrapped in its 88 px button (hard-leaderboard scored 50 instead of 79). After the fonts load, the page measures one probe string per Inter weight against the CLI's widths. If a face didn't load or a width is off by more than 0.02 px, the run and check pages say so instead of showing different scores without explanation.

## Running it locally

```bash
npm install
npm run build:packages          # the site imports the packages' dist/
npm run web                     # dev server on http://localhost:3000
npm run build -w apps/web       # static site in apps/web/out/
node apps/web/scripts/serve-static.mjs 4173    # serve out/ like GitHub Pages
npm run e2e                     # Playwright end-to-end tests (after a build)
```

`npm run build -w apps/web` also flattens Next 16's route-segment files so prefetching works on a plain static host, and fails if anything key-like ends up in `out/` (`scripts/check-no-secrets.mjs`).

## Rebuilding the gallery

The gallery data is committed (`apps/web/public/gallery/`, `public/samples/`: 5.7 MB of images, 0.9 MB of JSON). To rebuild it:

```bash
npm run gallery -w apps/web     # free: no API calls; needs out/eval-generate/ from the evals
```

It reads the runs listed in `apps/web/scripts/gallery-sources.ts`, converts generated images to WebP (fixture images stay lossless PNG), and checks every snapshot twice:

1. on the original images with every rule the run used, which is compared with the score the run recorded and is where the attention results, image analyses and heatmaps come from;
2. on the images as served, with exactly the browser's rule set, which is the report the site shows.

It prints any differences and fails above 15 MB of images. The fix runs `worst`, `story-concert` and `ad-sneaker-sale` were recorded for the gallery with `npm run record-fix-runs -w apps/web` (Sonnet 5.5, strict settings, $0.26 through a $0.50 ledger in `apps/web/gallery-src/`). `hard-story-hero` and `hard-busy-photo-tiny-cta` come from the strict eval, which didn't keep each edit's values, so their pages show the recorded reasons and the changes computed from the two designs.

`npm run demo-video -w apps/web` re-records `docs/media/redline-demo.gif` and `.mp4` from the real player (needs ffmpeg).

## Deploying

`.github/workflows/pages.yml` lints, typechecks, runs the unit and end-to-end tests, builds the site and publishes it to GitHub Pages on every push to `main`. One-time setup: **Settings → Pages → Source: GitHub Actions**. The site is then at `https://simonlunay.github.io/redline/`, built with `NEXT_PUBLIC_BASE_PATH=/redline`. No secrets are needed.

**Moving to `redline.simonlunay.com`:**

1. At your DNS provider, add a `CNAME` record: `redline` → `simonlunay.github.io`.
2. In **Settings → Pages → Custom domain**, enter `redline.simonlunay.com`, wait for the DNS check, and turn on **Enforce HTTPS**. (With an Actions deployment, the domain lives in the settings; no `CNAME` file is needed.)
3. In `.github/workflows/pages.yml`, set `BASE_PATH: ''`, since the site now lives at the domain's root, and push.

## Adding a live backend

Nothing live is built, but the seams are there. The player reads runs through a `RunSource` (`src/lib/run/source.ts`) that yields the record as it grows. Today `staticRunSource` yields a stored file once; a live source would turn the pipeline's `GenerateEvent`s and the loop's `IterationRecord`s, streamed over Server-Sent Events, into the same record. Attention would come from a server or an onnxruntime-web model behind the core's existing `SaliencyModel` interface. Rate limits, spend caps and hosting for that were planned in the first version of the [web app plan](phase-6-plan.md) (commit `ed38103`).
