import { RoleSchema } from '@simonlunay/redline';
import { z } from 'zod';

/**
 * The art director's output: everything needed to build candidate designs, except pixels.
 *
 * Claude fills in a closely related output format (ToolDesignPlanSchema, sent as a structured
 * output schema) with no unions and no nullable fields (unused strings are ""): each layout lists
 * its texts, shapes and images in separate arrays. parsePlan() converts it into this internal one. Numeric ranges, hex formats and
 * cross-references are checked in validatePlan(), whose error text is fed back on a retry.
 */

const hex = z.string().describe('Hex color like #1a2b3c');
const box = {
  x: z.number().describe('Left edge in canvas px'),
  y: z.number().describe('Top edge in canvas px'),
  width: z.number(),
  height: z.number(),
  zIndex: z.number().describe('Paint order, higher is on top; the background image is 0'),
};

export const PlanTextSchema = z.object({
  kind: z.literal('text'),
  id: z.string(),
  role: RoleSchema,
  ...box,
  content: z.string().describe('The exact copy; one of the copy fields'),
  fontFamily: z.string(),
  fontSize: z.number(),
  fontWeight: z.number().describe('400, 600, 700 or 900'),
  color: hex,
  align: z.enum(['left', 'center', 'right']),
  lineHeight: z.number().describe('Multiplier, e.g. 1.1 for headlines, 1.35 for body'),
});

export const PlanShapeSchema = z.object({
  kind: z.literal('shape'),
  id: z.string(),
  role: RoleSchema,
  ...box,
  shape: z.enum(['rect', 'ellipse']),
  fill: hex,
  cornerRadius: z.number(),
  opacity: z.number().describe('0-1; < 1 for a translucent panel over the image'),
});

export const PlanImageSchema = z.object({
  kind: z.literal('image'),
  id: z.string(),
  role: RoleSchema,
  ...box,
  slot: z.string().describe('Id of an image slot of this layout'),
});

export const PlanElementSchema = z.discriminatedUnion('kind', [
  PlanTextSchema,
  PlanShapeSchema,
  PlanImageSchema,
]);

export const ImageSlotSchema = z.object({
  id: z.string(),
  kind: z
    .enum(['background', 'subject', 'user'])
    .describe(
      'background: generated full-bleed scene; subject: generated product/person cut out as its own layer; user: an image the user supplied',
    ),
  brief: z
    .string()
    .describe(
      'What the image shows: subject, setting, lighting, mood, camera. Never any words, letters or logos. For user slots: what the image is used for.',
    ),
  calmAreas: z
    .string()
    .describe(
      'Where text will sit and what must stay calm, e.g. "keep the top third calm and uncluttered for the headline". "" for subjects and user images.',
    ),
  style: z
    .string()
    .describe('Visual style, e.g. "editorial photo, soft daylight" or "flat 3D render"'),
  stockQuery: z.string().describe('3-6 word stock photo search query for this slot ("" for user)'),
  userImageId: z.string().describe('For user slots: the id of the supplied image; otherwise ""'),
});

export const LayoutSchema = z.object({
  name: z.string().describe('Short name, e.g. "headline top, product center"'),
  rationale: z.string().describe('One sentence: why this layout works for the brief'),
  imageSlots: z.array(ImageSlotSchema),
  elements: z.array(PlanElementSchema),
});

export const DesignPlanSchema = z.object({
  concept: z.string().describe('One or two sentences: the creative idea'),
  palette: z.object({
    background: hex,
    primary: hex,
    accent: hex,
    text: hex,
    textOnAccent: hex,
  }),
  copy: z.object({
    headline: z.string(),
    subheading: z.string().describe('"" if none'),
    body: z.string().describe('"" if none'),
    cta: z.string().describe('Call-to-action label, "" if none'),
  }),
  layouts: z.array(LayoutSchema),
});

/** The strict tool format: per-kind arrays instead of a union (see the comment at the top). */
export const ToolLayoutSchema = z.object({
  name: LayoutSchema.shape.name,
  rationale: LayoutSchema.shape.rationale,
  imageSlots: LayoutSchema.shape.imageSlots,
  texts: z
    .array(PlanTextSchema.omit({ kind: true }))
    .describe('Every text element: headline, subheading, body, CTA label'),
  shapes: z
    .array(PlanShapeSchema.omit({ kind: true }))
    .describe('Every shape: CTA button, panels behind text, accents ([] if none)'),
  images: z
    .array(PlanImageSchema.omit({ kind: true }))
    .describe('Every image element: the background, subject, logo'),
});

export const ToolDesignPlanSchema = DesignPlanSchema.extend({
  layouts: z.array(ToolLayoutSchema),
});

