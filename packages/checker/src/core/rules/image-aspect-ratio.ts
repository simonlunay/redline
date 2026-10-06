import { round2 } from '../geometry.js';
import { defineRule } from '../types.js';
import type { RuleIssue } from '../types.js';
import { label } from './util.js';

export const imageAspectRatio = defineRule({
  id: 'image-aspect-ratio',
  description:
    'Images stretched or squashed compared to their natural aspect ratio. Images with fit "cover" or "contain" are cropped or letterboxed instead, so they are skipped.',
  defaultSeverity: 'warning',
  weight: 2,
  defaultOptions: {
    /** Distortion (% difference in aspect ratio) that triggers a warning. */
    warnPercent: 2,
    /** Distortion that is clearly visible: error. */
    errorPercent: 10,
  },
  check({ design }, { warnPercent, errorPercent }) {
    const issues: RuleIssue[] = [];
    for (const el of design.elements) {
      if (el.type !== 'image' || el.fit !== 'fill' || el.height === 0) continue;
      const natural = el.naturalWidth / el.naturalHeight;
      const box = el.width / el.height;
      const distortion = Math.abs(box / natural - 1) * 100;
      if (distortion < warnPercent) continue;
      const direction = box > natural ? 'stretched horizontally' : 'stretched vertically';
      issues.push({
        severity: distortion >= errorPercent ? 'error' : 'warning',
        elementIds: [el.id],
        message: `${label(el)} is ${direction} by ${round2(distortion)}% (box ${round2(box)}:1 vs image ${round2(natural)}:1).`,
        measured: round2(distortion),
        threshold: warnPercent,
        unit: '% distortion',
        // Keep the width (usually what the layout column dictates) and fix the height.
        fix: [
          {
            op: 'resize',
            elementId: el.id,
            width: el.width,
            height: round2(el.width / natural),
          },
        ],
      });
    }
    return issues;
  },
});
