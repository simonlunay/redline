import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createFontMeasurer } from '@simonlunay/redline/node';
import type { Design, Report } from '@simonlunay/redline';
import { runFixLoop } from '@simonlunay/redline-agent';
import type {
  DesignEditor,
  IterationRecord,
  LoopResult,
  RegenerateOptions,
} from '@simonlunay/redline-agent';
import { assembleDesign } from '../assemble.js';
import type { SlotImage } from '../assemble.js';
import type { BackgroundRemover } from '../cutout.js';
import { BUNDLED_FONTS } from '../director/types.js';
import type { ArtDirector, DirectorResult, UserImageInfo } from '../director/types.js';
import { checkFactReplacement, createCopyGroundedRule } from '../grounding.js';
import { buildImagePrompt } from '../image-prompt.js';
import type { DesignPlan, ImageSlot } from '../plan.js';
import type { GeneratedImage, ImageProvider, ImageRequest } from '../providers/types.js';
import { candidateVariant, ctaShare, rankCandidates, roleShares, seedFrom } from '../select.js';
import { BudgetExceededError, budgetedEditor, createMemoryLedger } from '../spend.js';
import type { SpendLedger } from '../spend.js';
import { AssetStore } from './assets.js';
import type { ManifestEntry } from './assets.js';
import { createMockImageProvider } from './mock-provider.js';
import { createWorkspace } from './workspace.js';
import type { Workspace } from './workspace.js';

export interface UserImageInput {
  id: string;
  path: string;
  use: 'logo' | 'image';
  description?: string;
}

export interface GenerateOptions {
  prompt: string;
  canvas: { width: number; height: number };
  /** Where the winning design is written; assets go to <name>.assets/ next to it. */
  out: string;
  director: ArtDirector;
  provider: ImageProvider;
  /** Removes subject backgrounds. Without one, subjects keep their plain backdrop. */
  remover?: BackgroundRemover;
  editor: DesignEditor;
  /** Model id behind the editor, for cost accounting (undefined for offline editors). */
  editorModel?: string;
  /** Number of candidates (default 4). */
  candidates?: number;
  /** Number of distinct layouts among the candidates (default min(2, candidates)). */
  layouts?: number;
  target?: number;
  maxIterations?: number;
  /**
   * Fix-loop image regenerations allowed (generation mode, default 2; 0 = layout edits only).
   * The editor must be created in generation mode to propose them.
   */
  maxRegenerations?: number;
  attention?: boolean;
  vision?: boolean;
  brandColors?: string[];
  /** Extra registered font families the plan may use (Inter is always available). */
  fonts?: string[];
  userImages?: UserImageInput[];
  ledger?: SpendLedger;
  /** Base seed; defaults to a hash of the prompt so runs are reproducible. */
  seed?: number;
  /** Injected in tests to skip loading the saliency model. */
  workspace?: Workspace;
  onEvent?: (event: GenerateEvent) => void;
}

export type GenerateEvent =
  | { type: 'plan'; plan: DesignPlan; director: DirectorResult }
  | { type: 'image'; entry: ManifestEntry }
  | { type: 'candidate'; candidate: CandidateResult }
  | { type: 'winner'; candidate: CandidateResult; ranking: number[] }
  | { type: 'iteration'; record: IterationRecord }
  | { type: 'warning'; message: string };

export interface CandidateResult {
  index: number;
  layout: number;
  layoutName: string;
  variant: number;
  design: Design;
  report: Report;
  score: number;
  errors: number;
  warnings: number;
  ctaShare?: number;
  headlineShare?: number;
  /** Relative path of the candidate's own JSON file. */
  file: string;
}

