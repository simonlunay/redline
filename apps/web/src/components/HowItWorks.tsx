import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { diffDesigns } from '@/lib/diff';
import type { Design, RunRecord } from '@/lib/gallery/types';
import { modelName } from '@/lib/models';
import { runFile } from '@/lib/run/source';
import { buildTimeline } from '@/lib/run/timeline';
import type { Frame } from '@/lib/run/timeline';

type Box = { x: number; y: number; width: number; height: number };

function boxStyle(box: Box, design: Design): CSSProperties {
  const { width: W, height: H } = design.canvas;
  return {
    left: `${(box.x / W) * 100}%`,
    top: `${(box.y / H) * 100}%`,
    width: `${(box.width / W) * 100}%`,
    height: `${(box.height / H) * 100}%`,
  };
}

/** A recorded snapshot as a static thumbnail, with optional marks on top. */
function Proof({
  record,
  snapshot,
  marks = [],
  ring = false,
}: {
  record: RunRecord;
  snapshot: string;
  marks?: { box: Box; kind: 'edit' | 'judge'; label?: string }[];
  ring?: boolean;
}) {
  const snap = record.snapshots[snapshot]!;
  return (
    <span
      className={`proof${ring ? ' ring' : ''}`}
      style={{ aspectRatio: `${snap.design.canvas.width} / ${snap.design.canvas.height}` }}
    >
      <img
        src={runFile(record.id, snap.thumbnail!)}
        alt=""
        width={snap.design.canvas.width}
        height={snap.design.canvas.height}
        loading="lazy"
      />
      {marks.map((m, i) => (
        <span key={i} className={`mark ${m.kind}`} style={boxStyle(m.box, snap.design)}>
          {m.label ? <span className="badge">{m.label}</span> : null}
        </span>
      ))}
    </span>
  );
}

interface Stage {
  title: string;
  line: ReactNode;
  visual: ReactNode;
  /** 1-based frame of the replay this stage links to, and extra query. */
  frame: number;
  query?: string;
}

const first = (frames: Frame[], test: (f: Frame) => boolean) => frames.findIndex(test) + 1;

