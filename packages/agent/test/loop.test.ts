import { check, parseDesign } from '@simonlunay/redline';
import type { Design, DesignInput } from '@simonlunay/redline';
import { describe, expect, it } from 'vitest';
import { protectedFieldViolations } from '../src/edits.js';
import { createScriptedEditor } from '../src/editors/scripted.js';
import { createSuggestedFixesEditor, suggestedEdits } from '../src/editors/suggested.js';
import { runFixLoop } from '../src/loop.js';
import type { DesignEditor } from '../src/types.js';

/** A small design with two clear, fixable problems: a stretched image and tiny text. */
const messy: DesignInput = {
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
      fontWeight: 800,
      color: '#111111',
    },
    {
      id: 'photo',
      type: 'image',
      role: 'product',
      src: 'p.png',
      naturalWidth: 800,
      naturalHeight: 600,
      x: 100,
      y: 300,
      width: 400,
      height: 400,
    },
    {
      id: 'legal',
      type: 'text',
      content: 'Terms apply',
      x: 100,
      y: 900,
      width: 400,
      height: 30,
      fontSize: 12,
      color: '#333333',
    },
  ],
};

const syncCheck = async (design: Design) => check(design);
const fixPhoto = { op: 'resize', elementId: 'photo', width: 400, height: 300, reason: 'unstretch' };
const fixLegal = { op: 'setFontSize', elementId: 'legal', fontSize: 22, reason: 'readable' };
const breakTitle = { op: 'move', elementId: 'title', dx: 900, dy: 0, reason: 'oops' };

