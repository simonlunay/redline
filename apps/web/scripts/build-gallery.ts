/**
 * Builds the web gallery from recorded runs: npm run gallery -w apps/web [-- <run id>...]
 *
 * For each run in gallery-sources.ts it converts the images to WebP, re-checks every design
 * snapshot with today's checker, stores the attention rules' outputs so the browser can replay
 * them, renders a small heatmap per snapshot, and writes public/gallery/<id>/run.json. It also
 * writes the /check samples (every fixture) to public/samples/.
 *
 * Two checks per snapshot, on purpose:
 * - On the ORIGINAL images, with every rule the run used (layout, attention, image rules,
 *   copy-grounded, key-element-visible). This is compared with the score the run recorded,
 *   and it's where the attention outputs, image analyses and heatmaps come from: WebP
 *   compression shifts predicted attention enough to flip a CTA sitting right at its minimum.
 * - On the WebP images, with exactly the rules the browser builds (lib/rules.ts), replaying the
 *   attention outputs. That's the report stored and shown, so the site's live check of an
 *   unedited design reproduces it. Where WebP changes a result (contrast sampled near a
 *   threshold), the build says so.
 *
 * It runs locally (it needs the saliency and text-detection models, ~65 MB, cached on first use)
 * and costs nothing: no API is called. The output is committed; CI never runs this.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Image } from '@napi-rs/canvas';
import { attentionRules, checkAsync, parseDesign } from '@simonlunay/redline';
import type { CutoutSource, Design, ImageAnalysis, Report, SaliencyMap } from '@simonlunay/redline';
import {
  createFontMeasurer,
  createImageSampler,
  renderPng,
  renderRaster,
} from '@simonlunay/redline/node';
import { createSuggestedFixesEditor, runFixLoop } from '@simonlunay/redline-agent';
import type { IterationRecord } from '@simonlunay/redline-agent';
import { createCopyGroundedRule, createKeyElementsVisibleRule } from '@simonlunay/redline-generate';
import { createWorkspace } from '@simonlunay/redline-generate/node';
import type { Workspace } from '@simonlunay/redline-generate/node';
import {
  GALLERY_SCHEMA_VERSION,
  type CandidateRecord,
  type EditRecord,
  type FrozenRuleOutput,
  type GalleryEntry,
  type GalleryIndex,
  type JudgmentRecord,
  type LoopRecord,
  type Outcome,
  type RuleSet,
  type RunRecord,
  type RunRules,
  type SampleRecord,
  type Snapshot,
  type StepRecord,
} from '../src/lib/gallery/types';
import { browserRules } from '../src/lib/rules';
import { GALLERY_SOURCES, STRICT_RESULTS } from './gallery-sources';
import type { GenerateSource, RecordedFixSource, StrictFixSource } from './gallery-sources';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC = join(WEB, 'public');
const GALLERY = join(PUBLIC, 'gallery');
const SAMPLES = join(PUBLIC, 'samples');
const FIX_RUNS = join(WEB, 'gallery-src', 'fix-runs');
const FIXTURES = join(ROOT, 'fixtures');

/** The gallery's images (WebP, heatmaps, thumbnails) may not exceed this in total. */
export const SIZE_BUDGET_BYTES = 15 * 1024 * 1024;
const WEBP_QUALITY = 82;
const HEATMAP_MAX_SIDE = 160;
const THUMB_WIDTH = 480;
const FIX_TARGET = 100;
const FIX_MAX_ITERATIONS = 5;

