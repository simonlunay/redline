import { parseDesign } from '@simonlunay/redline';
import type { Design, Report } from '@simonlunay/redline';
import { describe, expect, it } from 'vitest';
import { submitEditsTool } from '../src/editors/anthropic.js';
import { createScriptedEditor } from '../src/editors/scripted.js';
import { parseEditResponse } from '../src/edits.js';
import { runFixLoop } from '../src/loop.js';
import type { CopyEditOptions } from '../src/loop.js';
import { buildSystemPrompt } from '../src/prompt.js';

const design: Design = parseDesign({
  version: '0.1',
  canvas: { width: 1000, height: 1000, background: '#000000' },
  elements: [
    {
      id: 'headline',
      type: 'text',
      role: 'headline',
      x: 100,
      y: 100,
      width: 800,
      height: 120,
      content: 'Run For Hope',
      fontSize: 100,
      color: '#ffffff',
    },
    {
      id: 'sub',
      type: 'text',
      role: 'subheading',
      x: 100,
      y: 300,
      width: 800,
      height: 60,
      content: 'Charity 5K · June 14 · City Park',
      fontSize: 40,
      color: '#ffffff',
    },
  ],
});

/** Errors while the subheading still names a date or the park. */
const checkCopy = async (d: Design): Promise<Report> => {
  const sub = d.elements.find((e) => e.id === 'sub');
  const content = sub?.type === 'text' ? sub.content : '';
  const facts = ['June 14', 'City Park'].filter((f) => content.includes(f)).length;
  return {
    score: 100 - facts * 20,
    passed: facts === 0,
    summary: { errors: facts, warnings: 0, infos: 0 },
    rules: [],
    issues: Array.from({ length: facts }, () => ({
      ruleId: 'copy-grounded',
      severity: 'error' as const,
      elementIds: ['sub'],
      message: 'invented fact',
      measured: 1,
      threshold: 0,
    })),
  };
};

/** Only these exact spans may become placeholders (stands in for the pipeline's check). */
const copy: CopyEditOptions = {
  check: (edit) =>
    ['June 14', 'City Park', ' · City Park'].includes(edit.find) &&
    /^(\[[A-Za-z]+\])?$/.test(edit.replace)
      ? null
      : 'not a flagged fact',
};

const replace = (find: string, replace: string, elementId = 'sub') => ({
  op: 'replaceText',
  elementId,
  find,
  replace,
  reason: 'invented fact',
});

describe('replaceText in generation mode', () => {
  it('replaces flagged facts with placeholders and records them', async () => {
    const editor = createScriptedEditor([
      { summary: 's', edits: [replace('June 14', '[Date]'), replace(' · City Park', '')] },
    ]);
    const result = await runFixLoop(design, { editor, check: checkCopy, copy, target: 95 });
    const sub = result.best.design.elements.find((e) => e.id === 'sub');
    expect(sub?.type === 'text' && sub.content).toBe('Charity 5K · [Date]');
    expect(result.best.report.passed).toBe(true);
    expect(result.history[1]!.status).toBe('accepted');
    expect(result.history[1]!.copyEdits?.map((c) => c.status)).toEqual(['applied', 'applied']);
    expect(editor.requests[0]!.copyEdits).toBe(true);
  });

  it('refuses replacements the check rejects, and tells the editor why', async () => {
    const editor = createScriptedEditor([
      { summary: 's', edits: [replace('Run For Hope', '[Headline]', 'headline')] },
      { summary: 's', edits: [replace('City Park', '[Venue]')] },
    ]);
    const result = await runFixLoop(design, {
      editor,
      check: checkCopy,
      copy,
      target: 95,
      maxIterations: 2,
    });
    expect(result.history[1]!.status).toBe('rolled-back');
    expect(result.history[1]!.copyEdits?.[0]).toMatchObject({
      status: 'rejected',
      note: 'not a flagged fact',
    });
    expect(editor.requests[1]!.attempts.map((a) => a.message).join(' ')).toMatch(
      /text replacement\(s\) were refused/,
    );
    const headline = result.best.design.elements.find((e) => e.id === 'headline');
    expect(headline?.type === 'text' && headline.content).toBe('Run For Hope');
    const sub = result.best.design.elements.find((e) => e.id === 'sub');
    expect(sub?.type === 'text' && sub.content).toBe('Charity 5K · June 14 · [Venue]');
  });

  it("doesn't exist without the copy option (redline fix keeps copy untouchable)", async () => {
    expect(parseEditResponse({ summary: 's', edits: [replace('June 14', '[Date]')] }).ok).toBe(
      false,
    );
    const editor = createScriptedEditor([
      { summary: 's', edits: [replace('June 14', '[Date]')] },
      { summary: 's', edits: [replace('June 14', '[Date]')] },
    ]);
    const result = await runFixLoop(design, { editor, check: checkCopy, maxIterations: 1 });
    expect(result.history[1]!.status).toBe('invalid');
    expect(editor.requests[0]!.copyEdits).toBeUndefined();
  });

  it('is in the generation-mode tool schema and prompt only', () => {
    const ops = (generation: boolean) =>
      JSON.stringify(submitEditsTool({ generation }).input_schema).includes('replaceText');
    expect(ops(true)).toBe(true);
    expect(ops(false)).toBe(false);
    expect(buildSystemPrompt({ generation: true })).toContain('replaceText');
    expect(buildSystemPrompt()).not.toContain('replaceText');
  });
});
