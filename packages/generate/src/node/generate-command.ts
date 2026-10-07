import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { registerFont } from '@simonlunay/redline/node';
import type { SaliencyModel } from '@simonlunay/redline';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  createAnthropicEditor,
  createSuggestedFixesEditor,
} from '@simonlunay/redline-agent';
import type { DesignEditor, Effort } from '@simonlunay/redline-agent';
import { loadDotEnv } from '@simonlunay/redline-agent/node';
import { createAnthropicArtDirector } from '../director/anthropic.js';
import { createTemplateArtDirector } from '../director/template.js';
import type { ArtDirector } from '../director/types.js';
import { createPexelsProvider } from '../providers/pexels.js';
import { createReplicateFluxProvider } from '../providers/replicate.js';
import type { ImageProvider } from '../providers/types.js';
import { createMemoryLedger } from '../spend.js';
import type { BackgroundRemover } from '../cutout.js';
import { renderContactSheet } from './contact-sheet.js';
import { createAutoRemover, createBackdropKeyRemover, createBiRefNetRemover } from './cutout.js';
import {
  formatCandidate,
  formatGenerateHeader,
  formatGenerateSummary,
  formatImage,
  formatIterationLine,
  formatPlan,
  formatWinner,
} from './format.js';
import { createMockImageProvider } from './mock-provider.js';
import { generateDesign, serializeResult } from './pipeline.js';
import type { GenerateEvent, GenerationResult, UserImageInput } from './pipeline.js';
import { createFileLedger } from './spend-file.js';
import { createWorkspace } from './workspace.js';
import type { Workspace } from './workspace.js';

export const GENERATE_HELP = `
redline generate "<prompt>" [options]

Plans a design from a prompt, generates layered images, builds several candidates, scores
them with the checker (layout + attention), picks the best, then runs the fix loop on it.

Options
  --out <path>             Design JSON to write (default ./generated/<slug>.json); images go
                           to <name>.assets/, all candidates to <name>.candidates/
  --size <WxH>             Canvas size (default 1080x1350)
  --candidates <n>         Candidates to build and score (default 4)
  --layouts <n>            Distinct layouts among them (default min(2, candidates))
  --target <score>         Fix-loop target, reached with no errors (default 95)
  --max-iterations <n>     Fix-loop iterations (default 4)
  --max-regenerations <n>  Images the fix loop may regenerate with a revised brief when a
                           problem comes from the image itself (default 2; 0 = off)
  --render-steps <dir>     Contact sheet (all candidates + heatmaps), candidate renders and
                           one annotated PNG (+ heatmap) per fix-loop step
  --provider <name>        replicate (FLUX.1 schnell) | pexels (stock) | mock (offline).
                           Default: replicate if REPLICATE_API_TOKEN is set, else pexels if
                           PEXELS_API_KEY is set, else mock
  --cutout <name>          auto (BiRefNet, falls back to keying) | birefnet | key | none
  --director <name>        anthropic (default) | template (offline, deterministic)
  --editor <name>          anthropic (default) | suggested (offline)
  --model <id>             Claude model for art director and fix loop (default ${DEFAULT_MODEL})
  --effort <level>         low | medium | high | xhigh | max (default ${DEFAULT_EFFORT})
  --brand-colors <list>    Comma-separated hex colors, e.g. "#0b5fff,#ff8a00"
  --font <Family=path>     Register a font file the plan may use (repeatable)
  --logo <path>            Logo image to place (kept as supplied)
  --image <path>           Image the art director may use (repeatable)
  --budget <usd>           Spend cap for this run (default 2)
  --ledger <path>          Persistent spend ledger (JSON); its cap and history carry over
  --seed <n>               Base seed (default: derived from the prompt)
  --no-attention           Skip the attention rules (no saliency model)
  --no-vision              Don't send renders to the fix-loop model
  --format <pretty|json>   Output format (default pretty)

Needs ANTHROPIC_API_KEY (unless --director template --editor suggested) and an image key for
real images (REPLICATE_API_TOKEN or PEXELS_API_KEY), read from the environment or ./.env.
Exit codes: 0 = final design has no errors, 1 = errors remain, 2 = usage or setup error.
`;

