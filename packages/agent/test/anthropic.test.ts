import type Anthropic from '@anthropic-ai/sdk';
import { check, parseDesign } from '@simonlunay/redline';
import { describe, expect, it } from 'vitest';
import { parseEditResponse } from '../src/edits.js';
import { createAnthropicEditor, submitEditsTool } from '../src/editors/anthropic.js';
import { buildSystemPrompt, buildUserMessage } from '../src/prompt.js';
import type { EditRequest } from '../src/types.js';

const design = parseDesign({
  version: '0.1',
  canvas: { width: 1080, height: 1080, background: '#ffffff' },
  elements: [
    {
      id: 'title',
      type: 'text',
      role: 'headline',
      content: 'Hello',
      x: 100,
      y: 100,
      width: 880,
      height: 120,
      fontSize: 96,
      color: '#cccccc',
    },
  ],
});
const request: EditRequest = {
  design,
  report: check(design),
  target: 90,
  iteration: 1,
  attempts: [{ iteration: 0, outcome: 'rolled-back', message: 'Score dropped from 50 to 40.' }],
  images: [{ label: 'annotated render', png: new Uint8Array([137, 80, 78, 71]) }],
};

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

/** Minimal stand-in for the SDK client that records requests and returns a canned message. */
function fakeClient(reply: Partial<Anthropic.Message>) {
  const calls: CreateParams[] = [];
  const client = {
    messages: {
      create: async (params: CreateParams) => {
        calls.push(params);
        return {
          model: params.model,
          stop_reason: 'tool_use',
          content: [],
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 0,
          },
          ...reply,
        };
      },
    },
  } as unknown as Pick<Anthropic, 'messages'>;
  return { client, calls };
}

const toolUse = (input: unknown) => ({
  type: 'tool_use',
  id: 'toolu_1',
  name: 'submit_edits',
  input,
});

describe('anthropic editor', () => {
  it('sends a cached system prompt, a strict tool, effort, and the image', async () => {
    const { client, calls } = fakeClient({
      content: [toolUse({ summary: 's', edits: [] })] as Anthropic.ContentBlock[],
    });
    const editor = createAnthropicEditor({ client });
    const response = await editor.proposeEdits(request);

    const params = calls[0]!;
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params.output_config).toEqual({ effort: 'medium' });
    expect(params.tool_choice).toEqual({ type: 'auto' });
    expect(params.tools![0]).toMatchObject({ name: 'submit_edits', strict: true });
    expect(params.system).toEqual([
      { type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } },
    ]);
    // Reproducibility: no fallback to another model may be configured.
    expect(params).not.toHaveProperty('fallbacks');
    expect(params).not.toHaveProperty('betas');
    const content = params.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toEqual({ type: 'text', text: 'Image: annotated render' });
    expect(content[1]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/png', data: 'iVBORw==' },
    });

    expect(response).toMatchObject({
      raw: { summary: 's', edits: [] },
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0 },
    });
  });

  it('honors model and effort options', async () => {
    const { client, calls } = fakeClient({ content: [] });
    await createAnthropicEditor({ client, model: 'claude-opus-5-5', effort: 'high' }).proposeEdits(
      request,
    );
    expect(calls[0]).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'high' } });
  });

  it('returns raw undefined when the model answers without calling the tool', async () => {
    const { client } = fakeClient({
      content: [{ type: 'text', text: 'I think it looks fine', citations: null }],
    });
    const response = await createAnthropicEditor({ client }).proposeEdits(request);
    expect(response.raw).toBeUndefined();
    expect(parseEditResponse(response.raw)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/No submit_edits tool call/),
    });
  });

  it('throws on a refusal so the loop stops with editor-error', async () => {
    const { client } = fakeClient({ stop_reason: 'refusal' });
    await expect(createAnthropicEditor({ client }).proposeEdits(request)).rejects.toThrow(
      /declined/,
    );
  });
});

describe('strict tool schema', () => {
  it('uses anyOf, closes every object and drops unsupported keywords', () => {
    const json = JSON.stringify(submitEditsTool().input_schema);
    expect(json).not.toMatch(/"oneOf"|"minimum"|"pattern"|"\$schema"|"default"/);
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (obj.type === 'object' && obj.properties) {
        expect(obj.additionalProperties).toBe(false);
        expect(obj.required).toEqual(Object.keys(obj.properties));
      }
      Object.values(obj).forEach(walk);
    };
    walk(submitEditsTool().input_schema);
    expect(json).toContain('insertShape');
  });
});

describe('prompt', () => {
  it('system prompt is stable (cacheable) and describes rules and the format', () => {
    const prompt = buildSystemPrompt();
    expect(buildSystemPrompt()).toBe(prompt);
    expect(prompt).toContain('text-contrast');
    expect(prompt).toContain('insertShape');
    expect(prompt).toContain('"version"');
  });

  it('user message includes score, issues with suggestions, layout and past attempts', () => {
    const message = buildUserMessage({ ...request, validationError: 'bad edits' });
    expect(message).toMatch(/Current score \d+\/100 \(target 90/);
    expect(message).toMatch(/\[error\] \[text-contrast\] elements title/);
    expect(message).toMatch(/suggested: setColor/);
    expect(message).toMatch(/- title \[text, headline\] z=0 x=100 y=100 w=880 h=120/);
    expect(message).toMatch(/iteration 0 \(rolled-back\): Score dropped/);
    expect(message).toMatch(/Your previous response was invalid\nbad edits/);
  });
});