const log = (msg: string) => process.stderr.write(`${msg}\n`);
/** Every score the served images changed, for --verbose. */
const webpLog: string[] = [];
const hash = (value: unknown) =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
const titleCase = (id: string) =>
  id
    .replace(/^hard-/, '')
    .replace(/-/g, ' ')
    .replace(/\b5k\b/, '5K')
    .replace(/\bsaas\b/, 'SaaS')
    .replace(/\bcta\b/, 'CTA')
    .replace(/^./, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------------------------
// Images

async function losslessPng(path: string): Promise<Buffer> {
  if (extname(path).toLowerCase() === '.png') return readFileSync(path);
  const image = await loadImage(path);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas.encode('png');
}

async function encodeWebp(image: Image): Promise<Buffer> {
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas.encode('webp', WEBP_QUALITY);
}

/** Box-downsamples a saliency map and stores it as 8-bit gray, scaled so its peak is white. */
async function writeHeatmap(map: SaliencyMap, out: string): Promise<void> {
  const k = Math.max(1, Math.ceil(Math.max(map.width, map.height) / HEATMAP_MAX_SIDE));
  const w = Math.ceil(map.width / k);
  const h = Math.ceil(map.height / k);
  const values = new Float32Array(w * h);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      values[Math.floor(y / k) * w + Math.floor(x / k)]! += map.data[y * map.width + x]!;
    }
  }
  let max = 0;
  for (const v of values) max = Math.max(max, v);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const data = ctx.createImageData(w, h);
  for (let i = 0; i < values.length; i++) {
    const g = max > 0 ? Math.round((values[i]! / max) * 255) : 0;
    data.data.set([g, g, g, 255], i * 4);
  }
  ctx.putImageData(data, 0, 0);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await canvas.encode('png'));
}

/** Rewrites every image src through `map`. */
function remapSrcs(design: Design, map: (src: string) => string): Design {
  return {
    ...design,
    elements: design.elements.map((el) => (el.type === 'image' ? { ...el, src: map(el.src) } : el)),
  };
}

/** Lossless PNGs stay PNG (the fixtures' images are small, and exact pixels keep contrast exact). */
const servedName = (src: string, lossless: boolean) =>
  `img/${basename(src, extname(src))}.${lossless ? 'png' : 'webp'}`;

// ---------------------------------------------------------------------------------------------
// Builder: one per run (or sample). Designs come in with absolute image paths.

interface Builder {
  outDir: string;
  /** Serve images as lossless PNG instead of WebP. */
  losslessImages: boolean;
  /** Checks with the original images and every rule (see the file comment). */
  original: Workspace;
  rules: RunRules;
  /** Absolute original path -> WebP src (relative to outDir). */
  webp: Map<string, string>;
  webpImages: Map<string, Image>;
  sampler: ReturnType<typeof createImageSampler>;
  measurer: ReturnType<typeof createFontMeasurer>;
  /** The winner (absolute srcs): the key-element rule applies from the fix loop on. */
  planned?: Design;
  snapshots: Record<string, Snapshot>;
  /** Score on the original images, per snapshot id, for comparing with the record. */
  originalScores: Map<string, number>;
  images: RunRecord['images'];
  /** Recorded score vs today's checker on the original images. */
  mismatches: string[];
  /** Today's checker on the original images vs on the WebP images. */
  webpChanges: string[];
}

async function createBuilder(
  outDir: string,
  rules: RunRules,
  losslessImages = false,
): Promise<Builder> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const webpImages = new Map<string, Image>();
  return {
    outDir,
    losslessImages,
    original: await createWorkspace(ROOT, {
      attention: rules.attention,
      imageChecks: rules.imageChecks,
    }),
    rules,
    webp: new Map(),
    webpImages,
    sampler: createImageSampler(webpImages),
    measurer: createFontMeasurer(),
    snapshots: {},
    originalScores: new Map(),
    images: {},
    mismatches: [],
    webpChanges: [],
  };
}