export interface GenerationResult {
  prompt: string;
  canvas: { width: number; height: number };
  plan: DesignPlan;
  director: {
    name: string;
    model?: string;
    calls: number;
    costUsd?: number;
    retriedAfter?: string;
  };
  candidates: CandidateResult[];
  ranking: number[];
  winner: number;
  loop: LoopResult;
  final: { design: Design; report: Report };
  out: string;
  generationFile: string;
  manifestFile: string;
  assetsDir: string;
  spend: {
    totalUsd: number;
    llmUsd: number;
    imageUsd: number;
    capUsd: number;
    ledgerTotalUsd: number;
  };
  warnings: string[];
  durationMs: number;
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Serializes CPU-heavy work (ONNX cutouts) so parallel candidates don't fight for cores. */
function mutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** A PNG preview (longest side 512) so the art director can see supplied images. */
async function preview(path: string): Promise<{ png: Uint8Array; width: number; height: number }> {
  const image = await loadImage(path);
  const scale = Math.min(1, 512 / Math.max(image.width, image.height));
  const canvas = createCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    png: new Uint8Array(await canvas.encode('png')),
    width: image.width,
    height: image.height,
  };
}

/**
 * Text-to-design: plan -> layered images -> N candidate designs -> score each with the
 * checker -> pick the best -> fix loop. Everything it makes is written next to `out`.
 */
