import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDesign } from '@simonlunay/redline';
import { createScriptedEditor, runFixLoop } from '@simonlunay/redline-agent';
import type { DesignEditor } from '@simonlunay/redline-agent';
import { describe, expect, it } from 'vitest';
import { createFileLedger } from '../src/node/spend-file.js';
import { BudgetExceededError, budgetedEditor, createMemoryLedger, worstCaseLlmCallUsd } from '../src/spend.js';
import { tempDir } from './helpers.js';

describe('spend ledger', () => {
  it('guards against crossing the cap and sums what was recorded', () => {
    const ledger = createMemoryLedger(1);
    ledger.record({ kind: 'image', what: 'bg', model: 'flux', costUsd: 0.6 });
    expect(ledger.spentUsd()).toBeCloseTo(0.6);
    expect(() => ledger.guard(0.3, 'ok')).not.toThrow();
    expect(() => ledger.guard(0.5, 'too much')).toThrow(BudgetExceededError);
    expect(() => ledger.guard(0.5, 'too much')).toThrow(/would take the total from \$0\.600 past the \$1\.00 cap/);
  });

  it('persists to a file, and a stored cap is never raised by a later run', () => {
    const path = join(tempDir(), 'spend.json');
    const first = createFileLedger(path, 15);
    first.record({ kind: 'llm', what: 'art-director', model: 'claude-sonnet-5-5', costUsd: 0.04 });
    const second = createFileLedger(path, 100);
    expect(second.capUsd).toBe(15);
    expect(second.spentUsd()).toBeCloseTo(0.04);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ capUsd: 15, spentUsd: 0.04 });
    expect(createFileLedger(path, 5).capUsd).toBe(5);
  });

  it('prices a worst-case Claude call generously', () => {
    expect(worstCaseLlmCallUsd('claude-sonnet-5-5')).toBeGreaterThan(0.2);
    expect(worstCaseLlmCallUsd('claude-opus-5-5')).toBeGreaterThan(worstCaseLlmCallUsd('claude-sonnet-5-5'));
    expect(worstCaseLlmCallUsd('unknown-model')).toBe(1);
  });

  it('wraps a fix-loop editor: records each call, and stops the loop at the cap', async () => {
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const inner: DesignEditor = {
      name: 'fake',
      async proposeEdits() {
        return { raw: { summary: 'nothing', edits: [] }, usage, model: 'claude-sonnet-5-5' };
      },
    };
    const ledger = createMemoryLedger(0.3);
    const editor = budgetedEditor(inner, ledger, 'claude-sonnet-5-5');
    await editor.proposeEdits({} as never);
    expect(ledger.entries()).toMatchObject([{ kind: 'llm', what: 'fix-loop', costUsd: 0.007 }]);

    const broke = budgetedEditor(createScriptedEditor([]), createMemoryLedger(0.01), 'claude-sonnet-5-5');
    const design = parseDesign({
      version: '0.1',
      canvas: { width: 100, height: 100, background: '#ffffff' },
      elements: [{ id: 't', type: 'text', role: 'headline', x: 0, y: 0, width: 10, height: 10, content: 'x', fontSize: 1, color: '#ffffff' }],
    });
    const result = await runFixLoop(design, {
      editor: broke,
      check: async () => ({ score: 50, passed: false, summary: { errors: 1, warnings: 0, infos: 0 }, rules: [], issues: [{ ruleId: 'r', severity: 'error', elementIds: ['t'], message: 'm', measured: 1, threshold: 2 }] }),
    });
    expect(result.stopReason).toBe('editor-error');
    expect(result.error).toMatch(/Spend cap reached/);
  });
});
