import type { Report } from '@simonlunay/redline';
import type { DesignEditor, Edit } from '../types.js';

/**
 * The checker's own suggested fixes as edits: for each element, the fixes of its most severe
 * issue (report.issues is sorted errors first). One issue per element, because two rules
 * moving the same element in the same step would add up their moves and overshoot.
 */
export function suggestedEdits(report: Report): Edit[] {
  const edits: Edit[] = [];
  const handled = new Set<string>();
  for (const issue of report.issues) {
    if (!issue.fix || issue.fix.length === 0) continue;
    const target = issue.elementIds[0];
    if (target === undefined || handled.has(target)) continue;
    handled.add(target);
    for (const fix of issue.fix) {
      edits.push({ ...fix, reason: `[${issue.ruleId}] ${issue.message}` });
    }
  }
  return edits;
}

/**
 * Deterministic, offline editor that just applies the checker's suggestions each iteration.
 * Used as the "rules only" baseline in the eval and as the mock LLM in tests and the CLI.
 */
export function createSuggestedFixesEditor(): DesignEditor {
  return {
    name: 'suggested-fixes',
    async proposeEdits({ report }) {
      const edits = suggestedEdits(report);
      return {
        raw: {
          summary: `Apply the checker's suggested fixes for ${edits.length} edit(s).`,
          edits,
        },
      };
    },
  };
}