export async function generateDesign(options: GenerateOptions): Promise<GenerationResult> {
  const started = Date.now();
  const emit = (event: GenerateEvent) => options.onEvent?.(event);
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    emit({ type: 'warning', message });
  };
  const n = Math.max(1, options.candidates ?? 4);
  const layoutCount = Math.max(1, Math.min(n, options.layouts ?? Math.min(2, n)));
  const out = resolve(options.out);
  const designDir = dirname(out);
  const name = basename(out, extname(out));
  mkdirSync(designDir, { recursive: true });
  const ledger = options.ledger ?? createMemoryLedger();
  const spentAtStart = ledger.spentUsd();
  const entriesAtStart = ledger.entries().length;
  const assets = new AssetStore(designDir, name, options.prompt);
  const workspace =
    options.workspace ??
    (await createWorkspace(designDir, { attention: options.attention ?? true }));
  // What the copy may state: the prompt and the descriptions of supplied images.
  const sources = [
    options.prompt,
    ...(options.userImages ?? []).flatMap((u) => (u.description ? [u.description] : [])),
  ];
  const copyGrounded = createCopyGroundedRule(sources);
  const check = (design: Design) => workspace.check(design, [copyGrounded]);
  const baseSeed =
    options.seed ?? seedFrom(`${options.prompt}|${options.canvas.width}x${options.canvas.height}`);

  // 1. Supplied images: copy into the assets folder, preview for the art director.
  const userImages = new Map<string, SlotImage>();
  const userInfo: UserImageInfo[] = [];
  for (const input of options.userImages ?? []) {
    const stored = await assets.importUserFile(input.path, input.id, `user/${input.id}`);
    userImages.set(input.id, stored);
    const p = await preview(input.path);
    userInfo.push({
      id: input.id,
      use: input.use,
      width: p.width,
      height: p.height,
      preview: p.png,
      ...(input.description ? { description: input.description } : {}),
    });
  }

  // 2. Plan.
  const fonts = [...BUNDLED_FONTS, ...(options.fonts ?? [])];
  const directed = await options.director.plan({
    prompt: options.prompt,
    canvas: options.canvas,
    layouts: layoutCount,
    fonts,
    ...(options.brandColors?.length ? { brandColors: options.brandColors } : {}),
    ...(userInfo.length ? { userImages: userInfo } : {}),
  });
  const plan = directed.plan;
  emit({ type: 'plan', plan, director: directed });
  const layouts = Math.min(layoutCount, plan.layouts.length);

  // 3. Images. Backgrounds vary per candidate; subjects are made once per layout.
  let provider = options.provider;
  const mock = createMockImageProvider();
  const cutoutLock = mutex();
  const measurer = createFontMeasurer();
  const cache = new Map<string, Promise<SlotImage>>();

  // Estimates of image calls in flight: parallel calls must not all pass the guard at once.
  let pendingUsd = 0;
  /** Calls the provider under the spend guard. Past the cap: mock images, or an error. */
  async function generate(
    request: ImageRequest,
    what: string,
    onBudget: 'mock' | 'throw' = 'mock',
  ): Promise<GeneratedImage> {
    try {
      ledger.guard(provider.estimateCostUsd(request) + pendingUsd, what);
    } catch (err) {
      if (!(err instanceof BudgetExceededError) || onBudget === 'throw') throw err;
      if (provider !== mock) warn(`${err.message} Using the mock image provider from here on.`);
      provider = mock;
    }
    const estimate = provider.estimateCostUsd(request);
    pendingUsd += estimate;
    let image: GeneratedImage;
    try {
      image = await provider.generate(request);
    } finally {
      pendingUsd -= estimate;
    }
    if (image.costUsd > 0) {
      ledger.record({ kind: 'image', what, model: image.model, costUsd: image.costUsd, tag: name });
    }
    return image;
  }

  /** Generated images by src: where they came from, so the fix loop can regenerate them. */
  const generated = new Map<string, { slot: ImageSlot; brief: string }>();

  /** Generates (and for subjects, cuts out) one image and stores it with its manifest entry. */
  async function makeImage(args: {
    slot: ImageSlot;
    prompt: string;
    brief: string;
    size: { width: number; height: number };
    seed: number;
    key: string;
    regeneration?: { reason: string; replaces: string };
    onBudget?: 'mock' | 'throw';
  }): Promise<SlotImage & { costUsd: number }> {
    const { slot, prompt, key } = args;
    const kind = slot.kind === 'subject' ? 'subject' : 'background';
    const image = await generate(
      {
        prompt,
        query: slot.stockQuery || undefined,
        width: args.size.width,
        height: args.size.height,
        seed: args.seed,
        kind,
      },
      `${kind} image (${key})`,
      args.onBudget,
    );
    const fileBase = key.replace(/\//g, '-');
    const common = {
      key,
      slotId: slot.id,
      kind,
      prompt,
      ...(args.regeneration ? { regeneration: args.regeneration } : {}),
    } as const;
    let stored: (SlotImage & { entry: ManifestEntry }) | undefined;
    if (kind === 'subject' && options.remover) {
      const remover = options.remover;
      try {
        const cut = await cutoutLock(() => remover.remove(image.bytes));
        const used = cut.remover ?? remover;
        if (cut.fallbackReason)
          warn(`Cutout for ${key} used ${used.id} instead of BiRefNet: ${cut.fallbackReason}`);
        stored = await assets.saveGenerated(
          image,
          fileBase,
          {
            ...common,
            cutout: {
              remover: used.id,
              model: used.model,
              license: used.license,
              coverage: Number(cut.coverage.toFixed(4)),
            },
          },
          cut.png,
          'image/png',
        );
      } catch (err) {
        warn(`Cutout failed for ${key}, keeping the plain backdrop: ${(err as Error).message}`);
      }
    }
    stored ??= await assets.saveGenerated(image, fileBase, {
      ...common,
      ...(kind === 'subject' ? { cutout: null } : {}),
    });
    emit({ type: 'image', entry: stored.entry });
    generated.set(stored.src, { slot, brief: args.brief });
    return { src: stored.src, width: stored.width, height: stored.height, costUsd: image.costUsd };
  }

  async function produce(
    slot: ImageSlot,
    layoutIndex: number,
    variant: number,
  ): Promise<SlotImage> {
    const layout = plan.layouts[layoutIndex]!;
    if (slot.kind === 'user') {
      const image = userImages.get(slot.userImageId);
      if (!image) throw new Error(`Supplied image "${slot.userImageId}" was not loaded`);
      return image;
    }
    const element = layout.elements.find((el) => el.kind === 'image' && el.slot === slot.id);
    const size =
      slot.kind === 'background' || !element
        ? options.canvas
        : { width: element.width, height: element.height };
    const seed =
      (baseSeed + layoutIndex * 1000 + variant * 7919 + (slot.kind === 'subject' ? 500 : 0)) %
      2_000_000_000;
    const key = `layout${layoutIndex + 1}/${slot.id}${slot.kind === 'background' ? `/v${variant + 1}` : ''}`;
    return makeImage({
      slot,
      prompt: buildImagePrompt(slot, layout.elements, options.canvas),
      brief: [slot.brief, slot.calmAreas].filter((s) => s.trim()).join(' '),
      size,
      seed,
      key,
    });
  }

  const slotImage = (slot: ImageSlot, layoutIndex: number, variant: number) => {
    const key =
      slot.kind === 'user'
        ? `user/${slot.userImageId}`
        : `${layoutIndex}/${slot.id}${slot.kind === 'background' ? `/${variant}` : ''}`;
    let promise = cache.get(key);
    if (!promise) {
      promise = produce(slot, layoutIndex, variant);
      cache.set(key, promise);
    }
    return promise;
  };

  // 4. Candidates: assemble, check, keep everything.
  const candidatesDir = join(designDir, `${name}.candidates`);
  mkdirSync(candidatesDir, { recursive: true });
  const specs = Array.from({ length: n }, (_, index) => ({
    index,
    ...candidateVariant(index, layouts),
  }));
  const candidates = await mapPool(specs, 4, async ({ index, layout, variant }) => {
    const layoutPlan = plan.layouts[layout]!;
    const images = new Map<string, SlotImage>();
    for (const slot of layoutPlan.imageSlots)
      images.set(slot.id, await slotImage(slot, layout, variant));
    const design = assembleDesign(
      plan,
      layout,
      options.canvas,
      images,
      `${layoutPlan.name} · candidate ${index + 1}`,
      measurer,
    );
    const report = await check(design);
    const shares = roleShares(report);
    const file = join(candidatesDir, `candidate-${index + 1}.json`);
    // Candidate files live one folder down, so their image paths get a ../ prefix.
    const relocated = {
      ...design,
      elements: design.elements.map((el) =>
        el.type === 'image' && !/^(data:|https?:|\/|[A-Za-z]:)/.test(el.src)
          ? { ...el, src: `../${el.src}` }
          : el,
      ),
    };
    writeFileSync(file, `${JSON.stringify(relocated, null, 2)}\n`);
    const candidate: CandidateResult = {
      index,
      layout,
      layoutName: layoutPlan.name,
      variant,
      design,
      report,
      score: report.score,
      errors: report.summary.errors,
      warnings: report.summary.warnings,
      ...(shares?.cta !== undefined ? { ctaShare: shares.cta } : {}),
      ...(shares?.headline !== undefined ? { headlineShare: shares.headline } : {}),
      file: `${name}.candidates/candidate-${index + 1}.json`,
    };
    return candidate;
  });
  // Reported in index order once all are scored (they finish in any order).
  for (const candidate of candidates) emit({ type: 'candidate', candidate });

  const ranking = rankCandidates(candidates.map((c) => c.report));
  const winner = candidates[ranking[0]!]!;
  emit({ type: 'winner', candidate: winner, ranking });

  // 5. Fix loop on the winner.
  const editor = options.editorModel
    ? budgetedEditor(options.editor, ledger, options.editorModel, name)
    : options.editor;
  const maxRegenerations = options.maxRegenerations ?? 2;
  let regenerationCount = 0;
  /** Generation mode: the fix loop may replace generated images with new ones. */
  const regenerateOptions = (): RegenerateOptions => ({
    max: maxRegenerations,
    images: (design) =>
      design.elements.flatMap((el) => {
        const info = el.type === 'image' ? generated.get(el.src) : undefined;
        if (!info) return [];
        const kind = info.slot.kind === 'subject' ? ('subject' as const) : ('background' as const);
        return [
          { elementId: el.id, kind, brief: info.brief, ...(el.role ? { role: el.role } : {}) },
        ];
      }),
    run: async ({ design, elementId, brief, reason }) => {
      const el = design.elements.find((e) => e.id === elementId);
      const info = el?.type === 'image' ? generated.get(el.src) : undefined;
      if (!el || el.type !== 'image' || !info)
        throw new Error(`"${elementId}" is not a generated image`);
      regenerationCount++;
      const slot = { ...info.slot, brief, calmAreas: '' };
      const image = await makeImage({
        slot,
        // Text zones come from the current (edited) layout, not the original plan.
        prompt: buildImagePrompt(slot, design.elements, options.canvas),
        brief,
        size:
          info.slot.kind === 'subject' ? { width: el.width, height: el.height } : options.canvas,
        seed: (baseSeed + 90_000 + regenerationCount * 131) % 2_000_000_000,
        key: `regen/${info.slot.id}/${regenerationCount}`,
        regeneration: { reason, replaces: el.src },
        onBudget: 'throw',
      });
      return {
        src: image.src,
        naturalWidth: image.width,
        naturalHeight: image.height,
        costUsd: image.costUsd,
      };
    },
  });
  const loop = await runFixLoop(winner.design, {
    editor,
    check,
    target: options.target ?? 95,
    maxIterations: options.maxIterations ?? 4,
    renderImages: options.vision === false ? undefined : workspace.renderImages,
    onIteration: (record) => emit({ type: 'iteration', record }),
    ...(maxRegenerations > 0 ? { regenerate: regenerateOptions() } : {}),
    copy: {
      check: (edit, design) => {
        const el = design.elements.find((e) => e.id === edit.elementId);
        return el?.type === 'text'
          ? checkFactReplacement(el.content, edit.find, edit.replace, sources)
          : `"${edit.elementId}" is not a text element.`;
      },
    },
  });
  if (loop.error) warn(`Fix loop stopped early: ${loop.error}`);

  // 6. Write the result and the full record.
  writeFileSync(out, `${JSON.stringify(loop.best.design, null, 2)}\n`);
  const entries = ledger.entries().slice(entriesAtStart);
  const llmUsd = entries.filter((e) => e.kind === 'llm').reduce((s, e) => s + e.costUsd, 0);
  const imageUsd = entries.filter((e) => e.kind === 'image').reduce((s, e) => s + e.costUsd, 0);
  const result: GenerationResult = {
    prompt: options.prompt,
    canvas: options.canvas,
    plan,
    director: {
      name: options.director.name,
      ...(directed.model ? { model: directed.model } : {}),
      calls: directed.calls,
      ...(directed.costUsd !== undefined ? { costUsd: directed.costUsd } : {}),
      ...(directed.retriedAfter ? { retriedAfter: directed.retriedAfter } : {}),
    },
    candidates,
    ranking,
    winner: winner.index,
    loop,
    final: { design: loop.best.design, report: loop.best.report },
    out,
    generationFile: join(designDir, `${name}.generation.json`),
    manifestFile: assets.manifestFile,
    assetsDir: assets.dir,
    spend: {
      totalUsd: Number((ledger.spentUsd() - spentAtStart).toFixed(4)),
      llmUsd: Number(llmUsd.toFixed(4)),
      imageUsd: Number(imageUsd.toFixed(4)),
      capUsd: ledger.capUsd,
      ledgerTotalUsd: Number(ledger.spentUsd().toFixed(4)),
    },
    warnings,
    durationMs: Date.now() - started,
  };
  writeFileSync(result.generationFile, `${JSON.stringify(serializeResult(result), null, 2)}\n`);
  return result;
}

