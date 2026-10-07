import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderAnnotatedPng } from '@simonlunay/redline/node';
import { loadConfig } from '@simonlunay/redline/node';
import { DEFAULT_EFFORT, DEFAULT_MODEL, createAnthropicEditor } from '../editors/anthropic.js';
import type { Effort } from '../editors/anthropic.js';
import { createSuggestedFixesEditor } from '../editors/suggested.js';
import { runFixLoop } from '../loop.js';
import { estimateCostUsd } from '../pricing.js';
import type { SaliencyModel } from '@simonlunay/redline';
import type { DesignEditor, LoopResult } from '../types.js';
import { formatHeader, formatIteration, formatSummary } from './format.js';
import { createFixSession, loadDotEnv } from './session.js';

export const FIX_HELP = `
redline fix <design.json> [options]

Checks the design, lets an AI editor repair it, re-checks, and repeats until it is good.

Options
  --out <path>             Where to write the best design (default: <name>.fixed.json)
  --target <score>         Stop when the score reaches this with no errors (default 90)
  --max-iterations <n>     Max repair iterations (default 4)
  --editor <name>          anthropic (default) or suggested (applies the checker's own
                           fixes; offline, deterministic, no API key needed)
  --model <id>             Claude model (default ${DEFAULT_MODEL})
  --effort <level>         low | medium | high | xhigh | max (default ${DEFAULT_EFFORT})
  --attention              Also run the attention rules (saliency model; needs onnxruntime-node)
  --no-vision              Don't send the annotated render (and heatmap) to the model
  --render-steps <dir>     Write an annotated PNG (and a heatmap with --attention) per iteration
  --config <path>          Checker config (same as redline check)
  --format <pretty|json>   Output format (default pretty)

Needs ANTHROPIC_API_KEY for --editor anthropic (read from the environment or ./.env).
Exit codes: 0 = final design has no errors, 1 = errors remain, 2 = usage or setup error.
`;

export class UsageError extends Error {}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function positiveInt(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${flag} must be a whole number`);
  return n;
}

export interface FixCommandIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Tests inject an editor instead of calling an API. */
  editor?: DesignEditor;
  /** Environment to read ANTHROPIC_API_KEY from (default process.env). */
  env?: Record<string, string | undefined>;
  /** .env file to load first (default ./.env); null to skip. */
  dotenvPath?: string | null;
  /** Tests inject a fake saliency model instead of loading MSI-Net. */
  saliency?: SaliencyModel;
}

const defaultIO: FixCommandIO = {
  stdout: (t) => process.stdout.write(`${t}\n`),
  stderr: (t) => process.stderr.write(`${t}\n`),
};

/** `redline fix`: returns the process exit code. */
export async function runFixCommand(argv: string[], io: FixCommandIO = defaultIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      target: { type: 'string' },
      'max-iterations': { type: 'string' },
      editor: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      'no-vision': { type: 'boolean' },
      attention: { type: 'boolean' },
      'render-steps': { type: 'string' },
      config: { type: 'string' },
      format: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    io.stdout(FIX_HELP);
    return 0;
  }
  const [file, ...rest] = positionals;
  if (!file) throw new UsageError('Missing design file: redline fix <design.json>');
  if (rest.length > 0) throw new UsageError(`Unexpected arguments: ${rest.join(' ')}`);

  const format = values.format ?? 'pretty';
  if (format !== 'pretty' && format !== 'json')
    throw new UsageError(`Unknown --format "${format}"`);
  const effort = (values.effort ?? DEFAULT_EFFORT) as Effort;
  if (!EFFORTS.includes(effort))
    throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}`);
  const editorName = values.editor ?? 'anthropic';
  if (editorName !== 'anthropic' && editorName !== 'suggested') {
    throw new UsageError(`Unknown --editor "${editorName}". Use anthropic or suggested.`);
  }
  const target = positiveInt(values.target, '--target', 90);
  const maxIterations = positiveInt(values['max-iterations'], '--max-iterations', 4);
  const model = values.model ?? DEFAULT_MODEL;

  let editor = io.editor;
  if (!editor) {
    if (editorName === 'suggested') {
      editor = createSuggestedFixesEditor();
    } else {
      if (io.dotenvPath !== null) loadDotEnv(io.dotenvPath);
      if (!(io.env ?? process.env).ANTHROPIC_API_KEY) {
        throw new UsageError(
          'ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example), or run offline with --editor suggested.',
        );
      }
      editor = createAnthropicEditor({ model, effort });
    }
  }
  const usesLlm = editor.name.startsWith('anthropic');

  const config = values.config ? await loadConfig(values.config) : undefined;
  const session = await createFixSession(file, {
    config,
    attention: Boolean(values.attention),
    saliency: io.saliency,
  });
  const pretty = format === 'pretty';
  if (pretty) {
    const who = usesLlm ? `${model} (${effort})` : editor.name;
    const extra = session.attention ? ' · attention on' : '';
    io.stdout(formatHeader(file, `target ${target} · max ${maxIterations} · ${who}${extra}`));
  }

  const result = await runFixLoop(session.loaded.design, {
    editor,
    check: session.check,
    target,
    maxIterations,
    // Real LLMs and injected test editors get images; the offline rules editor doesn't need them.
    renderImages: (usesLlm || io.editor) && !values['no-vision'] ? session.renderImages : undefined,
    onIteration: pretty ? (r) => io.stdout(formatIteration(r)) : undefined,
  });

  const out = resolve(values.out ?? defaultOutPath(file));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(result.best.design, null, 2)}\n`);
  if (values['render-steps']) await renderSteps(result, values['render-steps'], session);

  const usedModel = usesLlm ? model : undefined;
  if (pretty) {
    io.stdout(formatSummary(result, usedModel, values.out ?? defaultOutPath(file)));
    if (values['render-steps']) io.stdout(`    steps → ${values['render-steps']}\n`);
  } else {
    io.stdout(
      JSON.stringify(
        {
          file,
          out,
          editor: editor.name,
          settings: {
            target,
            maxIterations,
            model: usedModel,
            effort: usesLlm ? effort : undefined,
          },
          estimatedCostUsd: estimateCostUsd(usedModel, result.totals.usage),
          ...result,
        },
        null,
        2,
      ),
    );
  }
  return result.best.report.passed ? 0 : 1;
}

function defaultOutPath(file: string): string {
  return join(dirname(file), `${basename(file, extname(file))}.fixed.json`);
}

/** One annotated PNG per iteration (including rolled-back candidates) plus the final result. */
async function renderSteps(
  result: LoopResult,
  dir: string,
  session: Awaited<ReturnType<typeof createFixSession>>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const images = { images: session.env.images };
  for (const step of result.history) {
    const name = `${String(step.iteration).padStart(2, '0')}-${step.status}`;
    await writeFile(join(dir, `${name}.png`), renderAnnotatedPng(step.design, step.report, images));
    if (session.renderHeatmap) {
      await writeFile(join(dir, `${name}.heatmap.png`), await session.renderHeatmap(step.design));
    }
  }
  await writeFile(
    join(dir, 'final.png'),
    renderAnnotatedPng(result.best.design, result.best.report, images),
  );
  if (session.renderHeatmap) {
    await writeFile(
      join(dir, 'final.heatmap.png'),
      await session.renderHeatmap(result.best.design),
    );
  }
}
