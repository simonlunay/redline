import type { CutoutProblem } from '../cutout-quality.js';
import { defineRule } from '../types.js';
import type { RuleIssue } from '../types.js';
import { label } from './util.js';

const DESCRIBE: Record<CutoutProblem, (m: number) => string> = {
  bites: (m) => `notches or tears bitten out of the outline (${(m * 100).toFixed(1)}% of its area)`,
  'see-through': (m) => `partly see-through inside (${(m * 100).toFixed(1)}% of the interior)`,
  fragments: (m) => `stray detached fragments (${(m * 100).toFixed(2)}% of its area)`,
  'leftover-backdrop': (m) =>
    `flat backdrop-colored areas left in (${(m * 100).toFixed(0)}% of its area)`,
  uncut: (m) => `not cut out: it runs along ${m} sides of the image`,
  'jagged-edges': (m) => `a jagged outline (${m.toFixed(2)}x the length of a smooth one)`,
};

/** Which problem leads the message when several are found: the most fundamental first. */
const PRIORITY: CutoutProblem[] = [
  'uncut',
  'leftover-backdrop',
  'fragments',
  'bites',
  'see-through',
  'jagged-edges',
];

/**
 * Damaged cutouts: a subject cut out of its backdrop with bites, tears, holes, stray bits,
 * leftover backdrop or no cut at all. Needs image analysis (measured from each cutout's alpha
 * ahead of the check).
 */
export const cutoutQuality = defineRule({
  id: 'cutout-quality',
  description:
    'Cut-out subjects with damaged edges: bites or tears in the outline, see-through patches, stray fragments, leftover backdrop, or a subject that was never cut out. Re-cut it (BiRefNet) or regenerate it on a plain backdrop.',
  defaultSeverity: 'error',
  weight: 2,
  requires: ['images'],
  defaultOptions: {},
  check({ design, images }) {
    const issues: RuleIssue[] = [];
    for (const el of design.elements) {
      if (el.type !== 'image' || el.opacity < 0.05) continue;
      const verdict = images?.get(el.src)?.cutout;
      if (!verdict || verdict.severity === 'ok') continue;
      const worst = [...verdict.problems].sort(
        (a, b) =>
          (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1) ||
          PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind),
      );
      const main = worst[0]!;
      issues.push({
        severity: verdict.severity,
        elementIds: [el.id],
        message:
          verdict.source === 'model'
            ? `${label(el)} may be a damaged cutout: ${worst.map((p) => DESCRIBE[p.kind](p.measured)).join('; ')}. It was cut by a segmentation model, where these signals are often false alarms (a subject colored like the backdrop, a stepped outline), so this is only a warning. Regenerate the subject only if the cut really looks damaged.`
            : `${label(el)} is a damaged cutout: ${worst.map((p) => DESCRIBE[p.kind](p.measured)).join('; ')}. Re-cut it with BiRefNet, or regenerate the subject on a plain, evenly lit backdrop with no transparent or glass parts against it.`,
        measured: Number(main.measured.toFixed(4)),
        threshold: main.limit,
        unit: main.kind,
      });
    }
    return issues;
  },
});
