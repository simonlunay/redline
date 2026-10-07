# Phase 4 plan: text-to-design generation with a self-correcting loop

Written 2026-10-06 at the start of the unattended run. Decisions are made without asking; each
one is explained here so it can be revisited.

## Ground rules for this run

- Branch `phase-4-generation`. No commits to `main`, no pushes, no npm publish, no releases.
- Keys available in `.env`: `ANTHROPIC_API_KEY`, `REPLICATE_API_TOKEN`. **No `PEXELS_API_KEY`**, so
  the Pexels provider is built and tested against a fake `fetch` only.
- **Spend cap $15** for the night. Every paid call (Claude and Replicate) goes through a
  persistent spend ledger (`packages/generate/eval/results/spend-ledger.json`) that refuses a
  call when `spent + worst-case estimate > cap`. Past the cap, everything continues with mocks.
- No test calls a paid API: tests use the mock image provider, the template art director and
  the scripted/suggested editors.

## Package decision: new `packages/generate` (`@simonlunay/redline-generate`)

Why a new package rather than a module in `packages/agent`:

1. **Dependencies.** Generation needs image-provider HTTP clients, a 224 MB background-removal
   model, file output and a manifest. Someone who only wants `redline fix` shouldn't get any
   of that. This mirrors the existing checker/agent split (checker has no LLM, agent is optional).
2. **Direction of dependency.** Generation _uses_ the fix loop; the fix loop must not know
   about generation. The one thing 4b needs from the loop (an image-regeneration hook) is a
   small, generic, opt-in extension point in `agent`, and the actual regeneration lives in
   `generate`.
3. **CLI.** `redline generate` is dispatched from the checker CLI by a dynamic import of
   `@simonlunay/redline-generate/node`, exactly like `redline fix`, with an install hint when
   the package is missing.

Layout (same isomorphic/Node split as the other packages, enforced by the same ESLint rule):

```
packages/generate/
  src/               isomorphic: plan schema, art director (Claude + template), prompt
                     building, assembly into the design format, best-of-N selection,
                     image-provider interface, Replicate + Pexels providers (fetch only),
                     spend ledger interface, regeneration op wiring
  src/node/          mock provider (canvas), user-image provider, BiRefNet cutouts (ONNX),
                     asset store + manifest, generation session, contact sheet,
                     `redline generate` command
  eval/              prompts.json, run.ts (npm run eval:generate), results/
  test/
```

## Phase 4a

### 1. Art director (`createAnthropicArtDirector`)

One Claude call (Sonnet 5.5 default, effort medium), stateless, cached system prompt, strict
tool `submit_design_plan` whose JSON Schema is generated from a Zod schema (same
`toStrictSchema` approach as `submit_edits`). Input: prompt, canvas size, optional brand colors,
fonts, logo, user images (sent as images so it can see them), number of layout variants.

The plan contains:

- `concept`, `palette` (hex), `copy` (headline, subheading, body, CTA label)
- `layouts[]`: 1-3 alternative layouts. Each has elements with role, kind
  (`text`/`shape`/`image`), box, z-order, text styling, and an `imageSlot` reference for images.
- `imageSlots[]` per layout: `background` or `subject` (or `user`/`logo` for supplied images),
  each with a **brief** plus `calmAreas`, a required description of where text will sit
  ("keep the top third calm and uncluttered for the headline").

Validation beyond the schema (fed back to Claude for one retry, like the fix loop): known roles,
text elements have content, hex colors, every image element references a slot, a background
slot exists, **no brief may contain the copy** (text stays as editable text elements, never in
the image), fonts must be ones that are actually available.

