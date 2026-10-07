import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { PLAN_TOOL_NAME, buildDirectorSystemPrompt, createAnthropicArtDirector } from '../src/director/anthropic.js';
import { templatePlan } from '../src/director/template.js';
import { BudgetExceededError, createMemoryLedger } from '../src/spend.js';
import { brief } from './helpers.js';

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

/** Fake Anthropic client: returns queued tool inputs and records every request. */
function fakeClient(inputs: unknown[]) {
  const requests: CreateParams[] = [];
  const client = {
    messages: {
      create: async (params: CreateParams) => {
        requests.push(params);
        const input = inputs.shift();
        return {
          model: params.model,
          stop_reason: 'tool_use',
          content: input === undefined ? [{ type: 'text', text: 'Here is my plan.' }] : [{ type: 'tool_use', id: 't1', name: PLAN_TOOL_NAME, input }],
          usage: { input_tokens: 3000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000 },
        };
      },
    },
  } as unknown as Pick<Anthropic, 'messages'>;
  return { client, requests };
}

describe('Claude art director', () => {
  it('sends a cached system prompt and a strict tool, and returns the validated plan', async () => {
    const good = templatePlan(brief());
    const { client, requests } = fakeClient([good]);
    const ledger = createMemoryLedger(5);
    const director = createAnthropicArtDirector({ client, ledger, model: 'claude-sonnet-5-5' });
    const result = await director.plan(brief());

    expect(result.plan).toEqual(good);
    expect(result.calls).toBe(1);
    expect(result.costUsd).toBeGreaterThan(0);
    const req = requests[0]!;
    expect(req.tools?.[0]).toMatchObject({ name: PLAN_TOOL_NAME, strict: true });
    expect(req.tool_choice).toEqual({ type: 'auto' });
    expect(req.system).toEqual([{ type: 'text', text: buildDirectorSystemPrompt(), cache_control: { type: 'ephemeral' } }]);
    const text = JSON.stringify(req.messages);
    expect(text).toContain('Creative prompt: poster for a charity 5K');
    expect(text).toContain('Canvas: 1080x1350 px (portrait)');
    expect(text).toContain('Plan 2 alternative layouts');
    expect(ledger.entries()).toMatchObject([{ kind: 'llm', what: 'art-director', model: 'claude-sonnet-5-5' }]);
  });

  it('retries once with the validation errors, then succeeds', async () => {
    const bad = templatePlan(brief());
    bad.layouts[0]!.imageSlots[0]!.brief = 'Runners under a banner reading Charity 5K';
    const { client, requests } = fakeClient([bad, templatePlan(brief())]);
    const result = await createAnthropicArtDirector({ client }).plan(brief());
    expect(result.calls).toBe(2);
    expect(result.retriedAfter).toMatch(/contains the copy "charity 5k"/);
    expect(JSON.stringify(requests[1]!.messages)).toContain('Your previous plan was invalid');
  });

  it('fails after two invalid plans, and treats a missing tool call as invalid', async () => {
    const { client } = fakeClient([undefined, undefined]);
    await expect(createAnthropicArtDirector({ client }).plan(brief())).rejects.toThrow(/invalid twice[\s\S]*No submit_design_plan tool call/);
  });

  it('sends supplied images so the model can see them', async () => {
    const { client, requests } = fakeClient([templatePlan(brief())]);
    await createAnthropicArtDirector({ client }).plan(
      brief({ userImages: [{ id: 'logo', use: 'logo', width: 200, height: 100, preview: new Uint8Array([137, 80, 78, 71]) }] }),
    );
    const content = (requests[0]!.messages[0]!.content as Anthropic.ContentBlockParam[]).map((b) => b.type);
    expect(content).toEqual(['text', 'image', 'text']);
    expect(JSON.stringify(requests[0]!.messages)).toContain('id \\"logo\\" (logo, 200x100)');
  });

  it('refuses to call the API when the spend cap would be exceeded', async () => {
    const { client, requests } = fakeClient([templatePlan(brief())]);
    const ledger = createMemoryLedger(0.05);
    await expect(createAnthropicArtDirector({ client, ledger }).plan(brief())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(requests).toHaveLength(0);
  });
});
