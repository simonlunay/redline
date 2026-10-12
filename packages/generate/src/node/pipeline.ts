import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createFontMeasurer, renderPng } from '@simonlunay/redline/node';
import type { AnyRule, Design, Report } from '@simonlunay/redline';
import { runFixLoop } from '@simonlunay/redline-agent';
import type {
  DesignEditor,
  IterationRecord,
  LoopResult,
  RegenerateOptions,
} from '@simonlunay/redline-agent';
import { assembleDesign } from '../assemble.js';
import type { SlotImage } from '../assemble.js';
import type { BackgroundRemover, RemoverKind } from '../cutout.js';
import { BUNDLED_FONTS } from '../director/types.js';
import type { ArtDirector, DirectorResult, UserImageInfo } from '../director/types.js';
import { checkFactReplacement, createCopyGroundedRule } from '../grounding.js';
import { buildImagePrompt } from '../image-prompt.js';
import { createKeyElementsVisibleRule } from '../key-elements.js';
import {
  createJudgeStore,
  designFingerprint,
  judgeElements,
  judgeKnownIssues,
} from '../judge/rule.js';
import type { JudgeVerdict, VisualJudge } from '../judge/types.js';
import type { DesignPlan, ImageSlot } from '../plan.js';
import {
  MAX_SHADOW_OPACITY,
  setContactShadow,
  shadowIdFor,
  syncContactShadows,
} from '../shadow.js';
import type { Footprint } from '../shadow.js';
import type { GeneratedImage, ImageProvider, ImageRequest } from '../providers/types.js';
import { candidateVariant, ctaShare, rankCandidates, roleShares, seedFrom } from '../select.js';
import { BudgetExceededError, budgetedEditor, createMemoryLedger } from '../spend.js';
import type { SpendLedger } from '../spend.js';
import { AssetStore } from './assets.js';
import type { ManifestEntry } from './assets.js';
import { cutOutWithQualityCheck, estimateBackdrop, measureFootprint } from './cutout.js';
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
  /**
   * Image rules on generated and stock images: text drawn into them, damaged cutouts (default
   * true). Only used when the pipeline creates its own workspace; a passed-in workspace decides.
   */
  imageChecks?: boolean;
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
  /**
   * The vision judge: reviews the winner's render, and the fix loop's result, for visible
   * defects the rules can't see. Without one, no judge runs.
   */
  judge?: VisualJudge;
  /** Re-judgments after a fix loop (default 2): at most 1 + judgeRounds judge calls. */
  judgeRounds?: number;
  onEvent?: (event: GenerateEvent) => void;
}

export type GenerateEvent =
  | { type: 'plan'; plan: DesignPlan; director: DirectorResult }
  | { type: 'image'; entry: ManifestEntry }
  | { type: 'candidate'; candidate: CandidateResult }
  | { type: 'winner'; candidate: CandidateResult; ranking: number[] }
  | { type: 'iteration'; record: IterationRecord }
  | { type: 'judge'; judgment: Judgment }
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

/** One review by the vision judge. */
export interface Judgment {
  /** 0 = the best-of-N winner, 1.. = after each fix loop. */
  round: number;
  verdict: JudgeVerdict['verdict'];
  summary: string;
  findings: JudgeVerdict['findings'];
  /** The rules' score of the design the judge looked at (without the judge's own findings). */
  rulesScore: number;
  /** The rules' errors on that design. */
  rulesErrors: number;
  model?: string;
  costUsd?: number;
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
    droppedLayouts?: string;
  };
  candidates: CandidateResult[];
  ranking: number[];
  winner: number;
  /** The fix loop (with the judge: every round's loop merged into one history). */
  loop: LoopResult;
  final: { design: Design; report: Report };
  /** The vision judge's reviews, in order (empty without a judge). */
  judgments: Judgment[];
  /** With a judge: which review's design was shipped (see pickJudged). */
  finalJudgeRound?: number;
  judge?: string;
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

/**
 * Index of the best reviewed design: fewest errors (rules errors + high-severity findings), then
 * fewest medium findings, then the highest rules score; later rounds win ties.
 */