export class GenerateUsageError extends Error {}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface GenerateCommandIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: Record<string, string | undefined>;
  /** .env file to load first (default ./.env); null to skip. */
  dotenvPath?: string | null;
  /** Tests inject these instead of real APIs. */
  director?: ArtDirector;
  provider?: ImageProvider;
  editor?: DesignEditor;
  remover?: BackgroundRemover;
  saliency?: SaliencyModel;
}

const defaultIO: GenerateCommandIO = {
  stdout: (t) => process.stdout.write(`${t}\n`),
  stderr: (t) => process.stderr.write(`${t}\n`),
};

function int(value: string | undefined, flag: string, fallback: number, min = 0): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min)
    throw new GenerateUsageError(`${flag} must be a whole number ≥ ${min}`);
  return n;
}

export function parseSize(value: string): { width: number; height: number } {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(value.trim());
  if (!match) throw new GenerateUsageError(`--size must look like 1080x1350, got "${value}"`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 64 || height < 64 || width > 8000 || height > 8000) {
    throw new GenerateUsageError('--size must be between 64 and 8000 px per side');
  }
  return { width, height };
}

export function slugify(prompt: string): string {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .split('-')
      .slice(0, 6)
      .join('-') || 'design'
  );
}

/** `redline generate`: returns the process exit code. */
export async function runGenerateCommand(
  argv: string[],
  io: GenerateCommandIO = defaultIO,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      size: { type: 'string' },
      candidates: { type: 'string' },
      layouts: { type: 'string' },
      target: { type: 'string' },
      'max-iterations': { type: 'string' },
      'max-regenerations': { type: 'string' },
      'render-steps': { type: 'string' },
      provider: { type: 'string' },
      cutout: { type: 'string' },
      director: { type: 'string' },
      editor: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      'brand-colors': { type: 'string' },
      font: { type: 'string', multiple: true },
      logo: { type: 'string' },
      image: { type: 'string', multiple: true },
      budget: { type: 'string' },
      ledger: { type: 'string' },
      seed: { type: 'string' },
      'no-attention': { type: 'boolean' },
      'no-vision': { type: 'boolean' },
      format: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    io.stdout(GENERATE_HELP);
    return 0;
  }
  const prompt = positionals.join(' ').trim();
  if (!prompt)
    throw new GenerateUsageError('Missing prompt: redline generate "poster for a charity 5K"');

  const format = values.format ?? 'pretty';
  if (format !== 'pretty' && format !== 'json')
    throw new GenerateUsageError(`Unknown --format "${format}"`);
  const canvas = parseSize(values.size ?? '1080x1350');
  const candidates = int(values.candidates, '--candidates', 4, 1);
  if (candidates > 12) throw new GenerateUsageError('--candidates is capped at 12');
  const layouts = values.layouts ? int(values.layouts, '--layouts', 2, 1) : undefined;
  const target = int(values.target, '--target', 95);
  const maxIterations = int(values['max-iterations'], '--max-iterations', 4);
  const maxRegenerations = int(values['max-regenerations'], '--max-regenerations', 2);
  const model = values.model ?? DEFAULT_MODEL;
  const effort = (values.effort ?? DEFAULT_EFFORT) as Effort;
  if (!EFFORTS.includes(effort))
    throw new GenerateUsageError(`--effort must be one of ${EFFORTS.join(', ')}`);
  const budget = values.budget === undefined ? 2 : Number(values.budget);
  if (!(budget >= 0)) throw new GenerateUsageError('--budget must be a number of dollars ≥ 0');
  const brandColors = values['brand-colors']
    ?.split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  for (const c of brandColors ?? []) {
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(c))
      throw new GenerateUsageError(`--brand-colors: "${c}" is not a hex color`);
  }
  const seed = values.seed === undefined ? undefined : int(values.seed, '--seed', 0);

  if (io.dotenvPath !== null) loadDotEnv(io.dotenvPath);
  const env = io.env ?? process.env;
  const ledger = values.ledger
    ? createFileLedger(resolve(values.ledger), budget)
    : createMemoryLedger(budget);

  // Fonts
  const fonts: string[] = [];
  for (const spec of values.font ?? []) {
    const [family, path] = spec.includes('=')
      ? (spec.split('=', 2) as [string, string])
      : [undefined, spec];
    if (!family || !path)
      throw new GenerateUsageError(`--font must look like "Family Name=path/to/font.ttf"`);
    registerFont(resolve(path), family);
    fonts.push(family);
  }

  // Director
  const directorName = values.director ?? 'anthropic';
  let director = io.director;
  if (!director) {
    if (directorName === 'template') director = createTemplateArtDirector();
    else if (directorName === 'anthropic') {
      if (!env.ANTHROPIC_API_KEY) {
        throw new GenerateUsageError(
          'ANTHROPIC_API_KEY is not set. Add it to .env, or run offline with --director template --editor suggested.',
        );
      }
      director = createAnthropicArtDirector({ model, effort, ledger });
    } else throw new GenerateUsageError(`Unknown --director "${directorName}"`);
  }

  // Images
  let provider = io.provider;
  const providerName =
    values.provider ??
    (env.REPLICATE_API_TOKEN ? 'replicate' : env.PEXELS_API_KEY ? 'pexels' : 'mock');
  if (!provider) {
    if (providerName === 'replicate') {
      if (!env.REPLICATE_API_TOKEN) throw new GenerateUsageError('REPLICATE_API_TOKEN is not set.');
      provider = createReplicateFluxProvider({ token: env.REPLICATE_API_TOKEN });
    } else if (providerName === 'pexels') {
      if (!env.PEXELS_API_KEY) throw new GenerateUsageError('PEXELS_API_KEY is not set.');
      provider = createPexelsProvider({ apiKey: env.PEXELS_API_KEY });
    } else if (providerName === 'mock') provider = createMockImageProvider();
    else throw new GenerateUsageError(`Unknown --provider "${providerName}"`);
  }

  const cutoutName = values.cutout ?? 'auto';
  const warnings: string[] = [];
  let remover = io.remover;
  if (!remover) {
    if (cutoutName === 'auto') {
      remover = createAutoRemover({
        onProgress: (m) => io.stderr(m),
        onFallback: (reason) =>
          warnings.push(`Backdrop keying used for a cutout instead of BiRefNet: ${reason}`),
      });
    } else if (cutoutName === 'birefnet')
      remover = createBiRefNetRemover({ onProgress: (m) => io.stderr(m) });
    else if (cutoutName === 'key') remover = createBackdropKeyRemover();
    else if (cutoutName !== 'none')
      throw new GenerateUsageError(`Unknown --cutout "${cutoutName}"`);
  }

  // Fix-loop editor
  const editorName = values.editor ?? 'anthropic';
  let editor = io.editor;
  let editorModel: string | undefined;
  if (!editor) {
    if (editorName === 'suggested') editor = createSuggestedFixesEditor();
    else if (editorName === 'anthropic') {
      if (!env.ANTHROPIC_API_KEY)
        throw new GenerateUsageError(
          'ANTHROPIC_API_KEY is not set (needed by --editor anthropic).',
        );
      editor = createAnthropicEditor({ model, effort, generation: true });
      editorModel = model;
    } else throw new GenerateUsageError(`Unknown --editor "${editorName}"`);
  }

  const userImages: UserImageInput[] = [];
  if (values.logo) userImages.push({ id: 'logo', path: resolve(values.logo), use: 'logo' });
  (values.image ?? []).forEach((path, i) =>
    userImages.push({ id: `image${i + 1}`, path: resolve(path), use: 'image' }),
  );

  const out = resolve(values.out ?? join('generated', `${slugify(prompt)}.json`));
  const attention = !values['no-attention'];
  const workspace = await createWorkspace(resolve(out, '..'), {
    attention,
    ...(io.saliency ? { saliency: io.saliency } : {}),
  });

  const pretty = format === 'pretty';
  if (pretty) {
    io.stdout(
      formatGenerateHeader(
        prompt,
        `${canvas.width}x${canvas.height} · ${candidates} candidates · target ${target} · director ${director.name} · images ${provider.id}${remover ? ` + cutout ${remover.id}` : ''} · editor ${editor.name}${attention ? ' · attention on' : ''} · budget $${ledger.capUsd.toFixed(2)}`,
      ),
    );
  }
  const onEvent = pretty
    ? (event: GenerateEvent) => {
        switch (event.type) {
          case 'plan':
            io.stdout(formatPlan(event.plan, event.director, director!.name));
            io.stdout(`\n  ${'Images'}`);
            break;
          case 'image':
            io.stdout(formatImage(event.entry));
            break;
          case 'candidate':
            if (event.candidate.index === 0) io.stdout(`\n  Candidates`);
            io.stdout(formatCandidate(event.candidate));
            break;
          case 'winner':
            io.stdout(formatWinner(event.candidate, event.ranking.length));
            break;
          case 'iteration':
            io.stdout(formatIterationLine(event.record));
            break;
          case 'warning':
            io.stderr(`  ! ${event.message}`);
            break;
        }
      }
    : undefined;

  const result = await generateDesign({
    prompt,
    canvas,
    out,
    director,
    provider,
    ...(remover ? { remover } : {}),
    editor,
    ...(editorModel ? { editorModel } : {}),
    candidates,
    ...(layouts ? { layouts } : {}),
    target,
    maxIterations,
    maxRegenerations,
    attention,
    vision: !values['no-vision'],
    ...(brandColors?.length ? { brandColors } : {}),
    fonts,
    userImages,
    ledger,
    ...(seed !== undefined ? { seed } : {}),
    workspace,
    ...(onEvent ? { onEvent } : {}),
  });
  result.warnings.push(...warnings);

  if (values['render-steps'])
    await renderGenerationSteps(result, values['render-steps'], workspace, prompt);

  if (pretty) {
    io.stdout(formatGenerateSummary(result, editorModel));
    if (values['render-steps'])
      io.stdout(`    steps → ${values['render-steps']} (start with contact-sheet.png)\n`);
  } else {
    io.stdout(JSON.stringify(serializeResult(result), null, 2));
  }
  return result.final.report.passed ? 0 : 1;
}

