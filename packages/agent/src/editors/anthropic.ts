import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { EditResponseSchema, GenerationEditResponseSchema } from '../edits.js';
import { SUBMIT_TOOL_NAME, buildSystemPrompt, buildUserMessage } from '../prompt.js';
import type { DesignEditor, EditorResponse, TokenUsage } from '../types.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_EFFORT = 'medium';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicEditorOptions {
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Inject a client (tests use a fake). Defaults to `new Anthropic()`, which reads ANTHROPIC_API_KEY. */
  client?: Pick<Anthropic, 'messages'>;
  /**
   * Generation mode: the tool schema and prompt include regenerateImage. Only for designs whose
   * images were generated; `redline fix` never sets it. Pair with LoopOptions.regenerate.
   */
  generation?: boolean;
}

type JsonValue = unknown;

/** Keywords strict tool schemas don't support; they are validated client-side by Zod instead. */
const UNSUPPORTED = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'default',
]);

/**
 * Makes a Zod-generated JSON Schema acceptable for `strict: true` tool use: unions as anyOf,
 * no numeric/string constraints, and every object closed with all properties required.
 */
export function toStrictSchema(schema: JsonValue): JsonValue {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED.has(key)) continue;
    out[key === 'oneOf' ? 'anyOf' : key] = toStrictSchema(value);
  }
  if (out.type === 'object' && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as object);
  }
  return out;
}

export function submitEditsTool(options: { generation?: boolean } = {}): Anthropic.Tool {
  const schema = options.generation ? GenerationEditResponseSchema : EditResponseSchema;
  return {
    name: SUBMIT_TOOL_NAME,
    description:
      'Submit the edits for this iteration. Call exactly once per response, with an empty edits list if nothing should change.',
    strict: true,
    input_schema: toStrictSchema(z.toJSONSchema(schema)) as Anthropic.Tool.InputSchema,
  };
}

/** Base64 without Node's Buffer, so this file also works in the browser. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
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
 * DesignEditor backed by Claude. One stateless request per iteration: the loop sends the full
 * current state plus a summary of failed attempts, which keeps every call the same shape and
 * makes runs easy to replay. The system prompt and tool definition are identical on every call,
 * so they are prompt-cached across iterations and fixtures.
 *
 * No server-side model fallback is enabled on purpose: every response must come from the
 * model recorded in the results, so eval numbers are reproducible.
 */
export function createAnthropicEditor(options: AnthropicEditorOptions = {}): DesignEditor {
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  const client = options.client ?? new Anthropic();
  const generation = Boolean(options.generation);
  const system = buildSystemPrompt({ generation });
  const tool = submitEditsTool({ generation });

  return {
    name: `anthropic:${model}`,
    async proposeEdits(request): Promise<EditorResponse> {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const image of request.images ?? []) {
        content.push({ type: 'text', text: `Image: ${image.label}` });
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: toBase64(image.png) },
        });
      }
      content.push({ type: 'text', text: buildUserMessage(request) });

      const response = await client.messages.create({
        model,
        max_tokens: options.maxTokens ?? 16000,
        // Forced tool_choice is not supported on current models; `auto` + an explicit
        // instruction + strict schema, and the loop treats "no tool call" as invalid output.
        tools: [tool],
        tool_choice: { type: 'auto' },
        output_config: { effort },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
      });

      if (response.stop_reason === 'refusal') {
        throw new Error(`${response.model} declined the request (stop_reason: refusal)`);
      }
      const call = response.content.find(
        (block): block is Anthropic.ToolUseBlock =>
          block.type === 'tool_use' && block.name === SUBMIT_TOOL_NAME,
      );
      return {
        // undefined -> the loop reports "no submit_edits call" and retries once.
        raw: call?.input,
        usage: usageOf(response.usage),
        model: response.model,
      };
    },
  };
}