describe('runFixLoop', () => {
  it('improves the design and stops once the target is reached with no errors', async () => {
    const editor = createScriptedEditor([
      { summary: 'fix photo', edits: [fixPhoto] },
      { summary: 'fix legal', edits: [fixLegal] },
    ]);
    const result = await runFixLoop(messy, { editor, check: syncCheck });
    expect(result.stopReason).toMatch(/target-reached|no-issues/);
    expect(result.history.map((h) => h.status)).toEqual(['initial', 'accepted', 'accepted']);
    expect(result.best.report.score).toBeGreaterThan(result.initial.report.score);
    expect(result.best.report.summary.errors).toBe(0);
    expect(result.best.iteration).toBe(2);
  });

  it('rolls back an attempt that lowers the score and tells the editor why', async () => {
    const editor = createScriptedEditor([
      { summary: 'bad idea', edits: [breakTitle] },
      { summary: 'fix photo', edits: [fixPhoto] },
      { summary: 'fix legal', edits: [fixLegal] },
    ]);
    const result = await runFixLoop(messy, { editor, check: syncCheck });
    const [, rolledBack, accepted] = result.history;
    expect(rolledBack).toMatchObject({ status: 'rolled-back', iteration: 1 });
    expect(rolledBack!.scoreAfter).toBeLessThan(rolledBack!.scoreBefore);
    // The next iteration starts from the pre-rollback design...
    expect(accepted!.scoreBefore).toBe(result.initial.report.score);
    expect(editor.requests[1]!.design).toEqual(result.initial.design);
    // ...and the editor is told what went wrong.
    expect(editor.requests[1]!.attempts[0]).toMatchObject({
      iteration: 1,
      outcome: 'rolled-back',
      message: expect.stringMatching(/Score dropped from \d+ to \d+.*off-canvas/),
    });
  });

  it('retries once on invalid output, then records the iteration as invalid', async () => {
    const editor = createScriptedEditor([
      { nonsense: true },
      { summary: 'fixed format', edits: [fixPhoto] },
      { edits: 'still wrong' },
      { edits: 'still wrong' },
    ]);
    const result = await runFixLoop(messy, { editor, check: syncCheck, maxIterations: 2 });
    expect(editor.requests[1]!.validationError).toMatch(/did not match the submit_edits schema/);
    expect(result.history[1]).toMatchObject({ status: 'accepted', calls: 2 });
    expect(result.history[2]).toMatchObject({ status: 'invalid', calls: 2 });
    expect(result.totals.calls).toBe(4);
  });

  it('stops after two iterations in a row without improvement', async () => {
    const editor = createScriptedEditor([
      { summary: 'nothing', edits: [] },
      { summary: 'still nothing', edits: [] },
      { summary: 'never asked', edits: [fixPhoto] },
    ]);
    const result = await runFixLoop(messy, { editor, check: syncCheck, maxIterations: 4 });
    expect(result.stopReason).toBe('no-improvement');
    expect(editor.requests).toHaveLength(2);
  });

  it('stops at max iterations', async () => {
    const editor = createScriptedEditor([
      { summary: 'fix photo', edits: [fixPhoto] },
      { summary: 'fix legal', edits: [fixLegal] },
    ]);
    const result = await runFixLoop(messy, { editor, check: syncCheck, maxIterations: 1 });
    expect(result.stopReason).toBe('max-iterations');
    expect(result.totals.iterations).toBe(1);
  });

  it('does not call the editor when the design is already good', async () => {
    const editor = createScriptedEditor([]);
    const clean = parseDesign({ ...messy, elements: [messy.elements[0]!] });
    const result = await runFixLoop(clean, { editor, check: syncCheck });
    expect(result.stopReason).toMatch(/target-reached|no-issues/);
    expect(editor.requests).toHaveLength(0);
  });

  it('requires both the score target AND zero errors', async () => {
    // Target 0 is trivially met by the score, but errors remain, so the loop keeps going.
    const editor = createScriptedEditor([{ summary: 'fix', edits: [fixPhoto, fixLegal] }]);
    const result = await runFixLoop(messy, { editor, check: syncCheck, target: 0 });
    expect(editor.requests).toHaveLength(1);
    expect(result.stopReason).toMatch(/target-reached|no-issues/);
  });

  it('rolls back when no edit can be applied and reports the rejected edits', async () => {
    const editor = createScriptedEditor([
      { summary: 'ghost', edits: [{ ...fixPhoto, elementId: 'ghost' }] },
    ]);
    const result = await runFixLoop(messy, { editor, check: syncCheck, maxIterations: 1 });
    expect(result.history[1]).toMatchObject({ status: 'rolled-back', note: /None of the edits/ });
    expect(result.history[1]!.rejected[0]!.reason).toBe('No element with id "ghost"');
  });

  it('stops with editor-error when the editor throws, keeping what it had', async () => {
    const editor: DesignEditor = {
      name: 'broken',
      proposeEdits: async () => {
        throw new Error('network down');
      },
    };
    const result = await runFixLoop(messy, { editor, check: syncCheck });
    expect(result).toMatchObject({ stopReason: 'editor-error', error: 'network down' });
    expect(result.best.design).toEqual(result.initial.design);
  });

  it('history is replayable: every snapshot re-checks to its recorded score', async () => {
    const editor = createScriptedEditor([
      { summary: 'bad', edits: [breakTitle] },
      { summary: 'fix', edits: [fixPhoto, fixLegal] },
    ]);
    const result = await runFixLoop(messy, { editor, check: syncCheck });
    for (const step of result.history) {
      expect(check(step.design).score).toBe(step.scoreAfter);
    }
    expect(JSON.parse(JSON.stringify(result))).toEqual(result); // plain JSON, safe to save
  });
});

describe('suggested-fixes editor (mock LLM and rules baseline)', () => {
  it('is deterministic and fixes the messy design', async () => {
    const run = () => runFixLoop(messy, { editor: createSuggestedFixesEditor(), check: syncCheck });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.best.report.score).toBe(b.best.report.score);
    expect(a.best.report.summary.errors).toBe(0);
  });

  it('takes one issue per element so moves do not add up', () => {
    const report = check(parseDesign(messy));
    const targets = suggestedEdits(report).map((e) => ('elementId' in e ? e.elementId : ''));
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe('guardrails', () => {
  it('flags changes to protected fields and non-decoration insertions', () => {
    const original = parseDesign(messy);
    const tampered = structuredClone(original);
    const title = tampered.elements[0]!;
    if (title.type === 'text') title.content = 'Changed';
    tampered.elements.push({ ...structuredClone(original.elements[1]!), id: 'clone' });
    expect(protectedFieldViolations(original, tampered)).toEqual([
      '"title".content changed',
      'new element "clone" is not a decoration shape',
    ]);
    expect(protectedFieldViolations(original, original)).toEqual([]);
  });
});
