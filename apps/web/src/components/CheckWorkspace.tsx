'use client';

import { createSuggestedFixesEditor, runFixLoop } from '@simonlunay/redline-agent';
import type { Design } from '@simonlunay/redline';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { checkDesign } from '@/lib/env/design-env';
import { setColor } from '@/lib/edit';
import type {
  GalleryIndex,
  RunRecord,
  RunRules,
  SampleRecord,
  Snapshot,
} from '@/lib/gallery/types';
import { commit, createHistory, redo, replace, undo } from '@/lib/history';
import type { History } from '@/lib/history';
import { modelName } from '@/lib/models';
import type { RuleSetup } from '@/lib/rules';
import { loadSample, runFile, sampleFile, staticRunSource } from '@/lib/run/source';
import { readUpload } from '@/lib/upload';
import { ExportButtons } from './ExportButtons';
import { IssueList } from './IssueList';
import { Score } from './Score';
import { Stage } from './Stage';
import { useDesignEnv } from './useDesignEnv';

/** What's open: a sample, a step of a recorded run, or an uploaded file. */
type Source =
  | { kind: 'sample'; key: string; record: SampleRecord }
  | { kind: 'run'; key: string; record: RunRecord; snapshot: Snapshot }
  | { kind: 'upload'; key: string; name: string; design: Design };

const NO_ATTENTION: RunRules = { attention: false, imageChecks: false };

function sourceDesign(s: Source): Design {
  return s.kind === 'upload'
    ? s.design
    : s.kind === 'sample'
      ? s.record.snapshot.design
      : s.snapshot.design;
}

function sourceSnapshot(s: Source): Snapshot | undefined {
  return s.kind === 'sample' ? s.record.snapshot : s.kind === 'run' ? s.snapshot : undefined;
}

interface RulesOnlyResult {
  from: number;
  to: number;
  iterations: number;
  stopReason: string;
}

const STOP_WORDS: Record<string, string> = {
  'target-reached': 'reached the target',
  'no-issues': 'no issues left',
  'max-iterations': 'hit the iteration limit',
  'no-improvement': 'stopped improving',
  'editor-error': 'the editor failed',
};

