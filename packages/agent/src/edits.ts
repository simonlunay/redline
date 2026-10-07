import { FixSchema } from '@simonlunay/redline';
import type { Design } from '@simonlunay/redline';
import { z } from 'zod';
import type { Edit, RegenerateEdit } from './types.js';

/** Hard cap per response, so one runaway answer can't rewrite the whole design. */
export const MAX_EDITS_PER_RESPONSE = 25;

const reason = z.string().describe('One short sentence: why this edit, which issue it fixes');

/** Every fix op, each extended with a `reason`. Same op format as applyFixes. */
export const EditSchema = z.discriminatedUnion(
  'op',
  FixSchema.options.map((option) => option.extend({ reason })) as unknown as [
    ReturnType<(typeof FixSchema.options)[number]['extend']>,
    ...ReturnType<(typeof FixSchema.options)[number]['extend']>[],
  ],
);

/** What an editor must return (for LLMs: the submit_edits tool input). */
export const EditResponseSchema = z.object({
  summary: z.string().describe('One or two sentences: the plan for this iteration'),
  edits: z
    .array(EditSchema)
    .describe(`Edits to apply in order (at most ${MAX_EDITS_PER_RESPONSE}). Empty if done.`),
});

/**
 * Generation mode only: replace a generated image with a new one made from a revised brief.
 * It is deliberately NOT part of EditSchema, so `redline fix` (user designs) can't express it.
 */
export const RegenerateImageEditSchema = z.object({
  op: z.literal('regenerateImage'),
  elementId: z.string().describe('Id of a regenerable image element (listed in the request)'),
  brief: z
    .string()
    .describe(
      'The complete revised image brief: what the image shows plus where it must stay calm, e.g. "... keep the top-left third plain and dark for the headline". Never ask for text.',
    ),
  reason: z
    .string()
    .describe('One short sentence: which issue this fixes and why layout edits would not'),
});

/** The submit_edits input in generation mode: layout edits plus image regenerations. */
export const GenerationEditResponseSchema = z.object({
  summary: z.string().describe('One or two sentences: the plan for this iteration'),
  edits: z
    .array(z.discriminatedUnion('op', [...EditSchema.options, RegenerateImageEditSchema]))
    .describe(
      `Edits to apply in order (at most ${MAX_EDITS_PER_RESPONSE}). Regenerations run first. Empty if done.`,
    ),
});

export type EditResponse = { summary: string; edits: Edit[]; regenerations: RegenerateEdit[] };

export type ParseResult = { ok: true; value: EditResponse } | { ok: false; error: string };

/**
 * Validates raw editor output. Error text is written to be fed back to the LLM on retry.
 * `regenerate: true` (generation mode) also accepts regenerateImage ops; otherwise they fail
 * validation like any unknown op.
 */
export function parseEditResponse(
  raw: unknown,
  options: { regenerate?: boolean } = {},
): ParseResult {
  if (raw === undefined) {
    return {
      ok: false,
      error: 'No submit_edits tool call was made. Call submit_edits exactly once.',
    };
  }
  const schema = options.regenerate ? GenerationEditResponseSchema : EditResponseSchema;
  const result = schema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 8)
      .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    return { ok: false, error: `The response did not match the submit_edits schema:\n${details}` };
  }
  const data = result.data as { summary: string; edits: (Edit | RegenerateEdit)[] };
  if (data.edits.length > MAX_EDITS_PER_RESPONSE) {
    return {
      ok: false,
      error: `Too many edits (${data.edits.length}); send at most ${MAX_EDITS_PER_RESPONSE}, most important first.`,
    };
  }
  const isRegen = (e: Edit | RegenerateEdit): e is RegenerateEdit => e.op === 'regenerateImage';
  return {
    ok: true,
    value: {
      summary: data.summary,
      edits: data.edits.filter((e): e is Edit => !isRegen(e)),
      regenerations: data.edits.filter(isRegen),
    },
  };
}

/** Strips `reason` so edits can be passed to applyFixes. */
export function toFix(edit: Edit): Omit<Edit, 'reason'> {
  const { reason: _reason, ...fix } = edit;
  return fix;
}

/** Fields the loop must never change: copy and media belong to the user, not the fixer. */
const PROTECTED = ['content', 'fontFamily', 'src', 'type'] as const;

/**
 * Guardrail backstop: compares protected fields between the original and a candidate.
 * The edit format already has no op that can touch them; this catches bugs, not models.
 * Returns a list of violations (empty when the candidate is fine).
 */
export function protectedFieldViolations(
  original: Design,
  candidate: Design,
  /** Image elements whose `src` may differ (regenerated in generation mode). */
  allowSrcChange: ReadonlySet<string> = new Set(),
): string[] {
  const violations: string[] = [];
  const after = new Map(candidate.elements.map((el) => [el.id, el]));
  for (const el of original.elements) {
    const next = after.get(el.id);
    if (!next) {
      violations.push(`element "${el.id}" was removed`);
      continue;
    }
    for (const field of PROTECTED) {
      if (field === 'src' && allowSrcChange.has(el.id)) continue;
      const a = (el as Record<string, unknown>)[field];
      const b = (next as Record<string, unknown>)[field];
      if (a !== b) violations.push(`"${el.id}".${field} changed`);
    }
  }
  const originalIds = new Set(original.elements.map((el) => el.id));
  for (const el of candidate.elements) {
    if (!originalIds.has(el.id) && (el.type !== 'shape' || el.role !== 'decoration')) {
      violations.push(`new element "${el.id}" is not a decoration shape`);
    }
  }
  return violations;
}
