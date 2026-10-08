import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { createScriptedEditor } from '@simonlunay/redline-agent';
import { parseDesign } from '@simonlunay/redline';
import { describe, expect, it } from 'vitest';
import { createTemplateArtDirector } from '../src/director/template.js';
import {
  DEFAULT_JUDGE_MODEL,
  buildJudgeSystemPrompt,
  createAnthropicJudge,
} from '../src/judge/anthropic.js';
import { comparePair, seededRandom } from '../src/judge/pairwise.js';
import { createJudgeStore, judgeElements } from '../src/judge/rule.js';
import { createScriptedJudge } from '../src/judge/scripted.js';
import type { JudgeVerdict } from '../src/judge/types.js';
import { createBackdropKeyRemover } from '../src/node/cutout.js';
import { createMockImageProvider } from '../src/node/mock-provider.js';
import { generateDesign } from '../src/node/pipeline.js';
import { createWorkspace } from '../src/node/workspace.js';
import { buildSystemPrompt } from '@simonlunay/redline-agent';
import { brightnessSaliency, tempDir } from './helpers.js';

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

function fakeClient(answers: (unknown | { refusal: true })[]) {
  const requests: CreateParams[] = [];
  const client = {
    messages: {
      create: async (params: CreateParams) => {
        requests.push(params);
        const a = answers.shift();
        const refusal = (a as { refusal?: boolean } | undefined)?.refusal;
        return {
          model: params.model,
          stop_reason: refusal ? 'refusal' : 'end_turn',
          content: [{ type: 'text', text: typeof a === 'string' ? a : JSON.stringify(a) }],
          usage: {
            input_tokens: 3000,
            output_tokens: 600,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      },
    },
  } as unknown as Pick<Anthropic, 'messages'>;
  return { client, requests };
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const verdict = (findings: JudgeVerdict['findings'] = []): JudgeVerdict => ({
  verdict: findings.length ? 'fix' : 'ship',
  summary: findings.length ? 'Has problems.' : 'Looks fine.',
  findings,
});
const fakeText = (elementId: string | null, severity: 'high' | 'medium' | 'low' = 'high') => ({
  category: 'fake-text' as const,
  severity,
  elementId,
  box: null,
  description: 'gibberish lettering on a pill under the CTA',
  suggestion: 'regenerate-image' as const,
});

const request = {
  prompt: 'poster for a weekend yoga retreat',
  canvas: { width: 1080, height: 1350 },
  png: PNG,
  elements: [
    {
      id: 'bg',
      type: 'image' as const,
      role: 'background',
      box: { x: 0, y: 0, width: 1080, height: 1350 },
    },
    {
      id: 'h',
      type: 'text' as const,
      role: 'headline',
      box: { x: 80, y: 120, width: 900, height: 200 },
      text: 'Breathe in the mountains',
    },
  ],
  issues: [
    {
      ruleId: 'text-contrast',
      severity: 'warning',
      message: 'subheading contrast 4.1:1',
      elementIds: ['s'],
    },
  ],
};

describe('Claude vision judge', () => {
  it('uses Opus 5.5 by default, its own cached prompt, a JSON schema, and only the render, elements, issues and brief', async () => {
    const { client, requests } = fakeClient([verdict([fakeText('bg')])]);
    const result = await createAnthropicJudge({ client }).judge(request);
    expect(DEFAULT_JUDGE_MODEL).toBe('claude-opus-5-5');
    expect(result).toMatchObject({ verdict: 'fix', calls: 1, model: 'claude-opus-5-5' });
    expect(result.findings[0]).toMatchObject({ elementId: 'bg', category: 'fake-text' });
    const req = requests[0]!;
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.output_config).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } });
    expect(req.system).toEqual([
      expect.objectContaining({
        text: buildJudgeSystemPrompt(),
        cache_control: { type: 'ephemeral' },
      }),
    ]);
    // Independent of the fixer: a different system prompt entirely.
    expect(buildJudgeSystemPrompt()).not.toContain(buildSystemPrompt().slice(0, 200));
    const content = req.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content.map((b) => b.type)).toEqual(['image', 'text']);
    const text = (content[1] as Anthropic.TextBlockParam).text;
    expect(text).toContain('Brief: poster for a weekend yoga retreat');
    expect(text).toContain('- h: text (headline) at 80,120 900x200 "Breathe in the mountains"');
    expect(text).toContain('[text-contrast, warning] subheading contrast 4.1:1');
    expect(text).not.toMatch(/score|reason|summary|iteration/i);
  });

  it('retries once on an invalid answer, then fails clearly; a refusal throws', async () => {
    const retry = fakeClient(['not json', verdict()]);
    const ok = await createAnthropicJudge({ client: retry.client }).judge(request);
    expect(ok.calls).toBe(2);
    expect(JSON.stringify(retry.requests[1]!.messages)).toContain('previous answer was invalid');
    const bad = fakeClient(['{}', '{"verdict":"maybe"}']);
    await expect(createAnthropicJudge({ client: bad.client }).judge(request)).rejects.toThrow(
      /invalid twice/,
    );
    const refused = fakeClient([{ refusal: true }]);
    await expect(createAnthropicJudge({ client: refused.client }).judge(request)).rejects.toThrow(
      /declined/,
    );
  });

  it('blind pairwise: the request has only the two images and the brief', async () => {
    const { client, requests } = fakeClient([
      { better: '2', confidence: 'high', reasons: 'cleaner' },
    ]);
    await createAnthropicJudge({ client }).compare({
      prompt: 'yoga poster',
      first: PNG,
      second: PNG,
    });
    const req = requests[0]!;
    const content = req.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text', 'image', 'text']);
    const all = JSON.stringify(content.filter((b) => b.type === 'text'));
    expect(all).toContain('yoga poster');
    expect(all).not.toMatch(/before|after|issue|score|rule|fixed/i);
    expect(JSON.stringify(req.system)).not.toMatch(/before|after|score|rule/i);
  });
});

