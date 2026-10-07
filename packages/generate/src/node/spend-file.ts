import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createMemoryLedger } from '../spend.js';
import type { SpendEntry, SpendLedger } from '../spend.js';

interface LedgerFile {
  capUsd: number;
  spentUsd: number;
  entries: SpendEntry[];
}

/**
 * A spend ledger persisted to a JSON file after every recorded call, so a cap holds across
 * processes (a night of CLI runs plus the eval). The cap stored in the file wins over a larger
 * one passed in, so a later run can't silently raise it.
 */
export function createFileLedger(path: string, capUsd: number): SpendLedger & { path: string } {
  let initial: SpendEntry[] = [];
  let cap = capUsd;
  if (existsSync(path)) {
    const file = JSON.parse(readFileSync(path, 'utf8')) as LedgerFile;
    initial = file.entries ?? [];
    cap = Math.min(capUsd, file.capUsd ?? capUsd);
  }
  const memory = createMemoryLedger(cap, initial);
  const save = () => {
    mkdirSync(dirname(path), { recursive: true });
    const data: LedgerFile = {
      capUsd: cap,
      spentUsd: Number(memory.spentUsd().toFixed(4)),
      entries: memory.entries(),
    };
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  };
  return {
    path,
    capUsd: cap,
    spentUsd: () => memory.spentUsd(),
    guard: (estimate, what) => memory.guard(estimate, what),
    record(entry) {
      memory.record(entry);
      save();
    },
    entries: () => memory.entries(),
  };
}
