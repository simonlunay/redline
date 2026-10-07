import { estimateCostUsd } from '@simonlunay/redline-agent';
import type { DesignEditor } from '@simonlunay/redline-agent';

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
    readonly estimateUsd: number,
    readonly what: string,
  ) {
    super(
      `Spend cap reached: ${what} (≈ $${estimateUsd.toFixed(3)}) would take the total from $${spentUsd.toFixed(3)} past the $${capUsd.toFixed(2)} cap.`,
    );
    this.name = 'BudgetExceededError';
  }
}

export interface SpendEntry {
  at: string;
  kind: 'llm' | 'image';
  what: string;
  model: string;
  costUsd: number;
  /** Free-form label, e.g. the eval run or prompt id. */
  tag?: string;
}

/**
 * Tracks money spent on paid APIs and refuses calls that could break the cap. Every paid call
 * goes through `guard` (before, with a worst-case estimate) and `record` (after, with the real
 * cost). The Node implementation persists entries to a JSON file so the cap holds across runs.
 */
export interface SpendLedger {
  readonly capUsd: number;
  spentUsd(): number;
  /** Throws BudgetExceededError if spending `estimateUsd` more could exceed the cap. */
  guard(estimateUsd: number, what: string): void;
  record(entry: Omit<SpendEntry, 'at'>): void;
  entries(): SpendEntry[];
}

export function createMemoryLedger(capUsd = Infinity, initial: SpendEntry[] = []): SpendLedger {
  const list = [...initial];
  const spent = () => list.reduce((s, e) => s + e.costUsd, 0);
  return {
    capUsd,
    spentUsd: spent,
    guard(estimateUsd, what) {
      if (spent() + estimateUsd > capUsd)
        throw new BudgetExceededError(spent(), capUsd, estimateUsd, what);
    },
    record(entry) {
      list.push({ at: new Date().toISOString(), ...entry });
    },
    entries: () => [...list],
  };
}

/**
 * Worst-case cost of one Claude call, used by the guard. Generous on purpose (a long design
 * JSON, two images, plenty of thinking), so the cap can't be crossed by one unexpected call.
 */
export function worstCaseLlmCallUsd(model: string): number {
  const estimate = estimateCostUsd(model, {
    inputTokens: 30_000,
    outputTokens: 16_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 10_000,
  });
  return estimate ?? 1;
}

/** Wraps a fix-loop editor so every call is guarded by and recorded in the ledger. */
export function budgetedEditor(
  editor: DesignEditor,
  ledger: SpendLedger,
  model: string,
  tag?: string,
): DesignEditor {
  return {
    name: editor.name,
    async proposeEdits(request) {
      ledger.guard(worstCaseLlmCallUsd(model), `fix-loop call (${model})`);
      const response = await editor.proposeEdits(request);
      const cost = response.usage ? estimateCostUsd(response.model ?? model, response.usage) : null;
      ledger.record({
        kind: 'llm',
        what: 'fix-loop',
        model: response.model ?? model,
        costUsd: cost ?? 0,
        tag,
      });
      return response;
    },
  };
}
