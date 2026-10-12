'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { asset } from '@/lib/base-path';
import { diffDesigns } from '@/lib/diff';
import type { DesignEnv } from '@/lib/env/design-env';
import type {
  EditRecord,
  JudgmentRecord,
  LoopRecord,
  RunRecord,
  StepRecord,
} from '@/lib/gallery/types';
import { modelName } from '@/lib/models';
import { runFile } from '@/lib/run/source';
import { buildTimeline } from '@/lib/run/timeline';
import type { Frame } from '@/lib/run/timeline';
import { ExportButtons } from './ExportButtons';
import { IssueList } from './IssueList';
import { Score } from './Score';
import { Stage } from './Stage';
import { Thumb } from './Thumb';
import { Timeline } from './Timeline';
import { useDesignEnv } from './useDesignEnv';

const OP_LABEL: Record<string, string> = {
  move: 'Move',
  resize: 'Resize',
  setColor: 'Recolor',
  setFontSize: 'Font size',
  setFontWeight: 'Font weight',
  setOpacity: 'Opacity',
  insertShape: 'Add a backing shape',
  regenerateImage: 'Regenerate the image',
  replaceText: 'Replace text',
  setShadow: 'Contact shadow',
};

function describeEdit(e: EditRecord): string {
  const p = e.params;
  const target = e.elementId ? ` ${e.elementId}` : '';
  switch (e.op) {
    case 'move':
      return `Move${target} by ${Math.round(Number(p.dx))}, ${Math.round(Number(p.dy))}`;
    case 'resize':
      return `Resize${target} to ${Math.round(Number(p.width))}×${Math.round(Number(p.height))}`;
    case 'setColor':
      return `Recolor${target} to ${String(p.color)}`;
    case 'setFontSize':
      return `Set${target} font size to ${String(p.fontSize)}`;
    case 'setFontWeight':
      return `Set${target} weight to ${String(p.fontWeight)}`;
    case 'setOpacity':
      return `Set${target} opacity to ${String(p.opacity)}`;
    case 'insertShape':
      return `Add a ${String(p.kind ?? 'shape')} behind ${String(p.behindElementId ?? 'an element')}`;
    case 'setShadow':
      return `Set${target} shadow to ${String(p.opacity)}`;
    case 'replaceText':
      return `Replace “${String(p.find)}” in${target} with “${String(p.replace)}”`;
    default:
      return `${OP_LABEL[e.op] ?? e.op}${target}`;
  }
}

const VERDICT_WORDS: Record<JudgmentRecord['verdict'], string> = {
  ship: 'Ship it',
  fix: 'Needs fixes',
  reject: 'Reject',
};

export const OUTCOME_WORDS: Record<RunRecord['outcome'], string> = {
  shipped: 'The judge would ship it',
  'judge-fix': 'The judge still asked for fixes',
  'judge-reject': 'The judge rejected it',
  solved: 'Every rule passes',
  unsolved: 'Not solved',
};