export type ToolDesignPlan = z.infer<typeof ToolDesignPlanSchema>;

/** Tool format -> internal format. */
export function fromToolPlan(plan: ToolDesignPlan): DesignPlan {
  return {
    ...plan,
    layouts: plan.layouts.map(({ texts, shapes, images, ...layout }) => ({
      ...layout,
      elements: [
        ...images.map((el) => ({ kind: 'image' as const, ...el })),
        ...shapes.map((el) => ({ kind: 'shape' as const, ...el })),
        ...texts.map((el) => ({ kind: 'text' as const, ...el })),
      ],
    })),
  };
}

/** Internal format -> tool format (tests and examples). */
export function toToolPlan(plan: DesignPlan): ToolDesignPlan {
  return {
    ...plan,
    layouts: plan.layouts.map(({ elements, ...layout }) => ({
      ...layout,
      texts: elements.flatMap(({ kind, ...el }) =>
        kind === 'text' ? [el as Omit<PlanText, 'kind'>] : [],
      ),
      shapes: elements.flatMap(({ kind, ...el }) =>
        kind === 'shape' ? [el as Omit<PlanShape, 'kind'>] : [],
      ),
      images: elements.flatMap(({ kind, ...el }) =>
        kind === 'image' ? [el as Omit<PlanImage, 'kind'>] : [],
      ),
    })),
  };
}

export type PlanText = z.infer<typeof PlanTextSchema>;
export type PlanShape = z.infer<typeof PlanShapeSchema>;
export type PlanImage = z.infer<typeof PlanImageSchema>;
export type PlanElement = z.infer<typeof PlanElementSchema>;
export type ImageSlot = z.infer<typeof ImageSlotSchema>;
export type Layout = z.infer<typeof LayoutSchema>;
export type DesignPlan = z.infer<typeof DesignPlanSchema>;

export interface PlanContext {
  canvas: { width: number; height: number };
  /** Font families that can actually be rendered. */
  fonts: string[];
  /** Ids of user-supplied images (including the logo). */
  userImageIds: string[];
  /** Number of layouts asked for. */
  layouts: number;
}

export type PlanParseResult = { ok: true; plan: DesignPlan } | { ok: false; error: string };

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** Copy shorter than this can legitimately appear in a brief ("SALE" vs "a sale rack"). */
const MIN_COPY_LENGTH_TO_MATCH = 6;

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Validates raw art-director output: the schema, then everything a schema can't say. Returns
 * every problem at once (capped), so one retry can fix them all.
 */
export function parsePlan(raw: unknown, ctx: PlanContext): PlanParseResult {
  if (raw === undefined) {
    return { ok: false, error: 'No plan was returned. Respond with the JSON plan.' };
  }
  if (raw && typeof raw === 'object' && 'invalid' in raw && typeof raw.invalid === 'string') {
    return { ok: false, error: raw.invalid };
  }
  // Claude answers in the tool format; templates and tests may pass the internal one.
  const layouts = (raw as { layouts?: unknown[] } | null)?.layouts;
  const internal =
    Array.isArray(layouts) &&
    layouts.some((l) => (l as object | null) && 'elements' in (l as object));
  const parsed = internal ? DesignPlanSchema.safeParse(raw) : ToolDesignPlanSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 10)
      .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    return { ok: false, error: `The plan did not match the schema:\n${details}` };
  }
  const plan = internal ? (parsed.data as DesignPlan) : fromToolPlan(parsed.data as ToolDesignPlan);
  const problems = validatePlan(plan, ctx);
  if (problems.length > 0) {
    const shown = problems.slice(0, 15);
    const more =
      problems.length > shown.length ? `\n(and ${problems.length - shown.length} more)` : '';
    return {
      ok: false,
      error: `The plan has problems:\n${shown.map((p) => `- ${p}`).join('\n')}${more}`,
    };
  }
  return { ok: true, plan };
}