/** Contact sheet + one PNG per candidate + per fix-loop step, like `redline fix --render-steps`. */
export async function renderGenerationSteps(
  result: GenerationResult,
  dir: string,
  workspace: Workspace,
  prompt: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const winner = result.candidates[result.winner]!;
  const sheet = await renderContactSheet(
    workspace,
    [
      ...result.candidates.map((c) => ({
        title: `Candidate ${c.index + 1}${c.index === result.winner ? ' (winner)' : ''}`,
        subtitle: `layout ${c.layout + 1} · background ${c.variant + 1} · ${c.layoutName}`,
        design: c.design,
        report: c.report,
        ...(c.index === result.winner ? { highlight: 'winner' as const } : {}),
      })),
      {
        title: 'Final',
        subtitle: `after the fix loop · ${result.loop.totals.iterations} iteration(s) from #${winner.index + 1}`,
        design: result.final.design,
        report: result.final.report,
        highlight: 'final' as const,
      },
    ],
    {
      title: `"${prompt}"  ·  best of ${result.candidates.length}: ${winner.score} → final ${result.final.report.score}`,
      footer: `${result.director.name} · ${result.canvas.width}x${result.canvas.height} · ≈ $${result.spend.totalUsd.toFixed(3)} · heatmaps: predicted attention (MSI-Net)`,
    },
  );
  await writeFile(join(dir, 'contact-sheet.png'), sheet);
  for (const c of result.candidates) {
    const name = `candidate-${c.index + 1}`;
    await writeFile(join(dir, `${name}.png`), await workspace.renderAnnotated(c.design, c.report));
    if (workspace.renderHeatmap)
      await writeFile(join(dir, `${name}.heatmap.png`), await workspace.renderHeatmap(c.design));
  }
  for (const step of result.loop.history) {
    const name = `fix-${String(step.iteration).padStart(2, '0')}-${step.status}`;
    await writeFile(
      join(dir, `${name}.png`),
      await workspace.renderAnnotated(step.design, step.report),
    );
    if (workspace.renderHeatmap)
      await writeFile(join(dir, `${name}.heatmap.png`), await workspace.renderHeatmap(step.design));
  }
  await writeFile(
    join(dir, 'final.png'),
    await workspace.renderAnnotated(result.final.design, result.final.report),
  );
  if (workspace.renderHeatmap)
    await writeFile(
      join(dir, 'final.heatmap.png'),
      await workspace.renderHeatmap(result.final.design),
    );
}