/** The generate pipeline, stage by stage, from one recorded run. */
export function HowItWorks({ record }: { record: RunRecord }) {
  const frames = buildTimeline(record);
  const candidates = record.candidates ?? [];
  const winner = candidates.find((c) => c.index === record.winner)!;
  const winnerDesign = record.snapshots[record.loop.steps[0]!.snapshot]!.design;
  const plan = record.plan!;
  const review = record.judgments?.find((j) => j.round === 0);
  const finding = review?.findings[0];
  const fix = record.loop.steps.find((s) => s.status === 'accepted');
  const lastReview = record.judgments?.at(-1);
  const images = winnerDesign.elements.flatMap((el) => (el.type === 'image' ? [el] : []));
  const background = images.find((el) => el.role === 'background');
  const subject = images.find((el) => el.role !== 'background');
  const elementBox = (design: Design, id?: string) => {
    const el = design.elements.find((e) => e.id === id);
    return el ? { x: el.x, y: el.y, width: el.width, height: el.height } : undefined;
  };

  const stages: Stage[] = [
    {
      title: 'Prompt',
      line: (
        <>
          One line of text, and a size ({record.canvas.width}×{record.canvas.height}). Everything
          below is what the pipeline did with it.
        </>
      ),
      visual: <span className="stage-prompt">“{record.prompt}”</span>,
      frame: first(frames, (f) => f.kind === 'prompt'),
    },
    {
      title: 'Art director plans it',
      line: (
        <>
          {modelName('claude-sonnet-5-5')} writes the copy, picks a palette, drafts{' '}
          {plan.layouts.length} layouts and a brief for every image.
        </>
      ),
      visual: (
        <span className="stage-plan">
          <span className="swatches small">
            {Object.entries(plan.palette).map(([name, hex]) => (
              <span key={name} className="swatch" style={{ background: hex }} />
            ))}
          </span>
          <span className="stage-plan-copy">{plan.copy.headline}</span>
        </span>
      ),
      frame: first(frames, (f) => f.kind === 'plan'),
    },
    {
      title: 'Images are generated and cut out',
      line: (
        <>
          FLUX.1 schnell paints the backgrounds and the subject, asked to leave the text areas calm
          and draw no lettering; BiRefNet cuts the subject out. The copy stays separate, editable
          text.
        </>
      ),
      visual: (
        <span className="stage-images">
          {background ? (
            <img
              src={runFile(record.id, background.src)}
              alt="Generated background"
              loading="lazy"
            />
          ) : null}
          {subject ? (
            <span className="cutout">
              <img src={runFile(record.id, subject.src)} alt="Cut-out subject" loading="lazy" />
            </span>
          ) : null}
        </span>
      ),
      frame: first(frames, (f) => f.kind === 'candidate'),
    },
    {
      title: `${candidates.length} candidates are scored`,
      line: (
        <>
          Each layout and background is checked by the layout rules and an attention model:{' '}
          {candidates.map((c) => c.recordedScore).join(', ')}.
        </>
      ),
      visual: (
        <span className="stage-fan">
          {candidates.map((c) => (
            <span key={c.index} className="fan-card">
              <Proof record={record} snapshot={c.snapshot} />
              <span className="fan-score">{c.recordedScore}</span>
            </span>
          ))}
        </span>
      ),
      frame: first(frames, (f) => f.kind === 'candidate' && f.revealed === candidates.length),
      query: '&heatmap=1',
    },
    {
      title: 'The best one is picked',
      line: (
        <>
          Highest score, then fewest errors: candidate {winner.index + 1}, at {winner.recordedScore}
          .
        </>
      ),
      visual: <Proof record={record} snapshot={winner.snapshot} ring />,
      frame: first(frames, (f) => f.kind === 'winner'),
    },
    {
      title: 'A vision judge reviews it',
      line: finding ? (
        <>
          {modelName('claude-opus-5-5')} looks at the render and finds what the rules can&apos;t: “
          {finding.description.split('. ')[0]}.”
        </>
      ) : (
        <>{modelName('claude-opus-5-5')} looks at the render.</>
      ),
      visual: (
        <Proof
          record={record}
          snapshot={record.loop.steps[0]!.snapshot}
          marks={
            finding && (finding.box ?? elementBox(winnerDesign, finding.elementId))
              ? [
                  {
                    box: (finding.box ?? elementBox(winnerDesign, finding.elementId))!,
                    kind: 'judge',
                    label: 'J1',
                  },
                ]
              : []
          }
        />
      ),
      frame: first(
        frames,
        (f) => f.kind === 'judge' && record.judgments![f.judgment!]!.round === 0,
      ),
    },
    ...(fix
      ? [
          {
            title: 'The fix loop repairs it',
            line: (
              <>
                {fix.summary ?? 'Layout edits'} ({fix.recordedScoreBefore} →{' '}
                {fix.recordedScoreAfter})
              </>
            ),
            visual: (
              <Proof
                record={record}
                snapshot={fix.snapshot}
                marks={diffDesigns(winnerDesign, record.snapshots[fix.snapshot]!.design).flatMap(
                  (c) => {
                    const box = elementBox(record.snapshots[fix.snapshot]!.design, c.id);
                    return box ? [{ box, kind: 'edit' as const }] : [];
                  },
                )}
              />
            ),
            frame: first(frames, (f) => f.kind === 'step' && f.status === 'accepted'),
          },
        ]
      : []),
    {
      title: lastReview?.verdict === 'ship' ? 'The judge ships it' : 'The judge reviews it again',
      line: <>{lastReview?.summary ?? record.outcomeNote}</>,
      visual: (
        <span className="stage-ship">
          <Proof record={record} snapshot={record.final} />
          {lastReview ? (
            <span className={`verdict ${lastReview.verdict}`}>
              {lastReview.verdict === 'ship' ? 'Ship it' : 'Needs fixes'}
            </span>
          ) : null}
        </span>
      ),
      frame: frames.length,
    },
  ];

  return (
    <ol className="pipeline">
      {stages.map((s, i) => (
        <li key={s.title}>
          <Link
            className="pipeline-visual"
            href={`/runs/${record.id}/?frame=${s.frame}${s.query ?? ''}`}
            aria-label={`${s.title}: see this moment in the replay`}
          >
            {s.visual}
          </Link>
          <div className="pipeline-text">
            <h3>
              <span className="pipeline-n">{i + 1}</span>
              {s.title}
            </h3>
            <p>{s.line}</p>
            <Link
              href={`/runs/${record.id}/?frame=${s.frame}${s.query ?? ''}`}
              className="pipeline-link"
            >
              See it in the replay
            </Link>
          </div>
        </li>
      ))}
    </ol>
  );
}