The image prompt sent to the provider is built in code: `brief + calmAreas + style +` an
automatically derived description of the text zones from the layout boxes ("the top 30% will
be covered by text: keep it calm, low-detail, even in tone") `+ "no text, no letters, no
words, no logos, no watermark"`. So the "where text sits" requirement holds even if the model's
own description is vague.

`createTemplateArtDirector()` is the deterministic offline director (fixed layouts parameterized
by canvas size and prompt keywords). Used in tests and with `--director template`.

### 2. Image providers (one `ImageProvider` interface)

```ts
interface ImageProvider {
  id: string;
  model: string;
  license: string;
  estimateCostUsd(request): number; // for the spend guard
  generate(request: { prompt; width; height; seed; kind }): Promise<GeneratedImage>;
}
```

- **Replicate FLUX.1 [schnell]** (`black-forest-labs/flux-schnell`, Apache-2.0, $0.003/image,
  verified 2026-10-06). Closest supported aspect ratio, PNG output, seed recorded, `Prefer: wait`.
- **Pexels** search (`PEXELS_API_KEY`, not present: implemented, tested with fake fetch only).
- **User images**: copied into the assets folder, license "supplied by user".
- **Mock**: deterministic gradient/noise backgrounds and simple subject shapes on a plain
  backdrop, seeded. Every test uses this.

### 3. Cutouts

Subjects are generated "isolated on a plain light-grey studio background", then the background
is removed locally with **BiRefNet_lite** (MIT) via `onnxruntime-node` (already an optional
peer dependency for the saliency model). Weights: `onnx-community/BiRefNet_lite-ONNX` at commit
`de15b22`, `onnx/model.onnx`, 224,005,088 bytes, SHA-256 `5600024…f03333`, downloaded straight
from Hugging Face into the existing Redline cache with the same pinned download/verify code as
MSI-Net. Not re-hosted anywhere. The cutout is trimmed to its alpha bounding box so the element
box matches the visible subject (matters for overlap and attention). Fallback if the model can't
load: keep the plain-background subject and record `cutout: null` in the manifest.

### 4. Assembly, best-of-N

- Candidate _i_ uses layout `i mod L` and background seed `base + i`, so N=4 with 2 layouts gives
  2 layouts x 2 backgrounds. Subjects are generated once per layout.
- Plan + images -> Redline design JSON (background image `fit: cover`, subjects `fit: contain`
  with the box fitted to the cutout aspect ratio, text/shape elements straight from the plan).
- Each candidate is scored with `checkAsync` (layout rules + attention rules, the same session
  the fix loop uses). Winner: highest score, then fewest errors, then higher CTA attention share.
- All candidates (design, report summary, attention shares) are kept in
  `<out>.generation.json`.

### 5. Fix loop on the winner

The existing `runFixLoop` with the Claude editor, attention on, vision on, default target 95.

### 6. Files and manifest

`--out poster.json` writes `poster.json`, `poster.assets/*.png` (relative `src` paths) and
`poster.assets/manifest.json` (per image: file, slot, kind, prompt, provider, model, seed, cost,
license, cutout model + license, created at), plus `poster.generation.json`.

### 7. CLI

`redline generate "prompt" --out design.json --size 1080x1350 --candidates 4 --target 95
--render-steps dir` plus `--brand-colors`, `--font`, `--logo`, `--image`, `--provider
replicate|pexels|mock`, `--director anthropic|template`, `--editor anthropic|suggested`,
`--budget`, `--no-attention`, `--format json`. Pretty output: plan, candidates with scores,
winner, then the fix loop's score climbing. `--render-steps` also writes `contact-sheet.png`:
every candidate's render and heatmap side by side with score and CTA share, the winner marked,
and the final fixed design at the end.

## Phase 4b: image-aware fixing

- New edit op `regenerateImage {elementId, brief, reason}` defined in `agent` but **only part of
  the edit schema when the loop is given a `regenerate` hook** (generation mode). `redline fix`
  never passes the hook, so for user designs the op doesn't exist in the tool schema, fails
  validation if sent anyway, and the `src` guardrail backstop stays exactly as it is.
- The loop applies regenerations first (async, via the hook), then the layout edits, then
  re-checks; normal accept/rollback applies. Cap per run (default 2), counted when attempted
  (they cost money even if rolled back); over the cap the op is rejected with a message.
  Each one is recorded in history with element, revised brief, reason, new src and cost.
- The guardrail allows a `src` change only on elements regenerated in that step.
- The Claude editor in generation mode gets an extra prompt section: when an issue comes from
  the image itself (contrast on a busy region, a background hot spot competing for attention),
  choose between a layout edit (scrim, move) and a regeneration with a revised brief ("calmer
  in the top-left"), and it gets the list of regenerable images with their current briefs.

## Evaluation

`npm run eval:generate`: 14 prompts (ads, posters, social posts, events, products; sizes
1080x1350, 1080x1080, 1080x1920 story, 1200x628 and 1500x500 banners; styles from photographic
to flat/minimal). Per prompt: first-candidate score (what N=1 would give), best-of-N winner
score, final score, iterations, regenerations, CTA attention before/after the loop, cost.
Summary row with means; results JSON in `packages/generate/eval/results/` with the spend.
Sonnet for everything, 1 run per prompt; small Opus comparison only if budget remains. I'll look
at every rendered output and report the ones that score well but look bad.

## Order of work (small commits)

1. Package scaffold, plan schema + validation, template director, mock provider, assembly,
   best-of-N, spend ledger, tests.
2. Claude art director (strict tool), Replicate + Pexels + user providers, tests with fakes.
3. BiRefNet cutouts (pinned download), tests with a fake model.
4. Generation session + `redline generate` CLI + contact sheet; live smoke test on 1-2 prompts.
5. README/NOTICE for 4a. Commit. Then 4b loop extension + tests, then eval, then report.