/** Converts an original image to WebP (once) and registers it for both checks. */
async function addImage(
  b: Builder,
  absPath: string,
  mark?: { origin: 'generated' | 'stock'; cutoutSource?: CutoutSource },
): Promise<string> {
  const existing = b.webp.get(absPath);
  if (existing) return existing;
  const lossless = b.losslessImages;
  const src = servedName(absPath, lossless);
  const original = await loadImage(absPath);
  const out = join(b.outDir, src);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lossless ? await losslessPng(absPath) : await encodeWebp(original));
  b.webpImages.set(src, await loadImage(out));
  // The sampler decodes images up front, so it's rebuilt when one is added.
  b.sampler = createImageSampler(b.webpImages);
  if (mark) b.original.markImage(absPath, mark.origin, undefined, mark.cutoutSource);
  b.webp.set(absPath, src);
  b.images[src] = { width: original.width, height: original.height };
  return src;
}

function frozenAttention(report: Report): Record<string, FrozenRuleOutput> {
  const out: Record<string, FrozenRuleOutput> = {};
  for (const rule of attentionRules) {
    const score = report.rules.find((r) => r.ruleId === rule.id);
    if (!score) continue;
    out[rule.id] = {
      issues: report.issues
        .filter((i) => i.ruleId === rule.id)
        .map(({ ruleId: _ruleId, ...issue }) => issue),
      ...(score.elementScores ? { elementScores: score.elementScores } : {}),
      ...(score.details ? { details: score.details } : {}),
    };
  }
  return out;
}

/** Checks a design (absolute srcs) and stores it once per rule set; returns its snapshot id. */
async function snapshot(b: Builder, absDesign: Design, ruleSet: RuleSet): Promise<string> {
  for (const el of absDesign.elements) if (el.type === 'image') await addImage(b, el.src);
  const toWebp = (s: string) => b.webp.get(s)!;
  const design = remapSrcs(absDesign, toWebp);
  const id = `${hash(design)}-${ruleSet === 'candidate' ? 'c' : 'l'}`;
  if (b.snapshots[id]) return id;

  const planned = ruleSet === 'loop' ? b.planned : undefined;
  const original = await b.original.check(absDesign, [
    ...(b.rules.copyGrounded ? [createCopyGroundedRule(b.rules.copyGrounded.sources)] : []),
    ...(planned ? [createKeyElementsVisibleRule(planned)] : []),
  ]);
  b.originalScores.set(id, original.score);

  const attention = b.rules.attention ? frozenAttention(original) : undefined;
  const analyses = new Map<string, ImageAnalysis>();
  for (const [abs, src] of b.webp) {
    const analysis = b.original.imageAnalysis?.get(abs);
    if (analysis) analyses.set(src, analysis);
  }
  const { rules } = browserRules({
    rules: b.rules,
    ...(attention ? { frozenAttention: attention } : {}),
    ...(planned ? { plannedDesign: remapSrcs(planned, toWebp) } : {}),
  });
  const report = await checkAsync(design, {
    rules,
    measurer: b.measurer,
    sampler: b.sampler,
    ...(b.rules.imageChecks ? { images: { get: (src: string) => analyses.get(src) } } : {}),
  });
  if (report.score !== original.score) {
    const changed = report.issues
      .filter((i) => !original.issues.some((o) => o.ruleId === i.ruleId && o.message === i.message))
      .map((i) => i.ruleId);
    const change = `${id}: ${original.score} on the originals, ${report.score} as served (${[...new Set(changed)].join(', ') || 'an issue cleared'})`;
    b.webpChanges.push(change);
    webpLog.push(`${basename(b.outDir)} ${change}`);
  }

  const snap: Snapshot = { id, ruleSet, design, report };
  if (attention && b.original.saliency) {
    snap.attention = attention;
    const heatmap = `heat/${hash(design)}.png`;
    if (!existsSync(join(b.outDir, heatmap))) {
      const raster = renderRaster(absDesign, { images: b.original.images });
      await writeHeatmap(await b.original.saliency.predict(raster), join(b.outDir, heatmap));
    }
    snap.heatmap = heatmap;
  }
  b.snapshots[id] = snap;
  return id;
}

function compare(b: Builder, what: string, recorded: number, id: string) {
  const now = b.originalScores.get(id);
  if (now !== recorded) b.mismatches.push(`${what}: recorded ${recorded}, today ${now}`);
}