function StepPanel({ record, step }: { record: RunRecord; step: StepRecord }) {
  const status: Record<StepRecord['status'], string> = {
    initial: 'Before',
    accepted: 'Accepted',
    'rolled-back': 'Rolled back',
    invalid: 'Invalid response',
    'no-change': 'No change',
  };
  const loop = record.loop;
  const prior = [...loop.steps]
    .slice(0, loop.steps.indexOf(step))
    .reverse()
    .find((s) => s.status === 'accepted' || s.status === 'initial');
  const changes =
    step.editValuesMissing && prior
      ? diffDesigns(
          record.snapshots[prior.snapshot]!.design,
          record.snapshots[step.snapshot]!.design,
        )
      : [];
  if (step.status === 'initial') {
    return (
      <div className="panel">
        <h2>The design as given</h2>
        <p className="note">
          {record.kind === 'fix'
            ? `One of Redline's test designs, ${record.title.toLowerCase()}. The fixer gets the issues below, the checker's suggested fixes, a table of the layout and an annotated render.`
            : 'The winning candidate, before the fix loop.'}
        </p>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="label">
        Fix {step.iteration} of {loop.steps.length - 1}
      </div>
      <h2>
        {status[step.status]}: {step.recordedScoreBefore} → {step.recordedScoreAfter}
      </h2>
      {step.summary ? <p>{step.summary}</p> : null}
      {step.note ? <p className="note">{step.note}</p> : null}
      {step.edits.length ? (
        <>
          <h3>
            {step.edits.length} {step.edits.length === 1 ? 'edit' : 'edits'}
            {step.editValuesMissing ? ', with the reasons as recorded' : ''}
          </h3>
          <ul className="edits">
            {step.edits.map((e, i) => (
              <li key={i} className={step.status === 'rolled-back' ? 'rejected' : ''}>
                <span>
                  {step.editValuesMissing ? (
                    <span className="edit-op">{OP_LABEL[e.op] ?? e.op}</span>
                  ) : (
                    <span className="edit-op">{describeEdit(e)}</span>
                  )}
                  {e.reason ? <span className="muted">: {e.reason}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {changes.length ? (
        <>
          <h3>What changed, computed from the two designs</h3>
          <ul className="edits">
            {changes.map((c) => (
              <li key={c.id}>
                <span>
                  <span className="edit-op">{c.id}</span>
                  <span className="muted">: {c.changes.join(', ')}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function JudgePanel({ judgment }: { judgment: JudgmentRecord }) {
  return (
    <div className="panel">
      <div className="label">Vision judge, review {judgment.round + 1} (Claude Opus 5.5)</div>
      <div>
        <span className={`verdict ${judgment.verdict}`}>{VERDICT_WORDS[judgment.verdict]}</span>
      </div>
      <p>{judgment.summary}</p>
      {judgment.findings.length ? (
        <ol className="findings">
          {judgment.findings.map((f, i) => (
            <li key={i}>
              <span className="finding-n">J{i + 1}</span>
              <span>
                <span className="edit-op">
                  {f.severity === 'high' ? 'High' : f.severity === 'medium' ? 'Medium' : 'Low'},{' '}
                  {f.category}
                </span>
                <span className="muted">: {f.description}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="note">
        The judge sees the clean render, the element table and the open rule issues. It never sees
        the fixer&apos;s reasoning or any score.
      </p>
    </div>
  );
}

function LoopSummary({
  loop,
  record,
  title,
}: {
  loop: LoopRecord;
  record: RunRecord;
  title: string;
}) {
  const best = loop.steps.find((s) => s.iteration === loop.bestIteration) ?? loop.steps.at(-1)!;
  const report = record.snapshots[best.snapshot]!.report;
  return (
    <div className="compare-col">
      <div className="label">{title}</div>
      <div className="compare-score">
        {loop.steps[0]!.recordedScoreAfter} → <strong>{report.score}</strong>
      </div>
      <div className="note">
        {report.summary.errors} errors, {report.summary.warnings} warnings, {loop.steps.length - 1}{' '}
        {loop.steps.length === 2 ? 'iteration' : 'iterations'}
      </div>
    </div>
  );
}

function FinalPanel({ record }: { record: RunRecord }) {
  return (
    <div className="panel">
      <div className="label">Result</div>
      <h2>{OUTCOME_WORDS[record.outcome]}</h2>
      {record.outcomeNote ? <p>{record.outcomeNote}</p> : null}
      {record.kind === 'generate' ? (
        <dl className="facts">
          <div>
            <dt>First candidate</dt>
            <dd>{record.scores.first}</dd>
          </div>
          <div>
            <dt>Best of {record.candidates?.length ?? 4}</dt>
            <dd>{record.scores.bestOfN}</dd>
          </div>
          <div>
            <dt>After the fix loop</dt>
            <dd>{record.scores.final}</dd>
          </div>
        </dl>
      ) : record.rulesLoop ? (
        <div className="compare">
          <LoopSummary
            loop={record.loop}
            record={record}
            title={`AI fix loop, ${modelName(record.provenance.model)}`}
          />
          <LoopSummary loop={record.rulesLoop} record={record} title="Rules only, no AI" />
        </div>
      ) : null}
      {record.kind === 'generate' ? (
        <p className="note">
          Scores recorded during the run include the judge&apos;s findings, so they can differ from
          the rules score on the stage.
        </p>
      ) : (
        <p className="note">
          &ldquo;Rules only&rdquo; loops the checker&apos;s own suggested fixes with the same
          checker and target. It&apos;s what the loop does without a model.
        </p>
      )}
      <details className="provenance">
        <summary>Where this run comes from</summary>
        <p className="note">
          Recorded {new Date(record.provenance.recordedAt).toISOString().slice(0, 10)}
          {record.provenance.model
            ? `, ${record.kind === 'fix' ? modelName(record.provenance.model) : record.provenance.model}`
            : ''}
          . Data: <code>{record.provenance.source}</code>.
        </p>
        {record.provenance.notes.map((n, i) => (
          <p key={i} className="note">
            {n}
          </p>
        ))}
      </details>
    </div>
  );
}

function PlanPanel({ record }: { record: RunRecord }) {
  const plan = record.plan!;
  return (
    <div className="panel">
      <div className="label">Art director (Claude Sonnet 5.5)</div>
      <h2>The plan</h2>
      <p>{plan.concept}</p>
      <div className="swatches" aria-label="Palette">
        {Object.entries(plan.palette).map(([name, hex]) => (
          <span
            key={name}
            className="swatch"
            style={{ background: hex }}
            title={`${name} ${hex}`}
          />
        ))}
      </div>
      <dl className="copy">
        {Object.entries(plan.copy).map(([k, v]) =>
          v ? (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ) : null,
        )}
      </dl>
      <div>
        <h3>{plan.layouts.length} layouts to try</h3>
        <ul className="plain">
          {plan.layouts.map((l) => (
            <li key={l.name}>{l.name}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CandidatesPanel({
  record,
  frame,
  env,
  onPick,
}: {
  record: RunRecord;
  frame: Frame;
  env: DesignEnv<ImageBitmap> | null;
  onPick: (i: number) => void;
}) {
  const candidates = record.candidates ?? [];
  const winner = frame.kind !== 'candidate';
  return (
    <div className="panel">
      <div className="label">Best of {candidates.length}</div>
      <h2>
        {winner
          ? `Winner: candidate ${(record.winner ?? 0) + 1}`
          : `Candidate ${frame.revealed} of ${candidates.length}`}
      </h2>
      <p className="note">
        {winner
          ? 'Picked by the rules: highest score, then fewest errors, then fewest warnings, then the most attention on the call to action.'
          : 'Each candidate is a layout from the plan with its own generated background, checked with the layout, attention and image rules.'}
      </p>
      <ol className="candidates">
        {candidates.slice(0, frame.revealed).map((c, i) => (
          <li
            key={c.index}
            className={`${frame.candidate === i ? 'current' : ''}${winner && c.index === record.winner ? ' won' : ''}`}
          >
            <button
              type="button"
              onClick={() => onPick(i)}
              aria-label={`Candidate ${c.index + 1}, score ${c.recordedScore}`}
            >
              <Thumb
                design={record.snapshots[c.snapshot]!.design}
                env={env}
                width={88}
                label={`Candidate ${c.index + 1}`}
              />
              <span className="candidate-score">{c.recordedScore}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Player({
  record,
  autoplay = false,
  loop = false,
  compact = false,
}: {
  record: RunRecord;
  autoplay?: boolean;
  /** Start over at the end (the landing page's demo). */
  loop?: boolean;
  /** Stage and timeline only (the landing page). */
  compact?: boolean;
}) {
  const frames = useMemo(() => buildTimeline(record), [record]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(autoplay);
  const [speed, setSpeed] = useState(1);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const srcs = useMemo(() => Object.keys(record.images), [record]);
  const url = useCallback((src: string) => runFile(record.id, src), [record.id]);
  const { env } = useDesignEnv(record.id, srcs, url, record.images);

  // Deep links: ?frame=<n> (1-based) and ?heatmap=1 open a run at that moment.
  useEffect(() => {
    if (compact) return;
    const params = new URLSearchParams(window.location.search);
    const n = Number(params.get('frame'));
    if (Number.isInteger(n) && n >= 1 && n <= frames.length) {
      setIndex(n - 1);
      setPlaying(false);
    }
    if (params.get('heatmap') === '1') setShowHeatmap(true);
  }, [compact, frames.length]);

  const frame = frames[index]!;
  const lastSnapshot = useMemo(() => {
    for (let i = index; i >= 0; i--) if (frames[i]!.snapshot) return frames[i]!.snapshot!;
    return record.loop.steps[0]?.snapshot ?? record.final;
  }, [frames, index, record]);
  const snap = record.snapshots[lastSnapshot]!;
  const previous = frame.previous ? record.snapshots[frame.previous]?.design : undefined;
  const judgment = frame.kind === 'judge' ? record.judgments![frame.judgment!] : undefined;

  useEffect(() => {
    if (!playing || !env) return;
    const id = setTimeout(() => {
      if (index < frames.length - 1) setIndex(index + 1);
      else if (loop) setIndex(0);
      else setPlaying(false);
    }, frame.holdMs / speed);
    return () => clearTimeout(id);
  }, [playing, env, index, frames.length, frame.holdMs, speed, loop]);

  const scores = useMemo(
    () => frames.map((f) => (f.snapshot ? record.snapshots[f.snapshot]!.report.score : undefined)),
    [frames, record],
  );

  const seek = (i: number) => {
    setIndex(i);
    setPlaying(false);
  };

  const stage = (
    <Stage
      design={snap.design}
      env={env}
      issues={snap.report.issues}
      {...(previous ? { previous } : {})}
      {...(judgment ? { judgeFindings: judgment.findings } : {})}
      {...(snap.heatmap ? { heatmapUrl: runFile(record.id, snap.heatmap) } : {})}
      showHeatmap={showHeatmap}
      showIssues={frame.kind !== 'plan'}
      selectedIssue={selectedIssue}
      onSelectIssue={setSelectedIssue}
      maxHeight={compact ? '58vh' : '58vh'}
      dimmed={frame.kind === 'plan'}
      label={`${record.title}: ${frame.label}`}
    />
  );

  const controls = (
    <div className="player-controls">
      <Timeline
        frames={frames}
        index={index}
        scores={scores}
        playing={playing}
        speed={speed}
        onSeek={seek}
        onTogglePlay={() => {
          if (!playing && index === frames.length - 1) setIndex(0);
          setPlaying(!playing);
        }}
        onSpeed={setSpeed}
      />
      <label className="toggle">
        <input
          type="checkbox"
          checked={showHeatmap}
          onChange={(e) => setShowHeatmap(e.target.checked)}
          disabled={!snap.heatmap}
        />
        Predicted attention
      </label>
    </div>
  );

  if (compact) {
    return (
      <div className="player compact">
        {stage}
        <div className="compact-bar">
          <Score report={snap.report} caption={frame.label} />
          {controls}
        </div>
      </div>
    );
  }

  return (
    <div className="player">
      <div className="player-main">
        {stage}
        {controls}
      </div>
      <aside className="player-side">
        {frame.kind === 'plan' ? <PlanPanel record={record} /> : null}
        {frame.kind === 'candidate' || frame.kind === 'winner' ? (
          <CandidatesPanel
            record={record}
            frame={frame}
            env={env}
            onPick={(i) =>
              seek(frames.findIndex((f) => f.kind === 'candidate' && f.candidate === i))
            }
          />
        ) : null}
        {judgment ? <JudgePanel judgment={judgment} /> : null}
        {frame.kind === 'step' ? (
          <StepPanel record={record} step={record.loop.steps[frame.step!]!} />
        ) : null}
        {frame.kind === 'final' ? <FinalPanel record={record} /> : null}
        {frame.kind !== 'plan' ? (
          <div className="panel">
            <Score report={snap.report} caption="Rules score of the design on the stage" />
            {snap.report.issues.length ? <h3>Issues</h3> : null}
            <IssueList
              issues={snap.report.issues}
              selected={selectedIssue}
              onSelect={setSelectedIssue}
            />
            <div className="row">
              <Link
                className="button secondary"
                href={`/check/?run=${record.id}&snapshot=${snap.id}`}
              >
                Open in the editor
              </Link>
              <ExportButtons design={snap.design} env={env} url={url} name={record.id} />
            </div>
          </div>
        ) : null}
        <p className="note links">
          <Link href="/gallery/">All runs</Link>
          <a href={asset(`gallery/${record.id}/run.json`)}>This run&apos;s data (JSON)</a>
        </p>
      </aside>
    </div>
  );
}
