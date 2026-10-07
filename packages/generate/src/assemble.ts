import { FORMAT_VERSION, heuristicMeasurer, layoutText, parseDesign } from '@simonlunay/redline';
import type { Design, DesignElement, TextMeasurer } from '@simonlunay/redline';
import type { DesignPlan } from './plan.js';

/** A produced image for a slot: where it is stored and its real pixel size. */
export interface SlotImage {
  src: string;
  width: number;
  height: number;
}

/** The largest box with the image's aspect ratio that fits in `box`, centered in it. */
export function fitBox(
  box: { x: number; y: number; width: number; height: number },
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  let width = box.width;
  let height = width / aspect;
  if (height > box.height) {
    height = box.height;
    width = height * aspect;
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    x: r(box.x + (box.width - width) / 2),
    y: r(box.y + (box.height - height) / 2),
    width: r(width),
    height: r(height),
  };
}

/**
 * Builds a Redline design from one layout of a plan plus the images produced for its slots.
 * Backgrounds fill the canvas with `fit: cover` (any generated size works). Subjects, logos
 * and other images get a box fitted to their real aspect ratio inside the planned box, so they
 * are never stretched and the box matches the visible pixels (which matters for overlap and
 * attention). Throws if a slot has no image, since that is a pipeline bug.
 */
export function assembleDesign(
  plan: DesignPlan,
  layoutIndex: number,
  canvas: { width: number; height: number },
  images: ReadonlyMap<string, SlotImage>,
  name?: string,
  measurer: TextMeasurer = heuristicMeasurer,
): Design {
  const layout = plan.layouts[layoutIndex];
  if (!layout) throw new Error(`The plan has no layout ${layoutIndex}`);
  const elements: DesignElement[] = layout.elements.map((el): DesignElement => {
    const base = {
      id: el.id,
      role: el.role,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      zIndex: Math.round(el.zIndex),
      rotation: 0,
      opacity: 1,
    };
    if (el.kind === 'text') {
      return {
        ...base,
        type: 'text',
        content: el.content,
        fontFamily: el.fontFamily,
        fontSize: el.fontSize,
        fontWeight: Math.round(el.fontWeight),
        color: el.color,
        lineHeight: el.lineHeight,
        align: el.align,
      };
    }
    if (el.kind === 'shape') {
      return {
        ...base,
        type: 'shape',
        kind: el.shape,
        fill: el.fill,
        cornerRadius: Math.max(0, el.cornerRadius),
        opacity: Math.min(1, Math.max(0, el.opacity)),
      };
    }
    const image = images.get(el.slot);
    if (!image) throw new Error(`No image was produced for slot "${el.slot}"`);
    const slot = layout.imageSlots.find((s) => s.id === el.slot);
    const fullBleed = el.role === 'background' || slot?.kind === 'background';
    const box = fullBleed
      ? { x: 0, y: 0, width: canvas.width, height: canvas.height }
      : fitBox(el, image.width / image.height);
    return {
      ...base,
      ...box,
      type: 'image',
      src: image.src,
      naturalWidth: image.width,
      naturalHeight: image.height,
      fit: fullBleed ? 'cover' : 'contain',
    };
  });
  return centerButtonLabels(
    parseDesign({
      version: FORMAT_VERSION,
      name: name ?? layout.name,
      canvas: { width: canvas.width, height: canvas.height, background: plan.palette.background },
      elements,
    }),
    measurer,
  );
}

/**
 * Text renders from the top of its box, so a CTA label whose box fills its button sits high.
 * The checker can't see that (nothing overflows or overlaps), but people do. This snaps each
 * CTA label that sits on a CTA shape to the wrapped text's real height, centered in the button.
 */
export function centerButtonLabels(
  design: Design,
  measurer: TextMeasurer = heuristicMeasurer,
): Design {
  const buttons = design.elements.filter((el) => el.type === 'shape' && el.role === 'cta');
  const elements = design.elements.map((el) => {
    if (el.type !== 'text' || el.role !== 'cta') return el;
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const button = buttons.find(
      (b) => cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height,
    );
    if (!button) return el;
    const height = Math.round(layoutText(el, measurer).height + el.fontSize * 0.1);
    if (height > button.height) return el;
    const width = Math.min(el.width, button.width);
    const r = (n: number) => Math.round(n * 100) / 100;
    return {
      ...el,
      align: 'center' as const,
      x: r(button.x + (button.width - width) / 2),
      width: r(width),
      y: r(button.y + (button.height - height) / 2),
      height,
    };
  });
  return { ...design, elements };
}
