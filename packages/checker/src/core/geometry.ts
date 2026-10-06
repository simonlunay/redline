import type { Canvas, DesignElement } from './schema.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * The element's unrotated box. Most rules use this on purpose: rotation is rare in
 * poster/social layouts and axis-aligned boxes keep the rules simple and predictable.
 * Only off-canvas uses true rotated corners (see rotatedBounds).
 */
export function rectOf(el: Pick<DesignElement, 'x' | 'y' | 'width' | 'height'>): Rect {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

export const right = (r: Rect) => r.x + r.width;
export const bottom = (r: Rect) => r.y + r.height;
export const centerX = (r: Rect) => r.x + r.width / 2;
export const centerY = (r: Rect) => r.y + r.height / 2;
export const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);

export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(right(a), right(b)) - x;
  const h = Math.min(bottom(a), bottom(b)) - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

/** True when `inner` lies entirely inside `outer` (edges touching counts as inside). */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    right(inner) <= right(outer) &&
    bottom(inner) <= bottom(outer)
  );
}

/** Corners of the element after rotating around its center. */
export function rotatedCorners(
  el: Pick<DesignElement, 'x' | 'y' | 'width' | 'height' | 'rotation'>,
): Point[] {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const rad = (el.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners: Point[] = [
    { x: el.x, y: el.y },
    { x: el.x + el.width, y: el.y },
    { x: el.x + el.width, y: el.y + el.height },
    { x: el.x, y: el.y + el.height },
  ];
  return corners.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  });
}

/** Axis-aligned bounding box of the rotated element. */
export function rotatedBounds(
  el: Pick<DesignElement, 'x' | 'y' | 'width' | 'height' | 'rotation'>,
): Rect {
  if (el.rotation % 360 === 0) return rectOf(el);
  const pts = rotatedCorners(el);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Hit test that respects ellipse shapes (rotation ignored, see rectOf). */
export function elementContainsPoint(el: DesignElement, p: Point): boolean {
  const r = rectOf(el);
  if (p.x < r.x || p.y < r.y || p.x > right(r) || p.y > bottom(r)) return false;
  if (el.type === 'shape' && el.kind === 'ellipse') {
    const rx = r.width / 2;
    const ry = r.height / 2;
    if (rx === 0 || ry === 0) return false;
    const nx = (p.x - centerX(r)) / rx;
    const ny = (p.y - centerY(r)) / ry;
    return nx * nx + ny * ny <= 1;
  }
  return true;
}

export function canvasRect(canvas: Canvas): Rect {
  return { x: 0, y: 0, width: canvas.width, height: canvas.height };
}

/** Many thresholds scale with the shorter side so they work for posts, stories and banners. */
export function shortSide(canvas: Canvas): number {
  return Math.min(canvas.width, canvas.height);
}

/** Evenly spaced sample points inside a rect (cell centers of a cols x rows grid). */
export function gridPoints(r: Rect, cols: number, rows: number): Point[] {
  const points: Point[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      points.push({
        x: r.x + ((col + 0.5) * r.width) / cols,
        y: r.y + ((row + 0.5) * r.height) / rows,
      });
    }
  }
  return points;
}

/** Rounds to 2 decimals so reports and snapshots are stable and readable. */
export function round2(n: number): number {
  // `|| 0` turns -0 into 0, which otherwise shows up in snapshots and deep equality.
  return Math.round(n * 100) / 100 || 0;
}
