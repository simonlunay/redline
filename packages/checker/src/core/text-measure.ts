import type { TextElement } from './schema.js';

export interface FontSpec {
  family: string;
  size: number;
  weight: number;
}

/**
 * Measures the advance width of a single line of text in pixels.
 * The core ships a heuristic; the Node entry point provides a precise one backed by real
 * font files, and a browser could use canvas.measureText. Rules only see this interface.
 */
export interface TextMeasurer {
  measure(text: string, font: FontSpec): number;
}

/**
 * Average glyph widths (as a fraction of font size) for a typical sans-serif like Inter.
 * Good to within ~10% for Latin text, which is enough to catch real overflow.
 */
function charWidth(ch: string): number {
  if (ch === ' ') return 0.28;
  if ("iljI.,:;'!|".includes(ch)) return 0.27;
  if ('ftr()[]-'.includes(ch)) return 0.37;
  if ('mwMW@%'.includes(ch)) return 0.88;
  if (ch >= '0' && ch <= '9') return 0.6;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  return 0.56;
}

export const heuristicMeasurer: TextMeasurer = {
  measure(text, font) {
    let units = 0;
    for (const ch of text) units += charWidth(ch);
    // Bold glyphs are wider: roughly +7% at 700, +12% at 900.
    const weightFactor = 1 + Math.max(0, font.weight - 400) / 4000;
    return units * font.size * weightFactor;
  },
};

export function fontOf(el: TextElement): FontSpec {
  return { family: el.fontFamily, size: el.fontSize, weight: el.fontWeight };
}

/**
 * Greedy word wrap, the same algorithm browsers use for normal text.
 * Explicit "\n" always breaks. A word wider than maxWidth gets its own line (and overflows).
 */
export function wrapText(
  content: string,
  maxWidth: number,
  font: FontSpec,
  measurer: TextMeasurer,
): string[] {
  const lines: string[] = [];
  for (const paragraph of content.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = words[0]!;
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`;
      if (measurer.measure(candidate, font) <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

export interface TextLayout {
  lines: string[];
  lineHeightPx: number;
  /** Total height of all lines. */
  height: number;
  /** Width of the widest line. */
  width: number;
}

export function layoutText(
  el: TextElement,
  measurer: TextMeasurer,
  fontSize = el.fontSize,
): TextLayout {
  const font = { ...fontOf(el), size: fontSize };
  const lines = wrapText(el.content, el.width, font, measurer);
  const lineHeightPx = fontSize * el.lineHeight;
  return {
    lines,
    lineHeightPx,
    height: lines.length * lineHeightPx,
    width: Math.max(0, ...lines.map((l) => measurer.measure(l, font))),
  };
}
