import type { ImageSlot } from './plan.js';

/** Appended to every generated image: text is never rendered by the image model. */
export const NO_TEXT =
  'No text, no letters, no words, no numbers, no logos, no signage, no watermark.';

/** Subjects are generated on a plain backdrop so the cutout model can separate them cleanly. */
export const SUBJECT_BACKDROP =
  'Single subject, fully in frame and centered, isolated on a plain seamless light grey studio background, soft even lighting, no props, no shadow clutter.';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A plan element (`kind`) or a design element (`type`): only role, kind and box matter. */
export interface ZoneElement extends Box {
  role?: string;
  kind?: string;
  type?: string;
}

const VERTICAL = ['top', 'middle', 'bottom'] as const;
const HORIZONTAL = ['left', 'center', 'right'] as const;

/**
 * Turns the text boxes of a layout into words an image model understands, e.g.
 * "the top 32% (headline, subheading) and the bottom-center (cta)". It's computed from
 * geometry, so the calm-area instruction is right even when the art director's own
 * description is vague.
 */
export function describeTextZones(
  elements: readonly ZoneElement[],
  canvas: { width: number; height: number },
): string {
  const content = elements.filter(
    (el) =>
      el.role !== 'background' &&
      el.role !== 'product' &&
      (el.kind === 'text' || el.type === 'text' || el.role === 'cta'),
  );
  if (content.length === 0) return '';

  // Group elements by the canvas third their center falls in (rows first, then columns).
  const zones = new Map<string, { boxes: Box[]; roles: Set<string> }>();
  for (const el of content) {
    const cx = (el.x + el.width / 2) / canvas.width;
    const cy = (el.y + el.height / 2) / canvas.height;
    const row = VERTICAL[Math.min(2, Math.max(0, Math.floor(cy * 3)))]!;
    const wide = el.width / canvas.width > 0.55;
    const col = wide ? 'full' : HORIZONTAL[Math.min(2, Math.max(0, Math.floor(cx * 3)))]!;
    const key = `${row}|${col}`;
    const zone = zones.get(key) ?? { boxes: [], roles: new Set<string>() };
    zone.boxes.push(el);
    if (el.role) zone.roles.add(el.role);
    zones.set(key, zone);
  }

  const parts = [...zones.entries()].map(([key, zone]) => {
    const [row, col] = key.split('|') as [string, string];
    const top = Math.min(...zone.boxes.map((b) => b.y));
    const bottom = Math.max(...zone.boxes.map((b) => b.y + b.height));
    const pct = (n: number) =>
      Math.round((Math.max(0, Math.min(canvas.height, n)) / canvas.height) * 100);
    const band =
      row === 'top'
        ? `the top ${pct(bottom)}%`
        : row === 'bottom'
          ? `the bottom ${100 - pct(top)}%`
          : `the middle band (${pct(top)}-${pct(bottom)}% from the top)`;
    const where = col === 'full' ? band : `${band}, ${col} side`;
    return `${where} (${[...zone.roles].join(', ')})`;
  });
  return `Text will be placed over ${parts.join(' and ')}: keep those areas calm, uncluttered, low in detail and even in tone, with the main subject and any busy detail elsewhere.`;
}

/** The final prompt sent to the image provider for a generated slot. */
export function buildImagePrompt(
  slot: Pick<ImageSlot, 'kind' | 'brief' | 'calmAreas' | 'style'>,
  elements: readonly ZoneElement[],
  canvas: { width: number; height: number },
): string {
  const parts = [slot.brief.trim().replace(/\.?$/, '.')];
  if (slot.kind === 'background') {
    if (slot.calmAreas.trim()) parts.push(slot.calmAreas.trim().replace(/\.?$/, '.'));
    const zones = describeTextZones(elements, canvas);
    if (zones) parts.push(zones);
  } else {
    parts.push(SUBJECT_BACKDROP);
  }
  if (slot.style.trim()) parts.push(`Style: ${slot.style.trim().replace(/\.?$/, '.')}`);
  parts.push(NO_TEXT);
  return parts.join(' ');
}
