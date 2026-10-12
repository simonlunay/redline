# AI fix loop

`redline fix` (package `@simonlunay/redline-agent`) hands a design to Claude, applies its edits, re-checks, and repeats until the design is good. CLI options are in the [CLI reference](cli.md#redline-fix); the library API is in [Library](library.md#fix-loop-simonlunayredline-agent).

```
check ──► goal reached? ──yes──► done (return the best version + full history)
  ▲            │ no
  │            ▼
  │     LLM proposes edits (submit_edits tool: ops + a reason each)
  │            │  invalid? retry once with the validation error
  │            ▼
  │     applyFixes ──► guardrails ──► re-check
  │            │
  └── accept ◄─┴─► score dropped? roll back, tell the LLM what it broke
```

## What the model gets

In one stateless request per iteration:

- the score and the target
- every issue, with the checker's suggested fix
- a layout table (id, role, box, z-order, font/colour)
- feedback from earlier rolled-back or invalid attempts
- the design JSON
- the annotated render as an image (and, with `--attention`, the heatmap overlay as a second image)

**The system prompt never changes**, so it's prompt-cached across every call in a run and the whole eval. It holds the rules, the ops, the strategy and the design's JSON Schema.

**The model answers through a `submit_edits` tool** with `strict: true`, whose schema is generated from the same Zod schema `applyFixes` uses (see [Fixes](rules.md#fixes)). It can accept, adjust or ignore the checker's suggestions. Suggestions only know about one rule, and they often cause new problems: growing a text box can push it into the button below.

## Guardrails and stopping

- **Layout and style only:** the op set can't express changes to text, font family or image `src`. A backstop also compares those fields against the original after every step.
- **Validation:** every response is validated with Zod and retried once with the validation error. Responses are capped at 25 edits.
- **Rollback:** an iteration is accepted only if the score doesn't drop. Otherwise it's rolled back, and the next request includes the score drop plus the new issues it caused.
- **Stopping** happens when any of these is true:
  - score ≥ target **and** no errors remain
  - no issues remain
  - max iterations is reached
  - two iterations in a row fail to improve (by score or error count)
  - the editor fails
- **Best version:** the loop keeps the best version seen (highest score, then fewest errors).

**Replayable history:** every iteration, including rolled-back candidates, stores a full design snapshot, its report, the edits with reasons, token usage and timing. The [web app](web-app.md) replays it directly, and a test checks that every snapshot re-checks to its recorded score.

**Reproducibility:** no server-side model fallback is enabled, so every response comes from the model you asked for. The eval records the model id the API reports.

## With the attention check

With `--attention`, attention issues are just more issues for the loop. See [Attention check](attention.md#in-the-fix-loop).

## Editors

`DesignEditor` is a one-method interface (`proposeEdits(request) → { raw, usage, model }`), so other LLM providers plug in without touching the loop. Validation, guardrails and rollback all live in the loop, so every provider is treated the same.

- `createAnthropicEditor()` calls Claude (default `claude-sonnet-5-5`, effort `medium`).
- `createSuggestedFixesEditor()` is the deterministic, offline editor (`--editor suggested`) used in tests and as the eval's rules-only baseline.

In [generation](generation.md#how-it-works), the editor gets extra ops (`regenerateImage`, `setShadow`, `replaceText`). `redline fix` on your own designs never gets them.

## Results

On the 21-fixture strict benchmark, the loop takes the mean score from 62.1 to 98.8 (Sonnet 5.5) and 99.5 (Opus 5.5), against 81.8 for looping the checker's own suggestions. Full tables: [Evaluation](evaluation.md#fix-loop-strict-mode).
