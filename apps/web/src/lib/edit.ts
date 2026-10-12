import { applyFixes } from '@simonlunay/redline';
import type { Design, Fix } from '@simonlunay/redline';

/**
 * Editor operations. They go through applyFixes, the same validated ops the fix loop uses, so an
 * edited design is always schema-valid (sizes clamped to at least 1px, colors validated).
 */
function apply(design: Design, ops: Fix[]): Design {
  return applyFixes(design, ops).design;
}

export function moveBy(design: Design, id: string, dx: number, dy: number): Design {
  if (dx === 0 && dy === 0) return design;
  return apply(design, [{ op: 'move', elementId: id, dx: Math.round(dx), dy: Math.round(dy) }]);
}

/** Sets an element's box (a corner drag moves the origin and resizes at once). */
export function setBox(
  design: Design,
  id: string,
  box: { x: number; y: number; width: number; height: number },
): Design {
  const el = design.elements.find((e) => e.id === id);
  if (!el) return design;
  return apply(design, [
    { op: 'move', elementId: id, dx: Math.round(box.x - el.x), dy: Math.round(box.y - el.y) },
    {
      op: 'resize',
      elementId: id,
      width: Math.max(1, Math.round(box.width)),
      height: Math.max(1, Math.round(box.height)),
    },
  ]);
}

export function setColor(design: Design, id: string, color: string): Design {
  return apply(design, [{ op: 'setColor', elementId: id, color }]);
}

/** The element under a point, top-most first (as painted), ignoring the background. */
export function hitTest(design: Design, x: number, y: number): string | undefined {
  const ordered = design.elements
    .map((el, index) => ({ el, index }))
    .sort((a, b) => b.el.zIndex - a.el.zIndex || b.index - a.index);
  for (const { el } of ordered) {
    if (el.role === 'background') continue;
    if (x >= el.x && x <= el.x + el.width && y >= el.y && y <= el.y + el.height) return el.id;
  }
  return undefined;
}