/** The generation record without duplicated bulk: reports are summarized, designs kept. */
export function serializeResult(result: GenerationResult) {
  const summary = (report: Report) => ({
    score: report.score,
    passed: report.passed,
    summary: report.summary,
    issues: report.issues.map((i) => ({
      ruleId: i.ruleId,
      severity: i.severity,
      elementIds: i.elementIds,
      message: i.message,
    })),
    attention: roleShares(report),
  });
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    prompt: result.prompt,
    canvas: result.canvas,
    director: result.director,
    plan: result.plan,
    candidates: result.candidates.map((c) => ({
      index: c.index,
      layout: c.layout,
      layoutName: c.layoutName,
      variant: c.variant,
      file: c.file,
      score: c.score,
      errors: c.errors,
      warnings: c.warnings,
      ctaShare: c.ctaShare,
      headlineShare: c.headlineShare,
      report: summary(c.report),
    })),
    ranking: result.ranking,
    winner: result.winner,
    loop: {
      stopReason: result.loop.stopReason,
      error: result.loop.error,
      totals: result.loop.totals,
      bestIteration: result.loop.best.iteration,
      history: result.loop.history.map((h) => ({
        iteration: h.iteration,
        status: h.status,
        scoreBefore: h.scoreBefore,
        scoreAfter: h.scoreAfter,
        summary: h.summary,
        edits: h.edits,
        note: h.note,
        model: h.model,
        usage: h.usage,
        regenerations: (h as { regenerations?: unknown }).regenerations,
        design: h.design,
        report: summary(h.report),
      })),
    },
    final: {
      design: result.final.design,
      report: summary(result.final.report),
      ctaShare: ctaShare(result.final.report),
    },
    spend: result.spend,
    warnings: result.warnings,
    durationMs: result.durationMs,
  };
}