/** Semantic checks. Returns human-readable problems (empty when the plan is usable). */
export function validatePlan(plan: DesignPlan, ctx: PlanContext): string[] {
  const problems: string[] = [];
  const { width: W, height: H } = ctx.canvas;
  const fonts = new Set(ctx.fonts.map((f) => f.toLowerCase()));

  for (const [name, color] of Object.entries(plan.palette)) {
    if (!HEX.test(color)) problems.push(`palette.${name} "${color}" is not a hex color`);
  }
  if (!plan.copy.headline.trim()) problems.push('copy.headline is empty');
  if (plan.layouts.length === 0) problems.push('layouts is empty');
  if (plan.layouts.length > ctx.layouts) {
    problems.push(`${plan.layouts.length} layouts were sent; send exactly ${ctx.layouts}`);
  }

  const copyTexts = Object.values(plan.copy)
    .map(normalize)
    .filter((t) => t.length >= MIN_COPY_LENGTH_TO_MATCH);

  plan.layouts.forEach((layout, li) => {
    const at = `layouts[${li}]`;
    const slots = new Map<string, ImageSlot>();
    for (const slot of layout.imageSlots) {
      if (slots.has(slot.id)) problems.push(`${at}: duplicate image slot id "${slot.id}"`);
      slots.set(slot.id, slot);
      if (slot.kind === 'user') {
        if (!ctx.userImageIds.includes(slot.userImageId)) {
          problems.push(
            `${at}.imageSlots "${slot.id}": userImageId "${slot.userImageId}" is not one of the supplied images (${ctx.userImageIds.join(', ') || 'none supplied'})`,
          );
        }
        continue;
      }
      if (!slot.brief.trim()) problems.push(`${at}.imageSlots "${slot.id}": brief is empty`);
      if (slot.kind === 'background' && !slot.calmAreas.trim()) {
        problems.push(
          `${at}.imageSlots "${slot.id}": calmAreas is empty; say where the text sits and what must stay calm`,
        );
      }
      const brief = normalize(`${slot.brief} ${slot.calmAreas} ${slot.style}`);
      for (const text of copyTexts) {
        if (brief.includes(text)) {
          problems.push(
            `${at}.imageSlots "${slot.id}": the brief contains the copy "${text}". Text is rendered as separate text elements; describe the image only, never words to render in it.`,
          );
        }
      }
    }
    if (![...slots.values()].some((s) => s.kind === 'background')) {
      problems.push(`${at}: needs one image slot of kind "background"`);
    }

    if (layout.elements.length === 0) {
      problems.push(`${at}: has no elements; list its texts, shapes and images`);
      return;
    }
    const ids = new Set<string>();
    let headlines = 0;
    const usedSlots = new Set<string>();
    for (const el of layout.elements) {
      const where = `${at}.elements "${el.id}"`;
      if (ids.has(el.id)) problems.push(`${at}: duplicate element id "${el.id}"`);
      ids.add(el.id);
      if (!(el.width > 0 && el.height > 0)) problems.push(`${where}: width and height must be > 0`);
      if (!Number.isInteger(el.zIndex)) problems.push(`${where}: zIndex must be a whole number`);
      const right = el.x + el.width;
      const bottom = el.y + el.height;
      const bleeds = el.role === 'background';
      if (!bleeds && (el.x < -1 || el.y < -1 || right > W + 1 || bottom > H + 1)) {
        problems.push(
          `${where}: box (${el.x}, ${el.y}, ${el.width}x${el.height}) is outside the ${W}x${H} canvas`,
        );
      }
      if (el.kind === 'text') {
        if (el.role === 'headline') headlines++;
        if (!el.content.trim()) problems.push(`${where}: text content is empty`);
        if (!HEX.test(el.color)) problems.push(`${where}: color "${el.color}" is not a hex color`);
        if (!(el.fontSize > 0)) problems.push(`${where}: fontSize must be > 0`);
        if (el.fontWeight < 100 || el.fontWeight > 1000)
          problems.push(`${where}: fontWeight must be 100-1000`);
        if (!(el.lineHeight > 0)) problems.push(`${where}: lineHeight must be > 0`);
        if (!fonts.has(el.fontFamily.toLowerCase())) {
          problems.push(
            `${where}: font "${el.fontFamily}" is not available; use one of ${ctx.fonts.join(', ')}`,
          );
        }
      } else if (el.kind === 'shape') {
        if (!HEX.test(el.fill)) problems.push(`${where}: fill "${el.fill}" is not a hex color`);
        if (el.opacity < 0 || el.opacity > 1) problems.push(`${where}: opacity must be 0-1`);
      } else {
        const slot = slots.get(el.slot);
        if (!slot) {
          problems.push(`${where}: slot "${el.slot}" is not an image slot of this layout`);
          continue;
        }
        usedSlots.add(el.slot);
        if (slot.kind === 'background' && el.role !== 'background') {
          problems.push(
            `${where}: a background slot must be used by an element with role "background"`,
          );
        }
      }
    }
    if (headlines !== 1)
      problems.push(
        `${at}: needs exactly one text element with role "headline" (has ${headlines})`,
      );
    for (const id of slots.keys()) {
      if (!usedSlots.has(id))
        problems.push(`${at}: image slot "${id}" is not used by any image element`);
    }
  });
  return problems;
}