export function pickJudged(judgments: Judgment[]): number {
  const key = (j: Judgment) => [
    j.rulesErrors + j.findings.filter((f) => f.severity === 'high').length,
    j.findings.filter((f) => f.severity === 'medium').length,
    -j.rulesScore,
  ];
  let best = 0;
  judgments.forEach((j, i) => {
    const [a, b] = [key(j), key(judgments[best]!)];
    for (let k = 0; k < a.length; k++) {
      if (a[k]! < b[k]!) {
        best = i;
        return;
      }
      if (a[k]! > b[k]!) return;
    }
    best = i; // equal: prefer the later round
  });
  return best;
}

/** Long side of the render the judge sees: detailed enough, about 1.4k image tokens. */
const JUDGE_LONG_SIDE = 1024;

/**
 * Several fix loops in a row (one per judge round) as one record: histories concatenated with
 * running iteration numbers, totals summed, and the best of the last loop (each loop starts
 * from the previous best and never returns worse than its start).
 */
export function mergeLoops(loops: LoopResult[]): LoopResult {
  if (loops.length === 1) return loops[0]!;
  let offset = 0;
  const history: LoopResult['history'] = [];
  let bestIteration = 0;
  loops.forEach((l, i) => {
    for (const h of l.history) history.push({ ...h, iteration: h.iteration + offset });
    if (i === loops.length - 1) bestIteration = l.best.iteration + offset;
    offset += l.history.length;
  });
  const last = loops.at(-1)!;
  const sum = (f: (l: LoopResult) => number) => loops.reduce((s, l) => s + f(l), 0);
  const failed = loops.find((l) => l.error);
  return {
    initial: loops[0]!.initial,
    best: { ...last.best, iteration: bestIteration },
    history,
    stopReason: last.stopReason,
    ...(failed ? { error: failed.error } : {}),
    totals: {
      iterations: sum((l) => l.totals.iterations),
      calls: sum((l) => l.totals.calls),
      regenerations: sum((l) => l.totals.regenerations ?? 0),
      usage: {
        inputTokens: sum((l) => l.totals.usage.inputTokens),
        outputTokens: sum((l) => l.totals.usage.outputTokens),
        cacheReadTokens: sum((l) => l.totals.usage.cacheReadTokens),
        cacheWriteTokens: sum((l) => l.totals.usage.cacheWriteTokens),
      },
      durationMs: sum((l) => l.totals.durationMs),
    },
  };
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
    (await createWorkspace(designDir, {
      attention: options.attention ?? true,
      imageChecks: options.imageChecks ?? true,
    }));
  // What the copy may state: the prompt and the descriptions of supplied images.
  const sources = [
    options.prompt,
    ...(options.userImages ?? []).flatMap((u) => (u.description ? [u.description] : [])),
  ];
  const copyGrounded = createCopyGroundedRule(sources);
  const judgeStore = createJudgeStore();
  /** Set once the winner is known: its key elements must stay visible through the fix loop. */
  const keyElements: AnyRule[] = [];
  const check = (design: Design) =>
    workspace.check(design, [
      copyGrounded,
      ...keyElements,
      ...(options.judge ? [judgeStore.rule] : []),
    ]);
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
  if (directed.droppedLayouts) {
    warn(
      `The art director's plan had unusable layouts; kept ${plan.layouts.length}:\n${directed.droppedLayouts}`,
    );
  }
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

  /** Cut-out subjects by src: where each touches the ground, for its contact shadow. */
  const footprints = new Map<string, Footprint>();

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
    let backdrop: [number, number, number] | undefined;
    let cutoutSource: RemoverKind | undefined;
    let footprint: Footprint | undefined;
    if (kind === 'subject' && options.remover) {
      const remover = options.remover;
      try {
        // With image checks on, a damaged cut is re-cut right away (free, no API call).
        const checked = workspace.imageAnalysis
          ? await cutoutLock(() => cutOutWithQualityCheck(remover, image.bytes))
          : undefined;
        const cut = checked?.cut ?? (await cutoutLock(() => remover.remove(image.bytes)));
        const used = cut.remover ?? remover;
        if (cut.fallbackReason)
          warn(
            `Cutout for ${key} used ${used.id} instead of local BiRefNet: ${cut.fallbackReason}`,
          );
        if (checked?.recuts.length) {
          warn(
            `Cutout for ${key} was damaged (${checked.verdict.problems.map((p) => p.kind).join(', ') || 'fixed'} after re-cutting); ${checked.kept ? `kept the re-cut ${checked.kept}` : 'no re-cut was better'}.`,
          );
        }
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
              ...(checked
                ? {
                    quality: checked.verdict.severity,
                    ...(checked.verdict.problems.length
                      ? { problems: checked.verdict.problems.map((p) => p.kind) }
                      : {}),
                    ...(checked.recuts.length ? { recuts: checked.recuts } : {}),
                    ...(checked.kept ? { keptRecut: checked.kept } : {}),
                  }
                : {}),
            },
          },
          cut.png,
          'image/png',
        );
        backdrop = await estimateBackdrop(image.bytes);
        cutoutSource = used.kind;
        footprint = (await measureFootprint(cut.png)) ?? undefined;
        if (footprint) footprints.set(stored.src, footprint);
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
    // Generated and stock images get the image checks; the user's own images never do.
    workspace.markImage(
      stored.src,
      image.provider === 'pexels' ? 'stock' : 'generated',
      backdrop,
      cutoutSource,
    );
    return {
      src: stored.src,
      width: stored.width,
      height: stored.height,
      costUsd: image.costUsd,
      ...(footprint ? { footprint } : {}),
    };
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
  keyElements.push(createKeyElementsVisibleRule(winner.design));

  // 5. Fix loop on the winner.
  const editor = options.editorModel
    ? budgetedEditor(options.editor, ledger, options.editorModel, name)
    : options.editor;
  const maxRegenerations = options.maxRegenerations ?? 2;
  let regenerationCount = 0;
  /** Generation mode: the fix loop may replace generated images with new ones. */
  const regenerateOptions = (max: number): RegenerateOptions => ({
    max,
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
  const runLoop = (start: Design) => {
    // The regeneration cap holds across every round's loop.
    const regenLeft = maxRegenerations - regenerationCount;
    return runFixLoop(start, {
      editor,
      check,
      target: options.target ?? 95,
      maxIterations: options.maxIterations ?? 4,
      renderImages: options.vision === false ? undefined : workspace.renderImages,
      onIteration: (record) => emit({ type: 'iteration', record }),
      ...(regenLeft > 0 ? { regenerate: regenerateOptions(regenLeft) } : {}),
      copy: {
        check: (edit, design) => {
          const el = design.elements.find((e) => e.id === edit.elementId);
          return el?.type === 'text'
            ? checkFactReplacement(el.content, edit.find, edit.replace, sources)
            : `"${edit.elementId}" is not a text element.`;
        },
      },
      shadows: {
        subjects: (design) =>
          design.elements.flatMap((el) =>
            el.type === 'image' && footprints.has(el.src)
              ? [
                  {
                    elementId: el.id,
                    opacity: design.elements.find((s) => s.id === shadowIdFor(el.id))?.opacity ?? 0,
                  },
                ]
              : [],
          ),
        apply: (design, edit) => {
          const subject = design.elements.find((el) => el.id === edit.elementId);
          const footprint = subject?.type === 'image' ? footprints.get(subject.src) : undefined;
          if (!footprint) return `"${edit.elementId}" is not a cut-out subject.`;
          // Off is opacity 0, not removal: the loop's guardrail forbids removing elements.
          return setContactShadow(design, edit.elementId, footprint, {
            enabled: true,
            opacity: Math.max(0, Math.min(MAX_SHADOW_OPACITY, edit.opacity)),
          });
        },
      },
      normalize: (design) => syncContactShadows(design, (src) => footprints.get(src)),
    });
  };

  // The vision judge sees the clean render, the element table, the rules' open issues and the
  // prompt; never the fixer's reasoning, the edit history, the plan or a score.
  const judgments: Judgment[] = [];
  /** Every design the judge reviewed, with its verdict: the final pick is made among them. */
  const reviewed: { design: Design; verdict: JudgeVerdict; judgment: Judgment }[] = [];
  const judgeDesign = async (design: Design, round: number): Promise<boolean> => {
    if (!options.judge) return false;
    try {
      const rules = await workspace.check(design, [copyGrounded, ...keyElements]);
      const longSide = Math.max(design.canvas.width, design.canvas.height);
      const png = renderPng(design, {
        images: workspace.images,
        scale: Math.min(1, JUDGE_LONG_SIDE / longSide),
      });
      const v = await options.judge.judge({
        prompt: options.prompt,
        canvas: { width: design.canvas.width, height: design.canvas.height },
        png: new Uint8Array(png),
        elements: judgeElements(design),
        issues: judgeKnownIssues(rules),
      });
      judgeStore.record(design, v);
      const judgment: Judgment = {
        round,
        verdict: v.verdict,
        summary: v.summary,
        findings: v.findings,
        rulesScore: rules.score,
        rulesErrors: rules.summary.errors,
        ...(v.model ? { model: v.model } : {}),
        ...(v.costUsd !== undefined ? { costUsd: Number(v.costUsd.toFixed(4)) } : {}),
      };
      judgments.push(judgment);
      reviewed.push({ design, verdict: v, judgment });
      emit({ type: 'judge', judgment });
      return true;
    } catch (err) {
      warn(`The vision judge failed, continuing without it: ${(err as Error).message}`);
      return false;
    }
  };

  // Judge the winner, fix, judge again; one more fix round only while the judge still reports
  // something severe. At most 1 + judgeRounds judge calls.
  const judgeRounds = Math.max(0, options.judgeRounds ?? 2);
  let judged = await judgeDesign(winner.design, 0);
  const loops: LoopResult[] = [await runLoop(winner.design)];
  for (let round = 1; judged && round <= judgeRounds; round++) {
    const best = loops.at(-1)!.best.design;
    // Nothing changed since the last review: another look would only sample the judge again.
    if (designFingerprint(best) === designFingerprint(reviewed.at(-1)!.design)) break;
    judged = await judgeDesign(best, round);
    const severe = judgeStore.active(best).some((f) => f.severity === 'high');
    if (!judged || !severe || round === judgeRounds) break;
    loops.push(await runLoop(best));
  }
  const loop = mergeLoops(loops);
  if (loop.error) warn(`Fix loop stopped early: ${loop.error}`);
  // With a judge, ship the reviewed design that the judge and the rules rate best: fewest
  // errors (rules errors + high-severity findings), then fewest medium findings, then the rules'
  // score. The loop alone can't decide this: while a finding is suspended (its element changed),
  // a regeneration can look like an improvement that the next review shows it wasn't.
  const pick = reviewed.length > 1 ? pickJudged(reviewed.map((j) => j.judgment)) : -1;
  const chosen = pick >= 0 ? reviewed[pick]! : undefined;
  const finalDesign = chosen ? chosen.design : loop.best.design;
  if (chosen) judgeStore.record(chosen.design, chosen.verdict);
  const finalReport = reviewed.length > 1 ? await check(finalDesign) : loop.best.report;
  if (chosen && chosen !== reviewed.at(-1)) {
    warn(
      `Kept the design from judge round ${chosen.judgment.round}: the later fixes didn't hold up on review.`,
    );
  }

  // 6. Write the result and the full record.
  writeFileSync(out, `${JSON.stringify(finalDesign, null, 2)}\n`);
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
      ...(directed.droppedLayouts ? { droppedLayouts: directed.droppedLayouts } : {}),
    },
    candidates,
    ranking,
    winner: winner.index,
    loop,
    final: { design: finalDesign, report: finalReport },
    ...(chosen ? { finalJudgeRound: chosen.judgment.round } : {}),
    judgments,
    ...(options.judge ? { judge: options.judge.name } : {}),
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
    judge: result.judge ?? null,
    judgments: result.judgments,
    finalJudgeRound: result.finalJudgeRound ?? null,
    spend: result.spend,
    warnings: result.warnings,
    durationMs: result.durationMs,
  };
}