function analysesInto(b: Builder) {
  for (const [abs, src] of b.webp) {
    const analysis = b.original.imageAnalysis?.get(abs);
    if (analysis) b.images[src]!.analysis = analysis;
  }
}

async function writeThumbnail(b: Builder, snapId: string) {
  const design = b.snapshots[snapId]!.design;
  const png = renderPng(design, { images: b.webpImages, scale: THUMB_WIDTH / design.canvas.width });
  writeFileSync(join(b.outDir, 'thumb.webp'), await encodeWebp(await loadImage(png)));
}

function editRecord(edit: Record<string, unknown>): EditRecord {
  const { op, elementId, reason, ...params } = edit as {
    op: string;
    elementId?: string;
    reason?: string;
  };
  return { op, ...(elementId ? { elementId } : {}), ...(reason ? { reason } : {}), params };
}

type HistoryStep = Pick<
  IterationRecord,
  'iteration' | 'status' | 'scoreBefore' | 'scoreAfter' | 'design'
> & {
  summary?: string;
  note?: string;
  edits?: unknown[];
  durationMs?: number;
};

async function loopRecord(
  b: Builder,
  editor: string,
  history: HistoryStep[],
  stopReason: string,
  bestIteration: number,
  abs: (src: string) => string,
): Promise<LoopRecord> {
  const steps: StepRecord[] = [];
  for (const h of history) {
    steps.push({
      iteration: h.iteration,
      status: h.status as StepRecord['status'],
      recordedScoreBefore: h.scoreBefore,
      recordedScoreAfter: h.scoreAfter,
      ...(h.summary ? { summary: h.summary } : {}),
      edits: (h.edits ?? []).map((e) => editRecord(e as Record<string, unknown>)),
      ...(h.note ? { note: h.note } : {}),
      ...(h.durationMs ? { durationMs: h.durationMs } : {}),
      snapshot: await snapshot(b, remapSrcs(h.design, abs), 'loop'),
    });
  }
  return { editor, stopReason, steps, bestIteration };
}

function provenanceNotes(b: Builder, notes: string[] = []): string[] {
  return [
    ...notes,
    ...b.mismatches.map((m) => `Re-checked with today's checker: ${m}.`),
    ...(b.webpChanges.length
      ? [
          `WebP compression changed ${b.webpChanges.length} snapshot score(s) slightly; the scores shown are on the images as served.`,
        ]
      : []),
  ];
}

// ---------------------------------------------------------------------------------------------
// Generate runs

interface GenerationJson {
  createdAt: string;
  prompt: string;
  canvas: { width: number; height: number };
  plan: {
    concept: string;
    palette: Record<string, string>;
    copy: Record<string, string>;
    layouts: { name: string; rationale?: string }[];
  };
  candidates: {
    index: number;
    layoutName: string;
    file: string;
    score: number;
    errors: number;
    warnings: number;
    ctaShare?: number;
  }[];
  ranking: number[];
  winner: number;
  loop: {
    stopReason: string;
    bestIteration: number;
    history: (IterationRecord & { summary?: string })[];
  };
  final: { design: Design; report: { score: number } };
  judgments: JudgmentRecord[];
  finalJudgeRound: number | null;
  durationMs: number;
}

