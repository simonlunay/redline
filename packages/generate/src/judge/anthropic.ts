import Anthropic from '@anthropic-ai/sdk';
import { estimateCostUsd, toStrictSchema } from '@simonlunay/redline-agent';
import type { Effort, TokenUsage } from '@simonlunay/redline-agent';
import { z } from 'zod';
import type { SpendLedger } from '../spend.js';
import { JudgeVerdictSchema, PairVerdictSchema } from './types.js';
import type {
  JudgeCallInfo,
  JudgeRequest,
  JudgeVerdict,
  PairRequest,
  PairVerdict,
  VisualJudge,
} from './types.js';

/**
 * The default judge model. Deliberately not the fixer's (Sonnet 5.5): a different model with
 * its own prompt is less likely to share the fixer's blind spots or approve its own work.
 */
export const DEFAULT_JUDGE_MODEL = 'claude-opus-5-5';

/** A judge call's worst case for the spend guard: ~4k image + ~4k text in, 8k out. */
export function worstCaseJudgeCallUsd(model: string): number {
  return (
    estimateCostUsd(model, {
      inputTokens: 10_000,
      outputTokens: 8_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 3_000,
    }) ?? 1
  );
}

/** Stable system prompt for reviewing one design (prompt-cached across calls). */
export function buildJudgeSystemPrompt(): string {
  return `You are a senior art director doing final quality control on a finished graphic design (poster, social post, ad or banner) before it ships. You see the rendered design exactly as a viewer would. Report what visibly looks wrong.

# What to look for
- fake-text: lettering, gibberish words, fake signs, labels, buttons or logos that are part of a photo or illustration rather than the design's real text. Real copy is set as separate text and listed in the element table; anything readable that isn't in the table is suspect.
- cutout: a subject cut out of its background badly: bitten or torn edges, see-through patches, halos or fringes, leftover background patches or slabs, a rectangle that was never cut out.
- artifact: image-model artifacts: melted or malformed objects, wrong anatomy (hands, faces, limbs), smears, duplicated parts, physically impossible details.
- cropping: a subject, face or product awkwardly cut off by the canvas edge or another element.
- color: colors that clash, or text and background colors that fight each other.
- composition: things that look misplaced, floating, at the wrong scale or perspective, crammed, unbalanced, or out of place for the brief.
- legibility: text that is hard to read in practice.
- other: anything else a client would send back.

# How to report
- Report only what clearly looks wrong to a professional at normal viewing size. Don't nitpick taste, and don't invent problems: a clean design should get no findings and the verdict "ship".
- An automated checker has already measured layout rules (contrast, margins, overlap, sizes, alignment, attention). Its open issues are listed. Don't repeat them; report what it missed.
- elementId: the id from the element table of the element the problem is in (for a problem inside a photo, the image element), or null if it's about the design as a whole. box: where it is in canvas pixels, if you can tell, otherwise null.
- severity: high = a client would reject the design for it; medium = clearly visible and should be fixed; low = minor polish.
- suggestion: regenerate-image when the problem is in an image's content (fake text, artifacts, a bad subject), recut for a badly cut-out subject that is otherwise fine, layout when moving, resizing or recoloring elements would fix it, none otherwise.
- verdict: ship (no high or medium findings), fix (worth fixing), reject (clearly broken). summary: one or two plain sentences.

Respond with the JSON object only.`;
}

/** Stable system prompt for the blind pairwise comparison. It sees no rules, issues or scores. */
export function buildPairSystemPrompt(): string {
  return `You are a senior art director. You are shown two finished versions of the same graphic design, "Image 1" and "Image 2", made for the brief below. Decide which one you would rather ship.

Judge them as finished work at normal viewing size: visible defects (fake text in images, bad cutouts, artifacts, awkward cropping), legibility, clear hierarchy (the headline and call to action are easy to find), balance and polish, and fit to the brief. The order of the images means nothing. If they are equally good or the differences don't matter, answer "tie".

better: "1", "2" or "tie". confidence: low, medium or high. reasons: one or two sentences naming the deciding differences. Respond with the JSON object only.`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const image = (png: Uint8Array): Anthropic.ImageBlockParam => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: toBase64(png) },
});

