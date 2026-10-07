import { FORMAT_VERSION, parseDesign } from '@simonlunay/redline';
import type { Design, DesignElement } from '@simonlunay/redline';
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
  return parseDesign({
    version: FORMAT_VERSION,
    name: name ?? layout.name,
    canvas: { width: canvas.width, height: canvas.height, background: plan.palette.background },
    elements,
  });
}
