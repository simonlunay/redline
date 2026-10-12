'use client';

import type { Design, DesignElement, Issue } from '@simonlunay/redline';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { diffDesigns } from '@/lib/diff';
import { hitTest, moveBy, setBox } from '@/lib/edit';
import { drawDesign } from '@/lib/env/design-env';
import type { DesignEnv } from '@/lib/env/design-env';
import type { JudgeFindingRecord } from '@/lib/gallery/types';
import { useHeatmap } from './useHeatmap';

type Box = { x: number; y: number; width: number; height: number };

export interface StageProps {
  design: Design;
  env: DesignEnv<ImageBitmap> | null;
  issues?: Issue[];
  /** The design before this one: changed elements are marked in blue. */
  previous?: Design;
  judgeFindings?: JudgeFindingRecord[];
  heatmapUrl?: string;
  showHeatmap?: boolean;
  heatmapOpacity?: number;
  showIssues?: boolean;
  showEdits?: boolean;
  selectedIssue?: number | null;
  onSelectIssue?: (index: number | null) => void;
  /** Editing: drag, resize and select elements. `done` is false while a drag is in progress. */
  editable?: boolean;
  selectedElement?: string | null;
  onSelectElement?: (id: string | null) => void;
  onEdit?: (design: Design, done: boolean) => void;
  /** Shown faded (the plan, before any design exists). */
  dimmed?: boolean;
  /** Longest side of the stage on screen, as a CSS length (keeps tall designs in view). */
  maxHeight?: string;
  label: string;
}

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

function boxStyle(box: Box, design: Design): CSSProperties {
  return {
    left: pct(box.x, design.canvas.width),
    top: pct(box.y, design.canvas.height),
    width: pct(box.width, design.canvas.width),
    height: pct(box.height, design.canvas.height),
  };
}

function elementBox(design: Design, id: string | undefined): Box | undefined {
  const el = design.elements.find((e) => e.id === id);
  return el ? { x: el.x, y: el.y, width: el.width, height: el.height } : undefined;
}

type Drag =
  | { kind: 'move'; id: string; startX: number; startY: number; base: Design }
  | {
      kind: 'resize';
      id: string;
      corner: 'nw' | 'ne' | 'sw' | 'se';
      startX: number;
      startY: number;
      base: Design;
      box: Box;
    };

