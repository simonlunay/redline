import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  estimateCostUsd,
  toStrictSchema,
} from '@simonlunay/redline-agent';
import type { Effort, TokenUsage } from '@simonlunay/redline-agent';
import { builtinRules } from '@simonlunay/redline';
import { z } from 'zod';
import { DesignPlanSchema, parsePlan } from '../plan.js';
import type { SpendLedger } from '../spend.js';
import { worstCaseLlmCallUsd } from '../spend.js';
import type { ArtDirector, CreativeBrief, DirectorResult } from './types.js';

export const PLAN_TOOL_NAME = 'submit_design_plan';

export interface AnthropicDirectorOptions {
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  client?: Pick<Anthropic, 'messages'>;
  /** Guards and records every call. */
  ledger?: SpendLedger;
  tag?: string;
}

export function designPlanTool(): Anthropic.Tool {
  return {
    name: PLAN_TOOL_NAME,
    description: 'Submit the complete design plan. Call exactly once.',
    strict: true,
    input_schema: toStrictSchema(z.toJSONSchema(DesignPlanSchema)) as Anthropic.Tool.InputSchema,
  };
}

/** Stable system prompt (no per-request data), so it is prompt-cached across calls. */
export function buildDirectorSystemPrompt(): string {
  const rules = builtinRules.map((r) => `- ${r.id}: ${r.description}`).join('\n');
  return `You are the art director of an automated design studio. From a short creative prompt you plan a finished graphic design (poster, social post, ad or banner): the copy, the colors, the layout, and briefs for the images. A pipeline then generates the images, assembles your layout, scores it with an automated design checker (Redline), and repairs remaining problems.

# Output
Call the ${PLAN_TOOL_NAME} tool exactly once with the plan. Plan the number of alternative layouts you are asked for. Make them genuinely different compositions (e.g. headline top vs. text on a panel at the bottom vs. text beside the subject), not small variations.

# Coordinates
All boxes are canvas pixels, origin top-left: x, y, width, height. zIndex is the paint order: the background image is 0, subjects 1, panels behind text 1-2, text 2-4, CTA button 3 with its label 4 on top.

# Elements
- One image element with role "background" covering the full canvas (x 0, y 0, full width and height), using a slot of kind "background".
- Exactly one text element with role "headline". Optional "subheading" and "body" text. A CTA is a rect or rounded shape with role "cta" plus a text label with role "cta" fully inside it (centered, same box or inset).
- Optional subject image (role "product") using a slot of kind "subject": the product, person, animal or object that is the hero. It is generated separately and cut out from its background, so it can sit over the background photo. Give it a box with roughly the aspect ratio of the subject.
- Supplied images: a logo goes in a slot of kind "user" with userImageId set, on an element with role "logo", sized to the supplied aspect ratio. Other supplied images may be used as the subject or background.
- Shapes with role "decoration" can be panels behind text (opacity 0.6-0.9) or small accents. Keep accents few and subtle; they compete for attention.

# Text
- Text is ALWAYS rendered as separate, editable text elements. Never ask an image model to draw words, letters, numbers or logos, and never put the copy in an image brief.
- Copy: a short, punchy headline (2-6 words), an optional subheading (one line), an optional short body, and a 1-3 word CTA. Put the same strings in the copy fields and in the text elements.
- Size boxes so the text fits: a line is about fontSize x lineHeight tall, and bold text averages about 0.58 x fontSize per character. Leave a little slack.
- Minimum font size: 2% of the canvas's shorter side for any text; headlines much larger (7-12% of the shorter side). The CTA label is clearly smaller than the headline.
- Fonts: use only the families listed as available. Weights 400, 600, 700, 900.
- Text over a photo must stay legible: plan the background's calm areas behind the text, and/or a translucent panel behind it. Use text colors with strong contrast.

# Image briefs
Each generated slot has:
- brief: what the image shows: subject, setting, lighting, mood, lens. Concrete and visual. For a subject: just the subject itself; it will be shot isolated on a plain backdrop for cutting out.
- calmAreas (backgrounds): where text will sit and what must stay calm, e.g. "keep the top third calm and uncluttered for the headline, with the runners in the lower half". Match it to your layout.
- style: the visual style, consistent with the prompt.
- stockQuery: a short stock photo search query.
Briefs must not contain any of the copy, brand names, or requests for text, signs or logos.

# The checker (what the result will be scored on)
${rules}
Also: keep ~5% margins from the canvas edges for text, logo and CTA; never put text over the subject; align elements on a shared left edge or center axis; keep the CTA prominent and isolated enough to be noticed; the headline should be the most prominent text.`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function buildDirectorMessage(brief: CreativeBrief, validationError?: string): string {
  const { width: W, height: H } = brief.canvas;
  const lines = [
    `Creative prompt: ${brief.prompt}`,
    `Canvas: ${W}x${H} px (${W > H * 1.15 ? 'landscape' : H > W * 1.15 ? 'portrait' : 'square'}).`,
    `Plan ${brief.layouts} alternative layout${brief.layouts === 1 ? '' : 's'}.`,
    `Available fonts: ${brief.fonts.join(', ')}.`,
  ];
  if (brief.brandColors?.length)
    lines.push(`Brand colors (use them): ${brief.brandColors.join(', ')}.`);
  if (brief.userImages?.length) {
    lines.push(
      `Supplied images:\n${brief.userImages
        .map(
          (u) =>
            `- id "${u.id}" (${u.use}, ${u.width}x${u.height})${u.description ? `: ${u.description}` : ''}`,
        )
        .join('\n')}`,
    );
  } else {
    lines.push('No images were supplied: every image is generated.');
  }
  if (validationError) {
    lines.push(
      `# Your previous plan was invalid\n${validationError}\nCall ${PLAN_TOOL_NAME} again with a corrected, complete plan.`,
    );
  }
  lines.push(`Call ${PLAN_TOOL_NAME} now.`);
  return lines.join('\n\n');
}

function usageOf(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Claude as art director: one stateless request, strict tool, cached system prompt, and one
 * retry with the validation errors if the plan is unusable. Like the fix-loop editor, no
 * server-side model fallback is enabled, so results always come from the recorded model.
 */
export function createAnthropicArtDirector(options: AnthropicDirectorOptions = {}): ArtDirector {
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  const client = options.client ?? new Anthropic({ maxRetries: 4 });
  const system = buildDirectorSystemPrompt();
  const tool = designPlanTool();

  async function call(brief: CreativeBrief, validationError?: string) {
    options.ledger?.guard(worstCaseLlmCallUsd(model), `art director (${model})`);
    const content: Anthropic.ContentBlockParam[] = [];
    for (const image of brief.userImages ?? []) {
      if (!image.preview) continue;
      content.push({ type: 'text', text: `Supplied image "${image.id}":` });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: toBase64(image.preview) },
      });
    }
    content.push({ type: 'text', text: buildDirectorMessage(brief, validationError) });
    const response = await client.messages.create({
      model,
      max_tokens: options.maxTokens ?? 16000,
      tools: [tool],
      tool_choice: { type: 'auto' },
      output_config: { effort },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    });
    const usage = usageOf(response.usage);
    options.ledger?.record({
      kind: 'llm',
      what: 'art-director',
      model: response.model,
      costUsd: estimateCostUsd(response.model, usage) ?? 0,
      tag: options.tag,
    });
    if (response.stop_reason === 'refusal') {
      throw new Error(`${response.model} declined the request (stop_reason: refusal)`);
    }
    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === PLAN_TOOL_NAME,
    );
    return { raw: toolUse?.input, usage, model: response.model };
  }

  return {
    name: `anthropic:${model}`,
    async plan(brief): Promise<DirectorResult> {
      const ctx = {
        canvas: brief.canvas,
        fonts: brief.fonts,
        userImageIds: (brief.userImages ?? []).map((u) => u.id),
        layouts: brief.layouts,
      };
      const first = await call(brief);
      let parsed = parsePlan(first.raw, ctx);
      const usage = { ...first.usage };
      let calls = 1;
      let last = first;
      let retriedAfter: string | undefined;
      if (!parsed.ok) {
        retriedAfter = parsed.error;
        last = await call(brief, parsed.error);
        calls++;
        for (const key of Object.keys(usage) as (keyof TokenUsage)[]) usage[key] += last.usage[key];
        parsed = parsePlan(last.raw, ctx);
      }
      if (!parsed.ok)
        throw new Error(`The art director's plan was invalid twice.\n${parsed.error}`);
      return {
        plan: parsed.plan,
        model: last.model,
        usage,
        calls,
        costUsd: estimateCostUsd(last.model, usage) ?? undefined,
        ...(retriedAfter ? { retriedAfter } : {}),
      };
    },
  };
}
