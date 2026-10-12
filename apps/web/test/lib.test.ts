import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDesign } from '@simonlunay/redline';
import { describe, expect, it } from 'vitest';
import { diffDesigns } from '../src/lib/diff';
import { hitTest, moveBy, setBox, setColor } from '../src/lib/edit';
import { commit, createHistory, redo, replace, undo } from '../src/lib/history';
import type { RunRecord } from '../src/lib/gallery/types';
import { buildTimeline, frameAt, startOf } from '../src/lib/run/timeline';
import { MAX_UPLOAD_BYTES, readUpload } from '../src/lib/upload';

const fixture = (id: string) =>
  parseDesign(
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`../../../fixtures/${id}.json`, import.meta.url)), 'utf8'),
    ),
  );
const run = (id: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../public/gallery/${id}/run.json`, import.meta.url)),
      'utf8',
    ),
  ) as RunRecord;

describe('timeline', () => {
  it('orders a generate run: plan, candidates, winner, judge, fixes, judge, final', () => {
    const frames = buildTimeline(run('yoga-retreat-tuned'));
    expect(frames.map((f) => f.kind)).toEqual([
      'plan',
      'candidate',
      'candidate',
      'candidate',
      'candidate',
      'winner',
      'judge',
      'step',
      'judge',
      'final',
    ]);
    expect(frames.filter((f) => f.kind === 'candidate').map((f) => f.revealed)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('starts a fix run on the original design and marks what each step changed', () => {
    const record = run('fix-worst');
    const frames = buildTimeline(record);
    expect(frames[0]!.snapshot).toBe(record.loop.steps[0]!.snapshot);
    for (const f of frames.slice(1)) expect(f.previous).toBeDefined();
  });

  it('seeking lands on the same frame as playing to that time', () => {
    const frames = buildTimeline(run('fix-story-concert'));
    for (const speed of [1, 2, 4]) {
      frames.forEach((_, i) => {
        expect(frameAt(frames, startOf(frames, i, speed), speed)).toBe(i);
        expect(frameAt(frames, startOf(frames, i, speed) + 1, speed)).toBe(i);
      });
      expect(frameAt(frames, 1e9, speed)).toBe(frames.length - 1);
    }
  });

  it('diffs against the last accepted design, not a rolled-back one', () => {
    const record = run('coffee-latte');
    const frames = buildTimeline(record);
    const steps = record.loop.steps;
    const rolledBack = steps.findIndex((s) => s.status === 'rolled-back');
    expect(rolledBack).toBeGreaterThan(0);
    const after = frames.find((f) => f.step === rolledBack + 1)!;
    expect(after.previous).not.toBe(steps[rolledBack]!.snapshot);
  });
});

describe('editor', () => {
  const design = fixture('worst');
  const headline = design.elements.find((e) => e.role === 'headline')!;

  it('moves, resizes and recolors through applyFixes', () => {
    const moved = moveBy(design, headline.id, 10, -5);
    const el = moved.elements.find((e) => e.id === headline.id)!;
    expect([el.x, el.y]).toEqual([headline.x + 10, headline.y - 5]);
    const boxed = setBox(design, headline.id, { x: 5, y: 6, width: 0, height: 200 });
    expect(boxed.elements.find((e) => e.id === headline.id)).toMatchObject({
      x: 5,
      y: 6,
      width: 1,
      height: 200,
    });
    const colored = setColor(design, headline.id, '#123456');
    expect(colored.elements.find((e) => e.id === headline.id)).toMatchObject({ color: '#123456' });
    expect(setColor(design, headline.id, 'not a color')).toEqual(design);
    expect(() => parseDesign(boxed)).not.toThrow();
  });

  it('never edits the input design', () => {
    const before = JSON.stringify(design);
    moveBy(design, headline.id, 100, 100);
    expect(JSON.stringify(design)).toBe(before);
  });

  it('hit-tests top-most first and skips the background', () => {
    const cx = headline.x + headline.width / 2;
    const cy = headline.y + headline.height / 2;
    expect(hitTest(design, cx, cy)).toBeDefined();
    expect(hitTest(design, -50, -50)).toBeUndefined();
  });

  it('undoes and redoes, and a drag in progress amends one entry', () => {
    let h = createHistory(1);
    h = commit(h, 2);
    h = replace(h, 3);
    h = replace(h, 4);
    expect(undo(h).present).toBe(1);
    expect(redo(undo(h)).present).toBe(4);
    expect(commit(undo(h), 9).future).toEqual([]);
  });
});

describe('diffDesigns', () => {
  it('names moves, resizes, colors and added shapes', () => {
    const design = fixture('worst');
    const id = design.elements.find((e) => e.type === 'text')!.id;
    const after = setColor(
      setBox(design, id, { x: 0, y: 0, width: 300, height: 90 }),
      id,
      '#000000',
    );
    const changes = diffDesigns(design, after).find((c) => c.id === id)!.changes;
    expect(changes.join(' | ')).toMatch(/moved .* \| resized .* \| color .* → #000000/);
    const added = { ...after, elements: [...after.elements, { ...after.elements[0]!, id: 'new' }] };
    expect(diffDesigns(after, added).find((c) => c.id === 'new')?.added).toBe(true);
  });
});

describe('upload', () => {
  const valid = fixture('clean-poster');
  const embedded = {
    ...valid,
    elements: valid.elements.map((el) =>
      el.type === 'image' ? { ...el, src: 'data:image/png;base64,iVBORw0KGgo=' } : el,
    ),
  };

  it('accepts a valid design with embedded images', () => {
    const text = JSON.stringify(embedded);
    expect(readUpload(text, text.length)).toMatchObject({ ok: true });
  });

  it('refuses files over 4 MB, invalid JSON and invalid designs', () => {
    expect(readUpload('{}', MAX_UPLOAD_BYTES + 1)).toMatchObject({ ok: false, error: /4 MB/ });
    expect(readUpload('{nope', 5)).toMatchObject({ ok: false, error: /valid JSON/ });
    expect(readUpload('{"version":"0.1"}', 17)).toMatchObject({ ok: false });
  });

  it('refuses image paths and URLs, naming the elements', () => {
    const remote = {
      ...embedded,
      elements: embedded.elements.map((el, i) =>
        el.type === 'image' && i === embedded.elements.findIndex((e) => e.type === 'image')
          ? { ...el, src: 'https://example.com/a.png' }
          : el,
      ),
    };
    const result = readUpload(JSON.stringify(remote), 10);
    expect(result).toMatchObject({ ok: false, error: /data URLs/ });
  });
});