export function CheckWorkspace({ index }: { index: GalleryIndex }) {
  const params = useSearchParams();
  const [source, setSource] = useState<Source | null>(null);
  const [history, setHistory] = useState<History<Design> | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const [selectedElement, setSelectedElement] = useState<string | null>(null);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rulesOnly, setRulesOnly] = useState<RulesOnlyResult | null>(null);
  const [fixing, setFixing] = useState(false);
  const [aiRun, setAiRun] = useState<RunRecord | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const open = useCallback((next: Source) => {
    setSource(next);
    setHistory(createHistory(sourceDesign(next)));
    setSelectedElement(null);
    setSelectedIssue(null);
    setRulesOnly(null);
    setError(null);
  }, []);

  // Open what the URL asks for: ?sample=<id>, ?run=<id>&snapshot=<id>, or the first sample.
  const sampleId = params.get('sample');
  const runId = params.get('run');
  const snapshotId = params.get('snapshot');
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      if (runId) {
        for await (const record of staticRunSource.open(runId, controller.signal)) {
          const snapshot =
            record.snapshots[snapshotId ?? record.final] ?? record.snapshots[record.final]!;
          open({ kind: 'run', key: `run:${runId}`, record, snapshot });
        }
      } else {
        const id = sampleId ?? 'worst';
        open({
          kind: 'sample',
          key: `sample:${id}`,
          record: await loadSample(id, controller.signal),
        });
      }
    })().catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    });
    return () => controller.abort();
  }, [sampleId, runId, snapshotId, open]);

  // The recorded AI run for this sample, for the side-by-side with the rules-only loop.
  const pairedRun = source?.kind === 'sample' ? source.record.run : undefined;
  useEffect(() => {
    setAiRun(null);
    if (!pairedRun) return;
    const controller = new AbortController();
    (async () => {
      for await (const record of staticRunSource.open(pairedRun, controller.signal))
        setAiRun(record);
    })().catch(() => undefined);
    return () => controller.abort();
  }, [pairedRun]);

  const srcs = useMemo(() => {
    if (!source) return [];
    if (source.kind === 'upload') {
      return source.design.elements.flatMap((el) => (el.type === 'image' ? [el.src] : []));
    }
    return Object.keys(source.record.images);
  }, [source]);
  const url = useCallback(
    (src: string) => {
      if (!source || source.kind === 'upload') return src;
      return source.kind === 'sample'
        ? sampleFile(source.record.id, src)
        : runFile(source.record.id, src);
    },
    [source],
  );
  const { env, errors: imageErrors } = useDesignEnv(
    source?.key ?? null,
    srcs,
    url,
    source && source.kind !== 'upload' ? source.record.images : undefined,
  );

  const design = history?.present;
  const original = source ? sourceDesign(source) : undefined;
  const checked = useDeferredValue(design);

  const setup: RuleSetup | null = useMemo(() => {
    if (!source || !checked || !original) return null;
    const snap = sourceSnapshot(source);
    const rules = source.kind === 'upload' ? NO_ATTENTION : source.record.rules;
    const planned =
      source.kind === 'run' && source.snapshot.ruleSet === 'loop' && source.record.rules.keyElements
        ? source.record.snapshots[source.record.rules.keyElements.snapshot]?.design
        : undefined;
    return {
      rules,
      ...(snap?.attention ? { frozenAttention: snap.attention } : {}),
      ...(planned ? { plannedDesign: planned } : {}),
      edited: checked !== original && JSON.stringify(checked) !== JSON.stringify(original),
    };
  }, [source, checked, original]);

  const live = useMemo(
    () => (env && checked && setup ? checkDesign(checked, env, setup) : null),
    [env, checked, setup],
  );

  // Undo and redo from anywhere on the page.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        setHistory((h) => (h ? undo(h) : h));
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        setHistory((h) => (h ? redo(h) : h));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A drag is one undo step: its first move commits, the rest amend that entry.
  const dragging = useRef(false);
  const onEdit = useCallback((next: Design, done: boolean) => {
    const amend = dragging.current;
    dragging.current = !done;
    setHistory((h) => (h ? (amend ? replace(h, next) : commit(h, next)) : h));
  }, []);

  async function onUpload(file: File) {
    const text = await file.text();
    const result = readUpload(text, file.size);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    open({
      kind: 'upload',
      key: `upload:${file.name}:${file.size}:${file.lastModified}`,
      name: file.name,
      design: result.design,
    });
  }

  async function fixWithRules() {
    if (!design || !env || !setup) return;
    setFixing(true);
    try {
      // Layout and image rules only: the attention rules need the saliency model, which this
      // site doesn't ship, and the stored attention results only fit the unedited design.
      const loopSetup: RuleSetup = { ...setup, edited: true };
      const result = await runFixLoop(design, {
        editor: createSuggestedFixesEditor(),
        check: async (d) => checkDesign(d, env, loopSetup).report,
        target: 100,
        maxIterations: 5,
      });
      setHistory((h) => (h ? commit(h, result.best.design) : h));
      setRulesOnly({
        from: result.initial.report.score,
        to: result.best.report.score,
        iterations: result.totals.iterations,
        stopReason: result.stopReason,
      });
    } finally {
      setFixing(false);
    }
  }

  const selected = design?.elements.find((el) => el.id === selectedElement);
  const selectedColor =
    selected?.type === 'text'
      ? selected.color
      : selected?.type === 'shape'
        ? selected.fill
        : undefined;
  const snap = source ? sourceSnapshot(source) : undefined;
  const heatmapUrl =
    snap?.heatmap && source?.kind === 'sample'
      ? sampleFile(source.record.id, snap.heatmap)
      : snap?.heatmap && source?.kind === 'run'
        ? runFile(source.record.id, snap.heatmap)
        : undefined;
  const edited = setup?.edited ?? false;
  const name =
    source?.kind === 'upload'
      ? source.name.replace(/\.json$/i, '')
      : source?.kind === 'sample'
        ? source.record.id
        : (source?.record.id ?? 'design');

  return (
    <div className="workspace">
      <div className="workspace-bar">
        <label className="field">
          <span className="label">Sample design</span>
          <select
            value={source?.kind === 'sample' ? source.record.id : ''}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              loadSample(id)
                .then((record) => open({ kind: 'sample', key: `sample:${id}`, record }))
                .catch((err: unknown) => setError(String(err)));
            }}
          >
            {source?.kind !== 'sample' ? <option value="">Choose a sample</option> : null}
            {index.samples.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} ({s.canvas.width}×{s.canvas.height})
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="label">Or your own</span>
          <button
            type="button"
            className="button secondary"
            onClick={() => fileInput.current?.click()}
          >
            Open a design JSON
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onUpload(file);
              e.target.value = '';
            }}
          />
        </div>
        <div className="field grow">
          <span className="label">Edit</span>
          <div className="row">
            <button
              type="button"
              className="button secondary"
              disabled={!history?.past.length}
              onClick={() => setHistory((h) => (h ? undo(h) : h))}
            >
              Undo
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!history?.future.length}
              onClick={() => setHistory((h) => (h ? redo(h) : h))}
            >
              Redo
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!edited}
              onClick={() => original && setHistory((h) => (h ? commit(h, original) : h))}
            >
              Revert
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {imageErrors.size ? (
        <p className="alert" role="alert">
          {imageErrors.size} {imageErrors.size === 1 ? 'image' : 'images'} couldn&apos;t be loaded
          and {imageErrors.size === 1 ? 'is' : 'are'} drawn as a crossed box:{' '}
          {[...imageErrors.values()][0]}
        </p>
      ) : null}

      {design ? (
        <div className="player">
          <div className="player-main">
            <Stage
              design={design}
              env={env}
              issues={live?.report.issues ?? []}
              {...(heatmapUrl ? { heatmapUrl } : {})}
              showHeatmap={showHeatmap}
              heatmapOpacity={edited ? 0.45 : 0.85}
              selectedIssue={selectedIssue}
              onSelectIssue={setSelectedIssue}
              editable
              selectedElement={selectedElement}
              onSelectElement={setSelectedElement}
              onEdit={onEdit}
              label={`Design ${name}, editable`}
              maxHeight="62vh"
            />
            <div className="player-controls">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showHeatmap}
                  disabled={!heatmapUrl}
                  onChange={(e) => setShowHeatmap(e.target.checked)}
                />
                Predicted attention{edited && heatmapUrl ? ' (of the original design)' : ''}
              </label>
              <span className="note">
                Drag to move, drag a corner to resize (Shift keeps the ratio), arrow keys nudge.
              </span>
            </div>
          </div>
          <aside className="player-side">
            <div className="panel">
              {live ? (
                <Score report={live.report} caption="Live score, re-checked on every edit" />
              ) : (
                <p className="note">Loading fonts and images…</p>
              )}
              <p className="note">
                {live?.attentionPaused === 'edited'
                  ? 'Layout rules only now: the attention rules need the saliency model, and the stored attention results only fit the unedited design. Undo back to it to see them again.'
                  : live?.attentionPaused === 'no-heatmap'
                    ? 'Layout rules only: attention needs the saliency model. Run redline check --attention locally.'
                    : source?.kind === 'upload'
                      ? 'Layout rules. For predicted attention, run: npx redline check design.json --attention --heatmap heatmap.png'
                      : 'Layout and attention rules, as the recorded run checked it.'}
              </p>
              {selected ? (
                <div className="inspector">
                  <div className="label">Selected</div>
                  <div>
                    <strong>{selected.id}</strong>{' '}
                    <span className="muted">{selected.role ?? selected.type}</span>
                  </div>
                  <div className="muted">
                    {Math.round(selected.x)}, {Math.round(selected.y)}, {Math.round(selected.width)}
                    ×{Math.round(selected.height)}
                  </div>
                  {selectedColor ? (
                    <label className="toggle">
                      <input
                        type="color"
                        value={selectedColor.slice(0, 7)}
                        onChange={(e) =>
                          setHistory((h) =>
                            h ? commit(h, setColor(h.present, selected.id, e.target.value)) : h,
                          )
                        }
                      />
                      {selected.type === 'text' ? 'Text color' : 'Fill'} {selectedColor}
                    </label>
                  ) : null}
                </div>
              ) : null}
              <div className="fix-box">
                <button
                  type="button"
                  className="button"
                  disabled={!env || fixing || !live?.report.issues.length}
                  onClick={() => void fixWithRules()}
                >
                  {fixing ? 'Fixing…' : 'Fix it with the rules (no AI)'}
                </button>
                <p className="note">
                  Loops the checker&apos;s own suggested fixes in your browser, with the same
                  rollback as the AI loop. No model, no network.
                </p>
                {rulesOnly ? (
                  <p className="note" role="status">
                    Rules only: {rulesOnly.from} → <strong>{rulesOnly.to}</strong> in{' '}
                    {rulesOnly.iterations} {rulesOnly.iterations === 1 ? 'iteration' : 'iterations'}
                    , {STOP_WORDS[rulesOnly.stopReason] ?? rulesOnly.stopReason}. Undo to go back.
                  </p>
                ) : null}
                {aiRun ? <AiComparison run={aiRun} /> : null}
              </div>
              <h3>Issues</h3>
              <IssueList
                issues={live?.report.issues ?? []}
                selected={selectedIssue}
                onSelect={setSelectedIssue}
              />
              <div className="row">
                <ExportButtons design={design} env={env} url={url} name={name} />
              </div>
            </div>
          </aside>
        </div>
      ) : (
        <p className="note">Loading…</p>
      )}
    </div>
  );
}

function AiComparison({ run }: { run: RunRecord }) {
  const best = (loop: RunRecord['loop']) => {
    const step = loop.steps.find((s) => s.iteration === loop.bestIteration) ?? loop.steps.at(-1)!;
    return run.snapshots[step.snapshot]!.report.score;
  };
  return (
    <div className="compare small">
      <div className="compare-col">
        <div className="label">Recorded, rules only</div>
        <div className="compare-score">
          {run.loop.steps[0]!.recordedScoreAfter} →{' '}
          <strong>{run.rulesLoop ? best(run.rulesLoop) : '–'}</strong>
        </div>
      </div>
      <div className="compare-col">
        <div className="label">Recorded, {modelName(run.provenance.model)}</div>
        <div className="compare-score">
          {run.loop.steps[0]!.recordedScoreAfter} → <strong>{best(run.loop)}</strong>
        </div>
      </div>
      <p className="note">
        With attention rules on, as recorded.{' '}
        <Link href={`/runs/${run.id}/`}>Watch the AI run</Link>
      </p>
    </div>
  );
}
