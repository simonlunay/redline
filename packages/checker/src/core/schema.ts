import { z } from 'zod';

/**
 * The Redline design format, version 0.1.
 *
 * The Zod schema is the single source of truth: TypeScript types are inferred from it,
 * so validation and types can never drift apart.
 */

export const FORMAT_VERSION = '0.1';

/** #RGB, #RRGGBB or #RRGGBBAA. Hex only keeps parsing trivial and unambiguous. */
export const ColorSchema = z
  .string()
  .regex(
    /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
    'Expected a hex color like #1a2b3c',
  );

export const RoleSchema = z.enum([
  'background',
  'logo',
  'headline',
  'subheading',
  'body',
  'cta',
  'product',
  'decoration',
]);

const BaseElementSchema = z.object({
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  /** Degrees, clockwise, around the element's center. */
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
  zIndex: z.number().int().default(0),
  groupId: z.string().optional(),
  role: RoleSchema.optional(),
});

export const TextElementSchema = BaseElementSchema.extend({
  type: z.literal('text'),
  content: z.string(),
  fontFamily: z.string().default('Inter'),
  fontSize: z.number().positive(),
  fontWeight: z.number().int().min(100).max(1000).default(400),
  color: ColorSchema,
  /** Multiplier of fontSize, like CSS unitless line-height. */
  lineHeight: z.number().positive().default(1.2),
  align: z.enum(['left', 'center', 'right']).default('left'),
});

export const ImageElementSchema = BaseElementSchema.extend({
  type: z.literal('image'),
  src: z.string().min(1),
  naturalWidth: z.number().positive(),
  naturalHeight: z.number().positive(),
  /**
   * How the image fills its box, like CSS object-fit. Only "fill" can distort the image,
   * so the aspect-ratio rule skips "cover" and "contain".
   */
  fit: z.enum(['fill', 'cover', 'contain']).default('fill'),
});

export const ShapeElementSchema = BaseElementSchema.extend({
  type: z.literal('shape'),
  kind: z.enum(['rect', 'ellipse']),
  fill: ColorSchema,
  cornerRadius: z.number().nonnegative().default(0),
});

export const ElementSchema = z.discriminatedUnion('type', [
  TextElementSchema,
  ImageElementSchema,
  ShapeElementSchema,
]);

export const CanvasSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  background: ColorSchema,
});

export const DesignSchema = z
  .object({
    version: z.literal(FORMAT_VERSION),
    name: z.string().optional(),
    canvas: CanvasSchema,
    elements: z.array(ElementSchema),
  })
  .superRefine((design, ctx) => {
    const seen = new Set<string>();
    design.elements.forEach((el, i) => {
      if (seen.has(el.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate element id "${el.id}"`,
          path: ['elements', i, 'id'],
        });
      }
      seen.add(el.id);
    });
  });

/** A validated design with all defaults filled in. This is what rules operate on. */
export type Design = z.infer<typeof DesignSchema>;
/** What a user may write: optional fields such as rotation/opacity can be omitted. */
export type DesignInput = z.input<typeof DesignSchema>;
export type Canvas = z.infer<typeof CanvasSchema>;
export type DesignElement = z.infer<typeof ElementSchema>;
export type TextElement = z.infer<typeof TextElementSchema>;
export type ImageElement = z.infer<typeof ImageElementSchema>;
export type ShapeElement = z.infer<typeof ShapeElementSchema>;
export type Role = z.infer<typeof RoleSchema>;

export class DesignValidationError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'DesignValidationError';
  }
}

/** Validates unknown input and fills defaults. Throws DesignValidationError on bad input. */
export function parseDesign(input: unknown): Design {
  const result = DesignSchema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  const details = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
  throw new DesignValidationError(`Invalid design:\n${details}`, issues);
}
