/**
 * Recounts the judge's verdict on the shipped design in the saved generate eval results, from the
 * `.generation.json` records each run wrote (no API calls). Adds `judgeShippedRound` and
 * `judgeShipped` to every judged row and sets `summary.judge.finalShip` to the count of shipped
 * designs the judge said ship.
 *
 *   npm run eval:recount-shipped -w packages/generate            # report only
 *   npm run eval:recount-shipped -w packages/generate -- --write # update the result files
 *
 * For records that set `finalJudgeRound`, the design that round reviewed (recovered from the loop
 * history) must be the design that shipped: that checks the reconstruction used for records written
 * before `finalJudgeRound` was always set.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenerationResult, shippedJudgment } from '../src/node/pipeline.js';
import { designFingerprint } from '../src/judge/rule.js';
import { reviewedDesign } from '../src/node/pipeline.js';
import { countShipped, shippedStats } from './shipped.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RESULTS = fileURLToPath(new URL('./results/', import.meta.url));
const write = process.argv.includes('--write');

interface Row {
  id: string;
  ok: boolean;
  judgeVerdicts?: string[];
  judgeShippedRound?: number;
  judgeShipped?: string;
  [key: string]: unknown;
}
interface ResultFile {
  outputs: string;
  summary: { judge?: { finalShip: number; [key: string]: unknown }; [key: string]: unknown };
  prompts: Row[];
  [key: string]: unknown;
}
type Record = Parameters<typeof shippedJudgment>[0] & Pick<GenerationResult, 'judgments'>;

let mismatches = 0;
for (const name of readdirSync(RESULTS).filter((f) => /_generate_.*\.json$/.test(f))) {
  const file = join(RESULTS, name);
  const result = JSON.parse(readFileSync(file, 'utf8')) as ResultFile;
  const judged = result.prompts.filter((r) => r.ok && r.judgeVerdicts?.length);
  if (!result.summary.judge || judged.length === 0) continue;

  const prompts = result.prompts.map((row) => {
    if (!judged.includes(row)) return row;
    const recordFile = join(
      ROOT,
      result.outputs.replaceAll('\\', '/'),
      row.id,
      `${row.id}.generation.json`,
    );
    if (!existsSync(recordFile))
      throw new Error(`${name}: no record for ${row.id} (${recordFile})`);
    const record = JSON.parse(readFileSync(recordFile, 'utf8')) as Record;
    if (typeof record.finalJudgeRound === 'number') {
      const seen = reviewedDesign(record.loop, record.finalJudgeRound);
      if (!seen || designFingerprint(seen) !== designFingerprint(record.final.design)) {
        mismatches++;
        console.error(
          `  ${name} ${row.id}: round ${record.finalJudgeRound}'s design isn't the one that shipped`,
        );
      }
    }
    const { judgeShippedRound: _r, judgeShipped: _v, ...rest } = row;
    return { ...rest, ...shippedStats(record) };
  });

  const before = result.summary.judge.finalShip;
  const after = countShipped(prompts);
  const lastShip = judged.filter((r) => r.judgeVerdicts!.at(-1) === 'ship').length;
  const notes = prompts
    .filter((r) => judged.some((j) => j.id === r.id))
    .filter((r) => r.judgeShippedRound !== (r.judgeVerdicts as string[]).length - 1)
    .map(
      (r) =>
        `${r.id} ${(r.judgeVerdicts as string[]).join(' → ')}: shipped ${r.judgeShipped ?? 'unreviewed'}${r.judgeShippedRound !== undefined ? ` (round ${r.judgeShippedRound})` : ''}`,
    );
  console.log(
    `${name}: finalShip ${before} → ${after} of ${judged.length} (last verdict ship: ${lastShip})`,
  );
  for (const n of notes) console.log(`    ${n}`);

  if (write) {
    const updated = {
      ...result,
      summary: { ...result.summary, judge: { ...result.summary.judge, finalShip: after } },
      prompts,
    };
    writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`);
  }
}
if (mismatches) {
  console.error(`${mismatches} records disagree with their loop history`);
  process.exitCode = 1;
}