/** The per-request part of a design review: the brief, the element table and the open issues. */
export function buildJudgeMessage(req: JudgeRequest): string {
  const rows = req.elements.map((el) => {
    const b = el.box;
    const box = `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`;
    const text = el.text ? ` "${el.text.replace(/\s+/g, ' ').slice(0, 80)}"` : '';
    return `- ${el.id}: ${el.type}${el.role ? ` (${el.role})` : ''} at ${box}${text}`;
  });
  const issues = req.issues.length
    ? req.issues.map((i) => `- [${i.ruleId}, ${i.severity}] ${i.message}`).join('\n')
    : '(none)';
  return [
    `Brief: ${req.prompt}`,
    `Canvas: ${req.canvas.width}x${req.canvas.height} px. The image above is the render, scaled to fit.`,
    `# Elements (paint order, bottom first)\n${rows.join('\n')}`,
    `# Issues the automated checker already reports\n${issues}`,
    'Review the design now.',
  ].join('\n\n');
}

function usageOf(u: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

export interface AnthropicJudgeOptions {
  model?: string;
  /** Default 'medium' (Opus 5.5's own default, set explicitly). */
  effort?: Effort;
  maxTokens?: number;
  client?: Pick<Anthropic, 'messages'>;
  ledger?: SpendLedger;
  tag?: string;
}

/**
 * Claude as the vision judge. Stateless requests, cached system prompts, structured JSON output
 * validated with Zod and retried once if invalid. Like the fixer and the art director, no
 * server-side model fallback is enabled: a fallback to another model would quietly break the
 * judge's independence, and every verdict records the model that gave it.
 */
export function createAnthropicJudge(options: AnthropicJudgeOptions = {}): VisualJudge {
  const model = options.model ?? DEFAULT_JUDGE_MODEL;
  const effort = options.effort ?? 'medium';
  const client = options.client ?? new Anthropic({ maxRetries: 4 });
  const reviewSystem = buildJudgeSystemPrompt();
  const pairSystem = buildPairSystemPrompt();
  const reviewSchema = toStrictSchema(z.toJSONSchema(JudgeVerdictSchema)) as Record<
    string,
    unknown
  >;
  const pairSchema = toStrictSchema(z.toJSONSchema(PairVerdictSchema)) as Record<string, unknown>;

  async function ask<T>(
    what: 'judge' | 'judge-pair',
    system: string,
    schema: Record<string, unknown>,
    parse: z.ZodType<T>,
    content: Anthropic.ContentBlockParam[],
  ): Promise<T & JudgeCallInfo> {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let lastModel: string;
    let problem = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      options.ledger?.guard(worstCaseJudgeCallUsd(model), `vision judge (${model})`);
      const response = await client.messages.create({
        model,
        max_tokens: options.maxTokens ?? 8000,
        output_config: { effort, format: { type: 'json_schema', schema } },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: problem
              ? [
                  ...content,
                  {
                    type: 'text',
                    text: `Your previous answer was invalid: ${problem}. Send a corrected JSON object.`,
                  },
                ]
              : content,
          },
        ],
      });
      const u = usageOf(response.usage);
      for (const k of Object.keys(usage) as (keyof TokenUsage)[]) usage[k] += u[k];
      lastModel = response.model;
      options.ledger?.record({
        kind: 'llm',
        what,
        model: response.model,
        costUsd: estimateCostUsd(response.model, u) ?? 0,
        tag: options.tag,
      });
      if (response.stop_reason === 'refusal') {
        throw new Error(`${response.model} declined to judge (stop_reason: refusal)`);
      }
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      try {
        const parsed = parse.safeParse(JSON.parse(text));
        if (parsed.success) {
          return {
            ...parsed.data,
            model: lastModel,
            usage,
            costUsd: estimateCostUsd(lastModel, usage) ?? undefined,
            calls: attempt,
          };
        }
        problem = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      } catch (err) {
        problem =
          response.stop_reason === 'max_tokens'
            ? 'the response hit max_tokens and was cut off'
            : `not valid JSON (${(err as Error).message})`;
      }
    }
    throw new Error(`The vision judge's answer was invalid twice: ${problem}`);
  }

  return {
    name: `anthropic:${model}`,
    judge: (req): Promise<JudgeVerdict & JudgeCallInfo> =>
      ask('judge', reviewSystem, reviewSchema, JudgeVerdictSchema, [
        image(req.png),
        { type: 'text', text: buildJudgeMessage(req) },
      ]),
    compare: (req: PairRequest): Promise<PairVerdict & JudgeCallInfo> =>
      ask('judge-pair', pairSystem, pairSchema, PairVerdictSchema, [
        { type: 'text', text: 'Image 1:' },
        image(req.first),
        { type: 'text', text: 'Image 2:' },
        image(req.second),
        { type: 'text', text: `Brief: ${req.prompt}\n\nWhich would you rather ship?` },
      ]),
  };
}