describe('pairwise comparison', () => {
  const a = new Uint8Array([1]);
  const b = new Uint8Array([2]);

  it('maps both orders back to A/B and counts a win only when they agree', async () => {
    // A judge that genuinely prefers B, whichever position it's in.
    const prefersB = createScriptedJudge(
      [],
      [
        (r) => ({ better: r.first[0] === 2 ? '1' : '2', confidence: 'high', reasons: '' }),
        (r) => ({ better: r.first[0] === 2 ? '1' : '2', confidence: 'high', reasons: '' }),
      ],
    );
    const out = await comparePair(prefersB, 'p', a, b, seededRandom(1));
    expect(out).toMatchObject({ winner: 'b', agreed: true, calls: 2 });
    expect(new Set(out.orders.map((o) => o.shownFirst))).toEqual(new Set(['a', 'b']));
  });

  it('turns pure position bias into a tie', async () => {
    const alwaysFirst = createScriptedJudge(
      [],
      [
        { better: '1', confidence: 'high', reasons: '' },
        { better: '1', confidence: 'high', reasons: '' },
      ],
    );
    const out = await comparePair(alwaysFirst, 'p', a, b, seededRandom(7));
    expect(out).toMatchObject({ winner: 'tie', agreed: false });
  });

  it('shuffles which goes first, reproducibly per seed', () => {
    const firsts = (seed: number) => {
      const r = seededRandom(seed);
      return Array.from({ length: 20 }, () => (r() < 0.5 ? 'a' : 'b')).join('');
    };
    expect(firsts(3)).toBe(firsts(3));
    expect(firsts(3)).toMatch(/a/);
    expect(firsts(3)).toMatch(/b/);
  });
});

describe('judge findings as issues', () => {
  const design = parseDesign({
    version: '0.1',
    canvas: { width: 1080, height: 1080, background: '#ffffff' },
    elements: [
      {
        type: 'image',
        id: 'bg',
        src: 'bg.jpg',
        x: 0,
        y: 0,
        width: 1080,
        height: 1080,
        naturalWidth: 1080,
        naturalHeight: 1080,
      },
      {
        type: 'text',
        id: 'h',
        content: 'Hello',
        x: 80,
        y: 80,
        width: 600,
        height: 120,
        fontSize: 80,
        color: '#000000',
      },
    ],
  });
  const run = (store: ReturnType<typeof createJudgeStore>, d = design) =>
    store.rule.check({ design: d, measurer: undefined as never }, {}) as {
      severity: string;
      elementIds: string[];
      message: string;
    }[];

  it('maps severity, keeps findings while their element is unchanged and suspends them once it changes', () => {
    const store = createJudgeStore();
    store.record(
      design,
      verdict([fakeText('bg', 'high'), fakeText('h', 'medium'), fakeText(null, 'low')]),
    );
    expect(run(store).map((i) => [i.severity, i.elementIds.join()])).toEqual([
      ['error', 'bg'],
      ['warning', 'h'],
      ['info', ''],
    ]);
    expect(run(store)[0]!.message).toMatch(/^Visual review \(fake-text\): .*regenerate this image/);
    // The headline moves: its finding and the design-level one are suspended; bg's stays.
    const moved = {
      ...design,
      elements: design.elements.map((e) => (e.id === 'h' ? { ...e, y: 100 } : e)),
    };
    expect(run(store, moved).map((i) => i.elementIds.join())).toEqual(['bg']);
    // A new image for bg suspends its finding too.
    const regen = {
      ...moved,
      elements: moved.elements.map((e) => (e.id === 'bg' ? { ...e, src: 'bg2.jpg' } : e)),
    };
    expect(run(store, regen)).toEqual([]);
  });

  it('treats a finding on an unknown element as design-level', () => {
    const store = createJudgeStore();
    store.record(design, verdict([fakeText('nope')]));
    expect(store.active(design)[0]!.elementId).toBeNull();
  });

  it('gives the judge the elements in paint order with their text', () => {
    expect(judgeElements(design).map((e) => [e.id, e.text])).toEqual([
      ['bg', undefined],
      ['h', 'Hello'],
    ]);
  });
});

