import { parseDesign } from '@simonlunay/redline';
import type { Design, DesignElement, ImageElement, ShapeElement } from '@simonlunay/redline';

/**
 * Contact shadows: a soft, blurred, semi-transparent ellipse under a cut-out subject that rests on
 * a surface, so it sits on the scene instead of floating like a sticker (the judge's most common
 * remaining complaint once cutouts were clean). Deterministic: the shadow is computed from the
 * subject's box and its footprint, with no model or API call. It's an ordinary decoration shape
 * (`blur` > 0) painted directly behind the subject, in the subject's group.
 */

/** Where a cut-out subject touches the ground, measured from its alpha (fractions of the image). */
export interface Footprint {
  /** Left and right edge of the opaque pixels in the bottom band of the subject, 0..1. */
  left: number;
  right: number;
  /** The lowest opaque row, 0..1 from the top. */
  bottom: number;
}

export const SHADOW_SUFFIX = '-shadow';
export const DEFAULT_SHADOW_OPACITY = 0.5;
export const MIN_SHADOW_OPACITY = 0.1;
export const MAX_SHADOW_OPACITY = 0.8;

export const shadowIdFor = (subjectId: string) => `${subjectId}${SHADOW_SUFFIX}`;

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * The shadow for a subject: an ellipse 20% wider than the footprint, flat (22% of its width),
 * centered on the contact line so it peeks out under the subject, and blurred by 30% of its
 * height, which keeps a dark core. (The first version, 14% tall with half its height of blur,
 * was invisible on anything but a light, flat surface in the eval.) Kept inside the canvas.
 * Opacity 0 is a shadow that's switched off.
 */
export function contactShadow(
  subject: ImageElement,
  footprint: Footprint,
  canvas: { width: number; height: number },
  opacity = DEFAULT_SHADOW_OPACITY,
): ShapeElement {
  const footWidth = Math.max(0.05, footprint.right - footprint.left) * subject.width;
  const cx = subject.x + ((footprint.left + footprint.right) / 2) * subject.width;
  const width = Math.max(8, footWidth * 1.2);
  const height = Math.max(4, width * 0.22);
  const contact = subject.y + footprint.bottom * subject.height;
  const x = clamp(cx - width / 2, 0, Math.max(0, canvas.width - width));
  const y = clamp(contact - height * 0.55, 0, Math.max(0, canvas.height - height));
  return {
    id: shadowIdFor(subject.id),
    type: 'shape',
    role: 'decoration',
    kind: 'ellipse',
    x: r2(x),
    y: r2(y),
    width: r2(width),
    height: r2(height),
    fill: '#000000',
    opacity: opacity <= 0 ? 0 : r2(clamp(opacity, MIN_SHADOW_OPACITY, MAX_SHADOW_OPACITY)),
    cornerRadius: 0,
    blur: r2(Math.max(2, height * 0.3)),
    rotation: 0,
    zIndex: subject.zIndex,
    groupId: subject.groupId ?? subject.id,
  };
}

/**
 * Adds, updates or removes the contact shadow of one subject. The shadow is inserted directly
 * before the subject in paint order (same zIndex), and the subject joins the shadow's group.
 * `enabled: false` removes it (assembly); the fix loop switches one off with opacity 0
 * instead, since its guardrail forbids removing elements. Returns an error message instead of
 * a design when the request can't apply.
 */
export function setContactShadow(
  design: Design,
  subjectId: string,
  footprint: Footprint | undefined,
  options: { enabled: boolean; opacity?: number },
): Design | string {
  const subject = design.elements.find((el) => el.id === subjectId);
  if (!subject || subject.type !== 'image') return `"${subjectId}" is not an image element`;
  const id = shadowIdFor(subjectId);
  const existing = design.elements.find((el) => el.id === id);
  const rest = design.elements.filter((el) => el.id !== id);
  if (!options.enabled) return existing ? { ...design, elements: rest } : design;
  if (!footprint)
    return `"${subjectId}" is not a cut-out subject, so it can't have a contact shadow`;
  const grouped: ImageElement = { ...subject, groupId: subject.groupId ?? subject.id };
  const opacity = options.opacity ?? existing?.opacity ?? DEFAULT_SHADOW_OPACITY;
  const shadow = contactShadow(grouped, footprint, design.canvas, opacity);
  const elements: DesignElement[] = [];
  for (const el of rest) {
    if (el.id === subjectId) elements.push(shadow, grouped);
    else elements.push(el);
  }
  return parseDesign({ ...design, elements });
}

/**
 * Re-fits every contact shadow to its subject after edits moved, resized or regenerated it,
 * keeping each shadow's opacity. A shadow whose subject is gone or no longer a cutout is switched
 * off (opacity 0) where it is, rather than removed. Returns the same object when nothing changed.
 */
export function syncContactShadows(
  design: Design,
  footprintOf: (src: string) => Footprint | undefined,
): Design {
  let next = design;
  for (const el of design.elements) {
    if (el.type !== 'shape' || el.role !== 'decoration' || !el.id.endsWith(SHADOW_SUFFIX)) continue;
    const subjectId = el.id.slice(0, -SHADOW_SUFFIX.length);
    const subject = next.elements.find((e) => e.id === subjectId);
    const footprint = subject?.type === 'image' ? footprintOf(subject.src) : undefined;
    const result = footprint
      ? setContactShadow(next, subjectId, footprint, { enabled: true, opacity: el.opacity })
      : null;
    if (result === null || typeof result === 'string') {
      if (el.opacity === 0) continue;
      next = {
        ...next,
        elements: next.elements.map((e) => (e.id === el.id ? { ...e, opacity: 0 } : e)),
      };
      continue;
    }
    const before = JSON.stringify(next.elements);
    if (JSON.stringify(result.elements) !== before) next = result;
  }
  return next;
}