interface ManifestJson {
  images: { file: string; kind: string; provider: string; cutout?: { remover?: string } | null }[];
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

async function buildGenerate(src: GenerateSource): Promise<RunRecord> {
  const dir = join(ROOT, src.dir);
  const name = basename(dir);
  const assets = join(dir, `${name}.assets`);
  const gen = JSON.parse(
    readFileSync(join(dir, `${name}.generation.json`), 'utf8'),
  ) as GenerationJson;
  const manifest = JSON.parse(readFileSync(join(assets, 'manifest.json'), 'utf8')) as ManifestJson;
  const rules: RunRules = {
    attention: true,
    imageChecks: true,
    copyGrounded: { sources: [gen.prompt] },
  };
  const b = await createBuilder(join(GALLERY, src.id), rules);

  // Every generated image is marked the way the pipeline marked it, so the image rules match.
  for (const entry of manifest.images) {
    const cutoutSource: CutoutSource | undefined =
      entry.kind === 'subject' && entry.cutout
        ? entry.cutout.remover?.includes('birefnet')
          ? 'model'
          : 'keyer'
        : undefined;
    await addImage(b, join(assets, entry.file), {
      origin: entry.provider === 'pexels' ? 'stock' : 'generated',
      ...(cutoutSource ? { cutoutSource } : {}),
    });
  }

  const candidates: CandidateRecord[] = [];
  const candidateDesigns = new Map<number, Design>();
  for (const c of gen.candidates) {
    const file = join(dir, c.file);
    const design = remapSrcs(parseDesign(JSON.parse(readFileSync(file, 'utf8'))), (s) =>
      resolve(dirname(file), s),
    );
    candidateDesigns.set(c.index, design);
    const id = await snapshot(b, design, 'candidate');
    compare(b, `candidate ${c.index + 1}`, c.score, id);
    candidates.push({
      index: c.index,
      layoutName: c.layoutName,
      recordedScore: c.score,
      errors: c.errors,
      warnings: c.warnings,
      ...(c.ctaShare !== undefined ? { ctaShare: c.ctaShare } : {}),
      snapshot: id,
    });
  }

  b.planned = candidateDesigns.get(gen.winner);
  const winnerLoopSnapshot = await snapshot(b, b.planned!, 'loop');
  rules.keyElements = { snapshot: winnerLoopSnapshot };
  const abs = (s: string) => resolve(dir, s);
  // Scores recorded in the loop include the judge's findings, so they aren't compared.
  const loop = await loopRecord(
    b,
    'anthropic:claude-sonnet-5-5',
    gen.loop.history,
    gen.loop.stopReason,
    gen.loop.bestIteration,
    abs,
  );
  const final = await snapshot(b, remapSrcs(gen.final.design, abs), 'loop');
  analysesInto(b);

  const finalRound = gen.finalJudgeRound ?? gen.judgments.at(-1)?.round ?? 0;
  const verdict = gen.judgments.find((j) => j.round === finalRound);
  const outcome: Outcome =
    verdict?.verdict === 'ship'
      ? 'shipped'
      : verdict?.verdict === 'reject'
        ? 'judge-reject'
        : 'judge-fix';
  const worst = [...(verdict?.findings ?? [])].sort(
    (a, c) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[c.severity],
  )[0];

  await writeThumbnail(b, final);
  const winner = candidates.find((c) => c.index === gen.winner)!;
  return {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    id: src.id,
    kind: 'generate',
    title: src.id.endsWith('-tuned') ? `${titleCase(name)}, after shadow tuning` : titleCase(name),
    prompt: gen.prompt,
    canvas: gen.canvas,
    outcome,
    ...(outcome !== 'shipped' && worst ? { outcomeNote: worst.description } : {}),
    provenance: {
      source: src.results,
      model:
        'Sonnet 5.5 (art director and fixer), Opus 5.5 (judge), FLUX.1 schnell (images), BiRefNet on Replicate (cutouts)',
      recordedAt: gen.createdAt,
      notes: provenanceNotes(b, [
        ...(src.notes ?? []),
        ...(b.mismatches.length
          ? [
              "Cutouts were measured during the run against the backdrop color of the uncut image, which the run didn't keep, so some cutout-quality warnings can't be reproduced now.",
            ]
          : []),
      ]),
    },
    rank: 0,
    plan: {
      concept: gen.plan.concept,
      palette: gen.plan.palette,
      copy: gen.plan.copy,
      layouts: gen.plan.layouts.map((l) => ({
        name: l.name,
        ...(l.rationale ? { rationale: l.rationale } : {}),
      })),
    },
    candidates,
    ranking: gen.ranking,
    winner: gen.winner,
    loop,
    judgments: gen.judgments.map((j) => ({
      round: j.round,
      verdict: j.verdict,
      summary: j.summary,
      findings: j.findings,
      rulesScore: j.rulesScore,
    })),
    final,
    scores: {
      first: candidates.find((c) => c.index === 0)?.recordedScore ?? candidates[0]!.recordedScore,
      bestOfN: winner.recordedScore,
      final: gen.final.report.score,
    },
    rules,
    images: b.images,
    snapshots: b.snapshots,
    durationMs: gen.durationMs,
  };
}

// ---------------------------------------------------------------------------------------------
// Fix runs (and samples): designs start from a fixture, whose image srcs are relative to fixtures/.

const FIX_RULES: RunRules = { attention: true, imageChecks: false };
const fixtureAbs = (s: string) => resolve(FIXTURES, s);
const loadFixture = (id: string) =>
  remapSrcs(
    parseDesign(JSON.parse(readFileSync(join(FIXTURES, `${id}.json`), 'utf8'))),
    fixtureAbs,
  );

async function rulesOnlyLoop(b: Builder, design: Design): Promise<LoopRecord> {
  const result = await runFixLoop(design, {
    editor: createSuggestedFixesEditor(),
    check: (d) => b.original.check(d),
    target: FIX_TARGET,
    maxIterations: FIX_MAX_ITERATIONS,
  });
  return loopRecord(
    b,
    'suggested',
    result.history,
    result.stopReason,
    result.best.iteration,
    (s) => s,
  );
}

interface StrictResults {
  createdAt: string;
  fixtures: {
    fixture: string;
    llm: Record<
      string,
      {
        stopReason: string;
        steps: { iteration: number; status: string; score: number; note?: string }[];
        edits: { iteration: number; op: string; reason?: string }[];
        bestDesign: Design;
      }[]
    >;
  }[];
}

async function buildFix(src: RecordedFixSource | StrictFixSource): Promise<RunRecord> {
  const b = await createBuilder(join(GALLERY, src.id), FIX_RULES, true);
  const design = loadFixture(src.fixture);
  const notes: string[] = [];
  let loop: LoopRecord;
  let recordedAt: string;
  let source: string;
  let model: string;

  if (src.from === 'recorded') {
    source = `apps/web/gallery-src/fix-runs/${src.fixture}.json`;
    const rec = JSON.parse(readFileSync(join(FIX_RUNS, `${src.fixture}.json`), 'utf8')) as {
      createdAt: string;
      modelsSeen: string[];
      ai: {
        editor: string;
        stopReason: string;
        best: { iteration: number };
        history: IterationRecord[];
      };
    };
    recordedAt = rec.createdAt;
    model = rec.modelsSeen.join(', ');
    loop = await loopRecord(
      b,
      rec.ai.editor,
      rec.ai.history,
      rec.ai.stopReason,
      rec.ai.best.iteration,
      fixtureAbs,
    );
    loop.steps.forEach((s) => compare(b, `step ${s.iteration}`, s.recordedScoreAfter, s.snapshot));
    notes.push(
      'Recorded for this gallery on 2026-10-12 with the strict settings: target 100, attention on, max 5 iterations, vision on.',
    );
  } else {
    source = STRICT_RESULTS;
    const strict = JSON.parse(readFileSync(join(ROOT, STRICT_RESULTS), 'utf8')) as StrictResults;
    recordedAt = strict.createdAt;
    model = src.model;
    const run = strict.fixtures.find((f) => f.fixture === src.fixture)!.llm[src.model]![src.run]!;
    const accepted = run.steps.filter((s) => s.status === 'accepted');
    if (accepted.length !== 1 || run.steps.some((s) => s.status === 'rolled-back')) {
      throw new Error(
        `${src.id}: only runs with exactly one accepted step and no rollbacks replay exactly`,
      );
    }
    const before = await snapshot(b, design, 'loop');
    const after = await snapshot(b, remapSrcs(parseDesign(run.bestDesign), fixtureAbs), 'loop');
    const [s0, s1] = [run.steps[0]!, accepted[0]!];
    loop = {
      editor: `anthropic:${src.model}`,
      stopReason: run.stopReason,
      bestIteration: s1.iteration,
      steps: [
        {
          iteration: 0,
          status: 'initial',
          recordedScoreBefore: s0.score,
          recordedScoreAfter: s0.score,
          edits: [],
          snapshot: before,
        },
        {
          iteration: s1.iteration,
          status: 'accepted',
          recordedScoreBefore: s0.score,
          recordedScoreAfter: s1.score,
          edits: run.edits
            .filter((e) => e.iteration === s1.iteration)
            .map((e) => ({ op: e.op, ...(e.reason ? { reason: e.reason } : {}), params: {} })),
          editValuesMissing: true,
          snapshot: after,
        },
      ],
    };
    compare(b, 'before', s0.score, before);
    compare(b, 'after', s1.score, after);
    notes.push(
      "From the strict fix eval (commit db2a50f, 2026-10-07). It kept each edit's op and reason but not its target or values, so the changes shown are computed from the two designs.",
    );
  }

  const rulesLoop = await rulesOnlyLoop(b, design);
  const best = loop.steps.find((s) => s.iteration === loop.bestIteration) ?? loop.steps.at(-1)!;
  const bestReport = b.snapshots[best.snapshot]!.report;
  const solved = bestReport.score >= FIX_TARGET && bestReport.summary.errors === 0;
  await writeThumbnail(b, best.snapshot);
  return {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    id: src.id,
    kind: 'fix',
    title: titleCase(src.fixture),
    fixture: src.fixture,
    canvas: design.canvas,
    outcome: solved ? 'solved' : 'unsolved',
    ...(solved
      ? {}
      : {
          outcomeNote: `The loop stopped at ${bestReport.score} (${loop.stopReason.replace(/-/g, ' ')}); the target was ${FIX_TARGET} with no errors.`,
        }),
    provenance: { source, model, recordedAt, notes: provenanceNotes(b, notes) },
    rank: 0,
    loop,
    rulesLoop,
    final: best.snapshot,
    scores: { first: loop.steps[0]!.recordedScoreAfter, final: best.recordedScoreAfter },
    rules: FIX_RULES,
    images: b.images,
    snapshots: b.snapshots,
  };
}

// ---------------------------------------------------------------------------------------------
// Order: strongest first, then the ones the judge didn't ship or the loop didn't solve.

const OUTCOME_TIER: Record<Outcome, number> = {
  shipped: 0,
  solved: 0,
  'judge-fix': 2,
  unsolved: 2,
  'judge-reject': 3,
};

/**
 * Strongest first: by outcome tier, then final score, then improvement. Within a tier, generate
 * and fix runs alternate (generate first), so the top of the gallery shows both kinds.
 */
export function rankRuns(runs: Pick<RunRecord, 'id' | 'kind' | 'outcome' | 'scores'>[]): string[] {
  type R = (typeof runs)[number];
  const tier = (r: R) =>
    OUTCOME_TIER[r.outcome] + (r.outcome === 'shipped' && r.scores.final < 95 ? 1 : 0);
  const gain = (r: R) => r.scores.final - r.scores.first;
  const byStrength = (a: R, c: R) =>
    c.scores.final - a.scores.final || gain(c) - gain(a) || a.id.localeCompare(c.id);
  const order: string[] = [];
  for (const t of [...new Set(runs.map(tier))].sort((a, c) => a - c)) {
    const inTier = runs.filter((r) => tier(r) === t);
    const generate = inTier.filter((r) => r.kind === 'generate').sort(byStrength);
    const fix = inTier.filter((r) => r.kind === 'fix').sort(byStrength);
    while (generate.length || fix.length) {
      const g = generate.shift();
      const f = fix.shift();
      if (g) order.push(g.id);
      if (f) order.push(f.id);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------------------------
// Samples for /check: every fixture, with its attention outputs and heatmap.

async function buildSamples(runs: RunRecord[]): Promise<GalleryIndex['samples']> {
  rmSync(SAMPLES, { recursive: true, force: true });
  const samples: GalleryIndex['samples'] = [];
  for (const file of readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const id = basename(file, '.json');
    const b = await createBuilder(join(SAMPLES, id), FIX_RULES, true);
    const snap = b.snapshots[await snapshot(b, loadFixture(id), 'loop')]!;
    const run = runs.find((r) => r.fixture === id)?.id;
    const record: SampleRecord = {
      schemaVersion: GALLERY_SCHEMA_VERSION,
      id,
      title: titleCase(id),
      snapshot: snap,
      rules: FIX_RULES,
      images: b.images,
      ...(run ? { run } : {}),
    };
    writeFileSync(join(b.outDir, 'sample.json'), JSON.stringify(record));
    samples.push({ id, title: record.title, canvas: snap.design.canvas, ...(run ? { run } : {}) });
    if (b.webpChanges.length) log(`  sample ${id}: ${b.webpChanges.join('; ')}`);
  }
  return samples;
}

function dirBytes(dir: string, filter: (file: string) => boolean): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    total += st.isDirectory() ? dirBytes(path, filter) : filter(path) ? st.size : 0;
  }
  return total;
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const sources = GALLERY_SOURCES.filter((s) => only.length === 0 || only.includes(s.id));
  if (only.length === 0) rmSync(GALLERY, { recursive: true, force: true });
  const runs: RunRecord[] = [];
  for (const src of sources) {
    const run = src.kind === 'generate' ? await buildGenerate(src) : await buildFix(src);
    runs.push(run);
    if (process.argv.includes('--verbose')) for (const c of webpLog.splice(0)) log(`  webp ${c}`);
    log(
      `${run.id}: ${run.outcome} · ${run.scores.first} → ${run.scores.final} · ${Object.keys(run.snapshots).length} snapshots` +
        (run.provenance.notes.length ? `\n    ${run.provenance.notes.join('\n    ')}` : ''),
    );
  }
  const order = rankRuns(runs);
  for (const run of runs) {
    run.rank = order.indexOf(run.id);
    writeFileSync(join(GALLERY, run.id, 'run.json'), JSON.stringify(run));
  }

  const samples = await buildSamples(runs);
  const entries: GalleryEntry[] = [...runs]
    .sort((a, c) => a.rank - c.rank)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      ...(r.prompt ? { prompt: r.prompt } : {}),
      ...(r.fixture ? { fixture: r.fixture } : {}),
      canvas: r.canvas,
      outcome: r.outcome,
      ...(r.outcomeNote ? { outcomeNote: r.outcomeNote } : {}),
      scores: r.scores,
      rank: r.rank,
      thumbnail: `${r.id}/thumb.webp`,
    }));
  const index: GalleryIndex = {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    builtAt: new Date().toISOString(),
    runs: entries,
    samples,
  };
  writeFileSync(join(GALLERY, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

  const isImage = (f: string) => /\.(webp|png)$/.test(f);
  const isJson = (f: string) => f.endsWith('.json');
  const images = dirBytes(GALLERY, isImage) + dirBytes(SAMPLES, isImage);
  const json = dirBytes(GALLERY, isJson) + dirBytes(SAMPLES, isJson);
  log(
    `\nImages: ${(images / 1024 / 1024).toFixed(2)} MB (budget ${SIZE_BUDGET_BYTES / 1024 / 1024} MB) · JSON: ${(json / 1024 / 1024).toFixed(2)} MB`,
  );
  if (images > SIZE_BUDGET_BYTES) {
    log('Over the size budget.');
    process.exitCode = 1;
  }
  log(`Wrote ${relative(ROOT, GALLERY)} and ${relative(ROOT, SAMPLES)}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
