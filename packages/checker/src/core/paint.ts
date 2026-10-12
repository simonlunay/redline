import type { Design, DesignElement, ImageElement } from './schema.js';
import { paintOrder } from './rules/util.js';
import { fontOf, wrapText } from './text-measure.js';
import type { FontSpec, TextMeasurer } from './text-measure.js';

/** Anything with a size that the context can draw: a Skia Image, an ImageBitmap, an <img>. */
export interface PaintImage {
  readonly width: number;
  readonly height: number;
}

/**
 * The part of the Canvas 2D API the renderer uses. Both a browser CanvasRenderingContext2D and
 * @napi-rs/canvas's SKRSContext2D satisfy it, so one renderer draws the same pixels everywhere.
 * Methods use method syntax so their parameters are checked bivariantly (image types differ).
 */
export interface PaintContext<I extends PaintImage = PaintImage> {
  globalAlpha: number;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  filter: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  roundRect(x: number, y: number, w: number, h: number, radii: number): void;
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
  ): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(image: I, x: number, y: number, w: number, h: number): void;
}

export interface PaintOptions<I extends PaintImage> {
  /** Decoded images keyed by src. Missing images are drawn as a crossed placeholder. */
  images: Map<string, I>;
  /** The measurer that wraps text, which should measure with the same fonts the context draws. */
  measurer: TextMeasurer;
  /** CSS font string for a font spec, e.g. `700 48px "Inter"`. */
  cssFont: (font: FontSpec) => string;
}

function drawImageElement<I extends PaintImage>(
  ctx: PaintContext<I>,
  el: ImageElement,
  img: I | undefined,
) {
  if (!img) {
    // Visible placeholder so a missing file is obvious in previews.
    ctx.fillStyle = '#d0d0d0';
    ctx.fillRect(el.x, el.y, el.width, el.height);
    ctx.strokeStyle = '#888888';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(el.x, el.y);
    ctx.lineTo(el.x + el.width, el.y + el.height);
    ctx.moveTo(el.x + el.width, el.y);
    ctx.lineTo(el.x, el.y + el.height);
    ctx.stroke();
    return;
  }
  if (el.fit === 'fill') {
    ctx.drawImage(img, el.x, el.y, el.width, el.height);
    return;
  }
  const sx = el.width / img.width;
  const sy = el.height / img.height;
  const scale = el.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(el.x, el.y, el.width, el.height);
  ctx.clip();
  ctx.drawImage(img, el.x + (el.width - w) / 2, el.y + (el.height - h) / 2, w, h);
  ctx.restore();
}

/** Draws one element in canvas coordinates. */
export function paintElement<I extends PaintImage>(
  ctx: PaintContext<I>,
  el: DesignElement,
  options: PaintOptions<I>,
): void {
  ctx.save();
  ctx.globalAlpha = el.opacity;
  if (el.rotation !== 0) {
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((el.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  if (el.type === 'shape') {
    ctx.fillStyle = el.fill;
    if (el.blur > 0) ctx.filter = `blur(${el.blur}px)`;
    ctx.beginPath();
    if (el.kind === 'ellipse') {
      ctx.ellipse(
        el.x + el.width / 2,
        el.y + el.height / 2,
        el.width / 2,
        el.height / 2,
        0,
        0,
        Math.PI * 2,
      );
    } else {
      ctx.roundRect(el.x, el.y, el.width, el.height, el.cornerRadius);
    }
    ctx.fill();
    ctx.filter = 'none';
  } else if (el.type === 'image') {
    drawImageElement(ctx, el, options.images.get(el.src));
  } else {
    const font = fontOf(el);
    ctx.font = options.cssFont(font);
    ctx.fillStyle = el.color;
    ctx.textAlign = el.align;
    ctx.textBaseline = 'middle';
    const lineHeight = el.fontSize * el.lineHeight;
    const x =
      el.align === 'left' ? el.x : el.align === 'right' ? el.x + el.width : el.x + el.width / 2;
    // Deliberately not clipped: overflowing text should be visible in the preview.
    wrapText(el.content, el.width, font, options.measurer).forEach((line, i) => {
      ctx.fillText(line, x, el.y + i * lineHeight + lineHeight / 2);
    });
  }
  ctx.restore();
}

/**
 * Paints the background and every element in paint order, in canvas coordinates (scale or
 * translate the context first for previews). This is the renderer the CLI's PNGs, the checker's
 * renders and the web app all share.
 */
export function paintDesign<I extends PaintImage>(
  ctx: PaintContext<I>,
  design: Design,
  options: PaintOptions<I>,
): void {
  ctx.fillStyle = design.canvas.background;
  ctx.fillRect(0, 0, design.canvas.width, design.canvas.height);
  for (const el of paintOrder(design)) paintElement(ctx, el, options);
}