describe('generateDesign with a vision judge', { timeout: 60_000 }, () => {
  async function run(
    judge: ReturnType<typeof createScriptedJudge>,
    editor = createScriptedEditor([]),
  ) {
    const dir = tempDir();
    return generateDesign({
      prompt: 'poster for a charity 5K, energetic, blue and orange',
      canvas: { width: 1080, height: 1350 },
      out: join(dir, 'charity.json'),
      director: createTemplateArtDirector(),
      provider: createMockImageProvider({ megapixels: 0.1 }),
      remover: createBackdropKeyRemover(),
      editor,
      candidates: 1,
      layouts: 1,
      maxIterations: 2,
      judge,
      workspace: await createWorkspace(dir, { attention: true, saliency: brightnessSaliency() }),
    });
  }

  it('turns a finding into an issue the fix loop acts on, and judges again after the loop', async () => {
    const judge = createScriptedJudge([verdict([fakeText('background')]), verdict()]);
    const editor = createScriptedEditor([
      {
        summary: 'Remake the background.',
        edits: [
          {
            op: 'regenerateImage',
            elementId: 'background',
            brief: 'same, absolutely no text',
            reason: 'visual-judge: fake text',
          },
        ],
      },
    ]);
    const result = await run(judge, editor);
    expect(judge.requests).toHaveLength(2);
    // The editor saw the judge's finding as an error.
    expect(editor.requests[0]!.report.issues).toContainEqual(
      expect.objectContaining({
        ruleId: 'visual-judge',
        severity: 'error',
        elementIds: ['background'],
      }),
    );
    expect(result.loop.history.flatMap((h) => h.regenerations ?? [])[0]?.status).toBe('applied');
    expect(result.judgments.map((j) => [j.round, j.verdict])).toEqual([
      [0, 'fix'],
      [1, 'ship'],
    ]);
    expect(result.final.report.issues.some((i) => i.ruleId === 'visual-judge')).toBe(false);
    // The judge never saw the fixer's reasoning.
    const seen = JSON.stringify(judge.requests.map((r) => ({ ...r, png: undefined })));
    expect(seen).not.toContain('Remake the background');
    expect(seen).not.toContain('visual-judge: fake text');
    expect(judge.requests[1]!.png.length).toBeGreaterThan(1000); // a real PNG render
  });

  it('does not let the fixer hide the product to clear an issue about it (key-element-visible)', async () => {
    // The phase 5 eval failure: out of regenerations, the fixer faded the damaged product out.
    const judge = createScriptedJudge([verdict([fakeText('subject')]), verdict()]);
    const editor = createScriptedEditor([
      {
        summary: 'Hide the damaged cutout.',
        edits: [{ op: 'setOpacity', elementId: 'subject', opacity: 0, reason: 'hide it' }],
      },
    ]);
    const result = await run(judge, editor);
    const hidden = result.loop.history.find((h) =>
      h.edits.some((e) => e.op === 'setOpacity' && e.elementId === 'subject'),
    );
    expect(hidden?.report.issues).toContainEqual(
      expect.objectContaining({
        ruleId: 'key-element-visible',
        severity: 'error',
        elementIds: ['subject'],
      }),
    );
    expect(hidden?.status).toBe('rolled-back');
    expect(result.final.design.elements.find((e) => e.id === 'subject')?.opacity).toBe(1);
  });

  it('caps the rounds: at most 3 judge calls and 2 fix loops when the judge never relents', async () => {
    const always = () => verdict([fakeText(null)]);
    const judge = createScriptedJudge([always, always, always, always, always]);
    const result = await run(judge);
    expect(judge.requests).toHaveLength(3);
    expect(result.judgments).toHaveLength(3);
    expect(result.loop.history.filter((h) => h.status === 'initial')).toHaveLength(2);
    expect(result.final.report.issues.some((i) => i.ruleId === 'visual-judge')).toBe(true);
  });

  it('keeps going without the judge if it fails', async () => {
    const broken = {
      ...createScriptedJudge(),
      judge: async () => {
        throw new Error('boom');
      },
    };
    const result = await run(broken as ReturnType<typeof createScriptedJudge>);
    expect(result.judgments).toEqual([]);
    expect(result.warnings.some((w) => /vision judge failed.*boom/.test(w))).toBe(true);
  });
});
