import type { Design, DesignElement, Role } from '../schema.js';

/** Human label used in messages: `headline "title"` or `image "photo"`. */
export function label(el: DesignElement): string {
  return `${el.role ?? el.type} "${el.id}"`;
}

export function hasRole(el: DesignElement, ...roles: Role[]): boolean {
  return el.role !== undefined && roles.includes(el.role);
}

/**
 * Elements in the order they are painted: by zIndex, and by array position for ties.
 * This mirrors how the renderer (and every design tool) stacks layers.
 */
export function paintOrder(design: Design): DesignElement[] {
  return design.elements
    .map((el, index) => ({ el, index }))
    .sort((a, b) => a.el.zIndex - b.el.zIndex || a.index - b.index)
    .map(({ el }) => el);
}

/** True when `a` is painted below `b`. */
export function isBelow(design: Design, a: DesignElement, b: DesignElement): boolean {
  const order = paintOrder(design);
  return order.indexOf(a) < order.indexOf(b);
}

/**
 * Smallest shift that brings the span [start, start+size] inside [min, max].
 * If the span is larger than the range, it is centered in it instead.
 */
export function clampDelta(start: number, size: number, min: number, max: number): number {
  if (size > max - min) return (min + max) / 2 - (start + size / 2);
  if (start < min) return min - start;
  if (start + size > max) return max - (start + size);
  return 0;
}

export function px(n: number): string {
  return `${Math.round(n * 10) / 10}px`;
}
