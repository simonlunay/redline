import { z } from 'zod';
import { round2 } from './geometry.js';
import { ColorSchema, ElementSchema, parseDesign } from './schema.js';
import type { Design, DesignElement, ShapeElement } from './schema.js';

/**
 * Fix operations: the shared edit language of the checker (suggested fixes), the AI agent
 * (LLM edits) and applyFixes. Deliberately small and layout/style-only: no op can change
 * text content, font family or image source.
 *
 * Numeric ranges are NOT encoded in the schema (LLM structured-output schemas don't support
 * them); applyFixes clamps or rejects out-of-range values instead.
 */
const id = z.string().describe('Id of an existing element');

export const FixSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('move'),
    elementId: id,
    dx: z.number().describe('Horizontal shift in px (positive = right)'),
    dy: z.number().describe('Vertical shift in px (positive = down)'),
  }),
  z.object({
    op: z.literal('resize'),
    elementId: id,
    width: z.number().describe('New width in px (top-left corner stays put)'),
    height: z.number().describe('New height in px'),
  }),
  z.object({
    op: z.literal('setColor'),
    elementId: id,
    color: z.string().describe('Hex color. Sets text color for text, fill for shapes'),
  }),
  z.object({
    op: z.literal('setFontSize'),
    elementId: id,
    fontSize: z.number().describe('Font size in px'),
  }),
  z.object({
    op: z.literal('setFontWeight'),
    elementId: id,
    fontWeight: z.number().describe('100-1000, e.g. 400 regular, 700 bold'),
  }),
  z.object({
    op: z.literal('setOpacity'),
    elementId: id,
    opacity: z.number().describe('0-1, e.g. 0.5 to tone down a competing decoration'),
  }),
  z.object({
    op: z.literal('insertShape'),
    behindElementId: id.describe('The new shape is painted directly behind this element'),
    kind: z.enum(['rect', 'ellipse']),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    fill: z.string().describe('Hex color, e.g. #000000'),
    opacity: z.number().describe('0-1. Use < 1 for a translucent scrim over a photo'),
    cornerRadius: z.number(),
  }),
]);

export type Fix = z.infer<typeof FixSchema>;
export type FixOp = Fix['op'];

export interface RejectedFix {
  fix: unknown;
  reason: string;
}

export interface ApplyFixesResult {
  /** Always a valid design (re-parsed with DesignSchema). */
  design: Design;
  applied: Fix[];
  rejected: RejectedFix[];
  /** Ids of elements created by insertShape, in order. */
  insertedIds: string[];
}

const MAX_FONT_SIZE = 1000;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function uniqueId(elements: DesignElement[], base: string): string {
  const taken = new Set(elements.map((el) => el.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * Applies one fix in place. Returns an error message instead of throwing so a bad op from an
 * LLM is reported and skipped rather than crashing the loop.
 */
function applyOne(elements: DesignElement[], fix: Fix, insertedIds: string[]): string | null {
  const targetId = fix.op === 'insertShape' ? fix.behindElementId : fix.elementId;
  const index = elements.findIndex((el) => el.id === targetId);
  const el = elements[index];
  if (!el) return `No element with id "${targetId}"`;

  switch (fix.op) {
    case 'move':
      el.x = round2(el.x + fix.dx);
      el.y = round2(el.y + fix.dy);
      return null;
    case 'resize':
      el.width = round2(Math.max(1, fix.width));
      el.height = round2(Math.max(1, fix.height));
      return null;
    case 'setColor': {
      if (!ColorSchema.safeParse(fix.color).success) return `"${fix.color}" is not a hex color`;
      if (el.type === 'text') el.color = fix.color;
      else if (el.type === 'shape') el.fill = fix.color;
      else return 'setColor only applies to text and shapes';
      return null;
    }
    case 'setFontSize':
      if (el.type !== 'text') return 'setFontSize only applies to text';
      el.fontSize = round2(clamp(fix.fontSize, 1, MAX_FONT_SIZE));
      return null;
    case 'setFontWeight':
      if (el.type !== 'text') return 'setFontWeight only applies to text';
      el.fontWeight = Math.round(clamp(fix.fontWeight, 100, 1000));
      return null;
    case 'setOpacity':
      el.opacity = clamp(fix.opacity, 0, 1);
      return null;
    case 'insertShape': {
      if (!ColorSchema.safeParse(fix.fill).success) return `"${fix.fill}" is not a hex color`;
      const shape: ShapeElement = {
        id: uniqueId(elements, `${targetId}-backing`),
        type: 'shape',
        role: 'decoration',
        kind: fix.kind,
        x: round2(fix.x),
        y: round2(fix.y),
        width: round2(Math.max(1, fix.width)),
        height: round2(Math.max(1, fix.height)),
        fill: fix.fill,
        opacity: clamp(fix.opacity, 0, 1),
        cornerRadius: Math.max(0, fix.cornerRadius),
        rotation: 0,
        // Same zIndex as the target, inserted right before it in the array: it paints above
        // everything that was under the target and directly below the target itself.
        zIndex: el.zIndex,
      };
      elements.splice(index, 0, shape);
      insertedIds.push(shape.id);
      return null;
    }
  }
}

/**
 * Applies fixes in order and returns a new, schema-valid design. Pure: the input is not
 * modified. Invalid fixes (unknown ids, wrong element type, malformed values) are collected in
 * `rejected` and skipped; out-of-range values are clamped.
 */
export function applyFixes(input: unknown, fixes: readonly unknown[]): ApplyFixesResult {
  const design = structuredClone(parseDesign(input));
  const applied: Fix[] = [];
  const rejected: RejectedFix[] = [];
  const insertedIds: string[] = [];

  for (const raw of fixes) {
    const parsed = FixSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ fix: raw, reason: parsed.error.issues.map((i) => i.message).join('; ') });
      continue;
    }
    // Work on a copy so a fix that would produce an invalid element can be rolled back.
    const before = structuredClone(design.elements);
    const error = applyOne(design.elements, parsed.data, insertedIds);
    const invalid = error ?? firstInvalidElement(design.elements);
    if (invalid) {
      design.elements = before;
      if (parsed.data.op === 'insertShape' && !error) insertedIds.pop();
      rejected.push({ fix: raw, reason: invalid });
      continue;
    }
    applied.push(parsed.data);
  }

  return { design: parseDesign(design), applied, rejected, insertedIds };
}

function firstInvalidElement(elements: DesignElement[]): string | null {
  for (const el of elements) {
    const result = ElementSchema.safeParse(el);
    if (!result.success) return `Would make "${el.id}" invalid: ${result.error.issues[0]?.message}`;
  }
  return null;
}
