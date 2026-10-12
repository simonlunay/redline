import type { TextMeasurer } from '@simonlunay/redline';
import { DESIGN_FONT_FAMILY, DESIGN_FONT_FILES } from './fonts';

/**
 * Widths of a few strings as the CLI measures them (Skia, the bundled Inter files), one per
 * weight. test/font-check.test.ts measures them with the CLI's measurer, so they can't drift.
 *
 * The browser must reproduce these, or text would wrap differently than in the CLI and scores
 * would differ silently. It has happened: Linux Chromium hints glyphs by default, which rounds
 * every advance to a whole pixel ("Start free trial" at 13px bold: 90 instead of 87.69), so
 * hard-leaderboard's CTA label wrapped and scored 50 instead of 79 on the CI runner.
 */
export const FONT_PROBES = [
  { text: 'Body copy in regular weight, 0123456789', size: 16, weight: 400, width: 314.98 },
  { text: 'Up to 50% off everything', size: 32, weight: 600, width: 389.05 },
  { text: 'Start free trial', size: 13, weight: 700, width: 87.69 },
  { text: 'Metricly', size: 18, weight: 900, width: 76.33 },
] as const;

/**
 * How far a probe may be from the CLI's width. The CLI's Skia reports widths to 0.01 px
 * (87.69) where Chromium reports 87.693, so the two differ by thousandths of a pixel. Hinting
 * moves these strings by 0.6 to 2.3 px, which this catches with a wide margin.
 */
export const PROBE_TOLERANCE_PX = 0.02;

export interface FontCheck {
  ok: boolean;
  /** Plain-language problems, for the page and the console. */
  problems: string[];
}

/** Checks that each design-font weight is loaded and measures like the CLI. */
export function checkDesignFonts(
  measurer: TextMeasurer,
  isLoaded: (css: string) => boolean,
): FontCheck {
  const problems: string[] = [];
  for (const weight of Object.keys(DESIGN_FONT_FILES)) {
    const css = `${weight} 16px "${DESIGN_FONT_FAMILY}"`;
    if (!isLoaded(css)) problems.push(`Inter ${weight} didn't load.`);
  }
  for (const p of FONT_PROBES) {
    const width = measurer.measure(p.text, { family: 'Inter', size: p.size, weight: p.weight });
    if (Math.abs(width - p.width) > PROBE_TOLERANCE_PX) {
      problems.push(
        `"${p.text}" at ${p.size}px/${p.weight} measures ${width.toFixed(3)}px here and ${p.width}px in the CLI.`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Canvas text the way the CLI measures it: unhinted, with fractional advances. Without this,
 * Linux Chromium snaps each glyph's advance to a whole pixel.
 */
export function setGeometricText(ctx: object): void {
  if ('textRendering' in ctx)
    (ctx as { textRendering: string }).textRendering = 'geometricPrecision';
}
