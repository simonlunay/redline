import type { Report } from '@simonlunay/redline';

/** Share of predicted attention per key role, from the attention rule's details (0-1). */
export function roleShares(report: Report): Record<string, number> | undefined {
  const details = report.rules.find((r) => r.ruleId === 'attention-key-elements')?.details;
  return details?.roleShares as Record<string, number> | undefined;
}

export function ctaShare(report: Report): number | undefined {
  return roleShares(report)?.cta;
}

/**
 * Orders candidates best first: highest score, then fewest errors, then fewest warnings, then
 * the most predicted attention on the CTA, then the original order (stable, deterministic).
 */
export function rankCandidates(reports: readonly Report[]): number[] {
  return reports
    .map((report, index) => ({ report, index }))
    .sort((a, b) => {
      const ra = a.report;
      const rb = b.report;
      if (ra.score !== rb.score) return rb.score - ra.score;
      if (ra.summary.errors !== rb.summary.errors) return ra.summary.errors - rb.summary.errors;
      if (ra.summary.warnings !== rb.summary.warnings)
        return ra.summary.warnings - rb.summary.warnings;
      const ca = ctaShare(ra) ?? 0;
      const cb = ctaShare(rb) ?? 0;
      if (ca !== cb) return cb - ca;
      return a.index - b.index;
    })
    .map((c) => c.index);
}

/** Which layout and background variant candidate `i` of `n` uses, with `layouts` layouts. */
export function candidateVariant(i: number, layouts: number): { layout: number; variant: number } {
  return { layout: i % layouts, variant: Math.floor(i / layouts) };
}

/** Deterministic 31-bit seed from a string (FNV-1a), so the same prompt gives the same images. */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2_000_000_000;
}
