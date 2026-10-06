/** Channels are 0-255. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** RGB plus alpha in 0-1. */
export interface RGBA extends RGB {
  a: number;
}

export function parseHex(hex: string): RGBA {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  if (h.length !== 6 && h.length !== 8) throw new Error(`Invalid hex color: ${hex}`);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

export function toHex({ r, g, b }: RGB): string {
  const part = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Source-over compositing of `top` (with alpha) onto an opaque `bottom`. */
export function blend(top: RGB, alpha: number, bottom: RGB): RGB {
  return {
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
  };
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance({ r, g, b }: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

interface HSL {
  h: number;
  s: number;
  l: number;
}

function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h / 6, s, l };
}

function hslToRgb({ h, s, l }: HSL): RGB {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue(p, q, h + 1 / 3) * 255,
    g: hue(p, q, h) * 255,
    b: hue(p, q, h - 1 / 3) * 255,
  };
}

/** Worst (lowest) contrast of `fg` against any of the backgrounds. */
export function minContrast(fg: RGB, backgrounds: RGB[]): number {
  return Math.min(...backgrounds.map((bg) => contrastRatio(fg, bg)));
}

/**
 * Finds the color closest to `color` (same hue and saturation, only lightness changes)
 * that reaches `minRatio` against every background. This keeps the brand color recognizable
 * instead of always jumping to black or white. Falls back to whichever of black/white
 * scores best when no lightness works (e.g. a busy mid-grey image).
 */
export function nearestPassingColor(color: RGB, backgrounds: RGB[], minRatio: number): string {
  const hsl = rgbToHsl(color);
  const step = 0.01;
  for (let delta = step; delta <= 1; delta += step) {
    for (const l of [hsl.l - delta, hsl.l + delta]) {
      if (l < 0 || l > 1) continue;
      const candidate = hslToRgb({ ...hsl, l });
      // Compare on the rounded hex we will actually suggest, so the fix is guaranteed to pass.
      const rounded = parseHex(toHex(candidate));
      if (minContrast(rounded, backgrounds) >= minRatio) return toHex(rounded);
    }
  }
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  return minContrast(black, backgrounds) >= minContrast(white, backgrounds) ? '#000000' : '#ffffff';
}
