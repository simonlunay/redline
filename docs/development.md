# Development

```bash
npm install
npm test                 # vitest: checker, agent, generate and the web app (no test calls a real API)
npm run lint             # eslint (also blocks Node imports in isomorphic code)
npm run typecheck
npm run build                                 # checker, then agent, then generate
npm run redline -- check fixtures/worst.json --annotate out/worst.png
npm run redline -- fix fixtures/worst.json --editor suggested    # offline
npm run eval -- --no-llm
npm run fixture-images -w packages/checker   # regenerate placeholder images
npm run calibrate-attention -w packages/agent  # re-derive attention thresholds
npm run eval:generate -- --offline              # generation eval with mocks, free
npm run redline -- generate "poster for a bake sale" --director template --provider mock --editor suggested
```

`npm run redline` runs the CLI straight from TypeScript source through a custom `@simonlunay/source` export condition, so you don't have to build first. Published builds ignore that condition.

LLM behaviour is tested with a scripted editor and a fake Anthropic client, and the CLI tests inject an empty environment, so tests never spend money.

**Reproducing the saliency model:** `packages/checker/scripts/convert-msi-net.py` (Python 3.11, TensorFlow 2.15.1, tf2onnx 1.16.1). On Windows, use a short venv path, because TensorFlow exceeds the 260-character path limit otherwise. A real-model smoke test runs only if the model is already in the cache, so CI never downloads it.

**Image-check models:** `npm run redline -- setup image-checks` downloads and verifies the two PP-OCRv5 files. Like the saliency test, the real-model text-detection test runs only if they are already cached.

## Layout

```
packages/checker/            @simonlunay/redline
  src/core/     isomorphic: schema, engine, fixes, geometry, colour, text layout, rules/
  src/node/     Node-only: fonts, image sampler, renderer, pretty formatter
  src/cli.ts
  fonts/        Inter (SIL Open Font License), for identical results on every OS
packages/agent/              @simonlunay/redline-agent
  src/          isomorphic: loop, edit schema + guardrails, prompt, editors/
  src/node/     redline fix command, sessions, output formatting
  eval/         npm run eval + saved results
packages/generate/           @simonlunay/redline-generate (private, not on npm)
  src/          isomorphic: plan schema, art directors, image prompts, providers, assembly,
                best-of-N selection, spend ledger
  src/node/     generate command, pipeline, cutouts (BiRefNet), assets + manifest, contact sheet
  eval/         npm run eval:generate, prompts.json, results/ (incl. spend-ledger.json)
apps/web/                    the web app (static Next.js site)
  src/lib/      browser environment, rule set, timeline, editor ops (tested in Node)
  src/components/  stage, player, timeline, check workspace
  scripts/      gallery build, fix-run recording, demo recording, static server, checks
  public/       committed gallery and sample data
  e2e/          Playwright tests against the static export
fixtures/       sample designs: clean, one per defect, worst case, messy ads, hard cases
```

ESLint's `no-restricted-imports` rule forbids `node:*`, `fs`, `path` and `@napi-rs/*` inside `packages/checker/src/core` and `packages/agent/src` (except `src/node`). That keeps the core isomorphic.

See [Web app](web-app.md) for building, testing and deploying the site.
