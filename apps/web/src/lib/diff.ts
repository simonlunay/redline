import type { Design, DesignElement } from '@simonlunay/redline';

export interface ElementChange {
  id: string;
  /** Plain-language changes, e.g. "moved 0, −130", "color #fff → #0f172a". */
  changes: string[];
  added?: boolean;
}

const round = (n: number) => Math.round(n);
const signed = (n: number) => (n > 0 ? `+${round(n)}` : n < 0 ? `−${round(-n)}` : '0');

function colorOf(el: DesignElement): string | undefined {
  return el.type === 'text' ? el.color : el.type === 'shape' ? el.fill : undefined;
}

/**
 * What changed between two versions of a design, per element. The player marks these in blue,
 * and for runs whose edits weren't recorded with values it's the only record of what changed.
 */
export function diffDesigns(before: Design, after: Design): ElementChange[] {
  const old = new Map(before.elements.map((el) => [el.id, el]));
  const out: ElementChange[] = [];
  for (const el of after.elements) {
    const prev = old.get(el.id);
    if (!prev) {
      out.push({
        id: el.id,
        added: true,
        changes: [`added (${el.type === 'shape' ? el.kind : el.type})`],
      });
      continue;
    }
    const changes: string[] = [];
    if (round(prev.x) !== round(el.x) || round(prev.y) !== round(el.y)) {
      changes.push(`moved ${signed(el.x - prev.x)}, ${signed(el.y - prev.y)}`);
    }
    if (round(prev.width) !== round(el.width) || round(prev.height) !== round(el.height)) {
      changes.push(
        `resized ${round(prev.width)}×${round(prev.height)} → ${round(el.width)}×${round(el.height)}`,
      );
    }
    const [c0, c1] = [colorOf(prev), colorOf(el)];
    if (c0 && c1 && c0.toLowerCase() !== c1.toLowerCase()) changes.push(`color ${c0} → ${c1}`);
    if (prev.type === 'text' && el.type === 'text') {
      if (prev.fontSize !== el.fontSize)
        changes.push(`font size ${prev.fontSize} → ${el.fontSize}`);
      if (prev.fontWeight !== el.fontWeight)
        changes.push(`weight ${prev.fontWeight} → ${el.fontWeight}`);
      if (prev.content !== el.content) changes.push('text changed');
    }
    if (prev.type === 'image' && el.type === 'image' && prev.src !== el.src)
      changes.push('new image');
    if (prev.opacity !== el.opacity) changes.push(`opacity ${prev.opacity} → ${el.opacity}`);
    if (prev.zIndex !== el.zIndex) changes.push(`layer ${prev.zIndex} → ${el.zIndex}`);
    if (changes.length) out.push({ id: el.id, changes });
  }
  return out;
}