export function Stage(props: StageProps) {
  const {
    design,
    env,
    issues = [],
    previous,
    judgeFindings = [],
    heatmapUrl,
    showHeatmap = false,
    heatmapOpacity = 0.85,
    showIssues = true,
    showEdits = true,
    selectedIssue = null,
    onSelectIssue,
    editable = false,
    selectedElement = null,
    onSelectElement,
    onEdit,
    maxHeight = '62vh',
    dimmed = false,
    label,
  } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [cssWidth, setCssWidth] = useState(0);
  const drag = useRef<Drag | null>(null);
  const { width: W, height: H } = design.canvas;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setCssWidth(entry!.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Draw with the shared renderer at the on-screen resolution.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !env || cssWidth === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(Math.min(W, cssWidth * dpr)));
    const pixelHeight = Math.max(1, Math.round((pixelWidth * H) / W));
    if (c.width !== pixelWidth) c.width = pixelWidth;
    if (c.height !== pixelHeight) c.height = pixelHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.save();
    drawDesign<ImageBitmap>(ctx, design, env, pixelWidth / W);
    ctx.restore();
  }, [design, env, cssWidth, W, H]);

  const heat = useHeatmap(heatmapUrl);

  const edits = useMemo(
    () => (previous && showEdits ? diffDesigns(previous, design) : []),
    [previous, design, showEdits],
  );

  const toDesign = useCallback(
    (clientX: number, clientY: number) => {
      const rect = wrap.current!.getBoundingClientRect();
      return {
        x: ((clientX - rect.left) / rect.width) * W,
        y: ((clientY - rect.top) / rect.height) * H,
      };
    },
    [W, H],
  );

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!editable) return;
    const target = e.target as HTMLElement;
    const corner = target.dataset.corner as 'nw' | 'ne' | 'sw' | 'se' | undefined;
    const p = toDesign(e.clientX, e.clientY);
    if (corner && selectedElement) {
      const box = elementBox(design, selectedElement)!;
      drag.current = {
        kind: 'resize',
        id: selectedElement,
        corner,
        startX: p.x,
        startY: p.y,
        base: design,
        box,
      };
    } else {
      const id = hitTest(design, p.x, p.y) ?? null;
      onSelectElement?.(id);
      if (!id) return;
      drag.current = { kind: 'move', id, startX: p.x, startY: p.y, base: design };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function next(e: { clientX: number; clientY: number; shiftKey: boolean }): Design | null {
    const d = drag.current;
    if (!d) return null;
    const p = toDesign(e.clientX, e.clientY);
    const dx = p.x - d.startX;
    const dy = p.y - d.startY;
    if (d.kind === 'move') return moveBy(d.base, d.id, dx, dy);
    const { box, corner } = d;
    let { x, y, width, height } = box;
    if (corner.includes('e')) width = box.width + dx;
    if (corner.includes('s')) height = box.height + dy;
    if (corner.includes('w')) {
      x = box.x + dx;
      width = box.width - dx;
    }
    if (corner.includes('n')) {
      y = box.y + dy;
      height = box.height - dy;
    }
    if (e.shiftKey) {
      // Keep the aspect ratio: follow the larger change.
      const ratio = box.width / box.height;
      if (Math.abs(width - box.width) / box.width > Math.abs(height - box.height) / box.height) {
        const h = width / ratio;
        if (corner.includes('n')) y = box.y + box.height - h;
        height = h;
      } else {
        const w = height * ratio;
        if (corner.includes('w')) x = box.x + box.width - w;
        width = w;
      }
    }
    return setBox(d.base, d.id, { x, y, width: Math.max(4, width), height: Math.max(4, height) });
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = next(e);
    if (d) onEdit?.(d, false);
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const d = next(e);
    drag.current = null;
    if (d) onEdit?.(d, true);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!editable || !selectedElement) return;
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      onEdit?.(moveBy(design, selectedElement, m[0], m[1]), true);
    } else if (e.key === 'Escape') {
      onSelectElement?.(null);
    }
  }

  const selectedBox = editable ? elementBox(design, selectedElement ?? undefined) : undefined;
  const selected: DesignElement | undefined = design.elements.find(
    (el) => el.id === selectedElement,
  );

  return (
    <div className="mat">
      <div
        ref={wrap}
        className={`stage${editable ? ' editable' : ''}${dimmed ? ' dimmed' : ''}`}
        style={{ maxWidth: `calc(${maxHeight} * ${W / H})`, aspectRatio: `${W} / ${H}` }}
        role="img"
        aria-label={label}
        tabIndex={editable ? 0 : -1}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
      >
        <canvas ref={canvas} />
        {heat ? (
          <canvas
            className="heat"
            ref={(c) => {
              if (c && (c.width !== heat.width || c.height !== heat.height)) {
                c.width = heat.width;
                c.height = heat.height;
              }
              c?.getContext('2d')?.putImageData(heat, 0, 0);
            }}
            style={{ opacity: showHeatmap ? heatmapOpacity : 0 }}
            aria-hidden="true"
          />
        ) : null}
        <div className="marks">
          {showEdits
            ? edits.map((c) => {
                const box = elementBox(design, c.id);
                return box ? (
                  <div
                    key={`e-${c.id}`}
                    className="mark edit"
                    style={boxStyle(box, design)}
                    title={`${c.id}: ${c.changes.join(', ')}`}
                  />
                ) : null;
              })
            : null}
          {showIssues
            ? issues.map((issue, i) => {
                const box = elementBox(design, issue.elementIds[0]);
                if (!box) return null;
                const dim = selectedIssue !== null && selectedIssue !== i;
                return (
                  <div
                    key={`i-${i}-${issue.ruleId}-${issue.elementIds[0]}`}
                    className={`mark ${issue.severity}${selectedIssue === i ? ' selected' : ''}${dim ? ' dim' : ''}`}
                    style={boxStyle(box, design)}
                    onPointerEnter={() => onSelectIssue?.(i)}
                    onPointerLeave={() => onSelectIssue?.(null)}
                  >
                    <span className="badge">{i + 1}</span>
                  </div>
                );
              })
            : null}
          {judgeFindings.map((f, i) => {
            const box = f.box ?? elementBox(design, f.elementId);
            return box ? (
              <div
                key={`j-${i}`}
                className="mark judge"
                style={boxStyle(box, design)}
                title={f.description}
              >
                <span className="badge">J{i + 1}</span>
              </div>
            ) : null;
          })}
          {selectedBox && selected ? (
            <div
              className="selection"
              style={boxStyle(selectedBox, design)}
              aria-label={`Selected: ${selected.id}`}
            >
              {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                <span key={c} className={`handle ${c}`} data-corner={c} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
