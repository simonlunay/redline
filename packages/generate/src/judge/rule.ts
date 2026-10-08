import { defineRule } from '@simonlunay/redline';
import type { Design, DesignElement, Report, RuleIssue, Severity } from '@simonlunay/redline';
import type { JudgeElement, JudgeFinding, JudgeKnownIssue, JudgeVerdict } from './types.js';

/** What the judge's verdict is about: everything about an element that shows in the render. */
export function elementFingerprint(el: DesignElement): string {
  const { id: _id, ...visible } = el as DesignElement & { id: string };
  return JSON.stringify(visible);
}

export function designFingerprint(design: Design): string {
  return JSON.stringify({ canvas: design.canvas, elements: design.elements });
}

const SEVERITY: Record<JudgeFinding['severity'], Severity> = {
  high: 'error',
  medium: 'warning',
  low: 'info',
};

const ADVICE: Record<JudgeFinding['suggestion'], string> = {
  'regenerate-image': ' Suggested fix: regenerate this image with a brief that avoids it.',
  recut: ' Suggested fix: re-cut the subject, or regenerate it on a plain backdrop.',
  layout: ' Suggested fix: a layout edit.',
  none: '',
};

interface Recorded {
  finding: JudgeFinding;
  /** Fingerprint of the element (or of the whole design) when the judge saw it. */
  fingerprint: string;
}

/**
 * Holds the latest judgment and turns it into issues. The judge can't run on every re-check
 * (it costs money and seconds), so each finding is tied to what the judge saw: it stays while
 * its element is unchanged and is suspended once the element changes (a design-level finding:
 * once anything changes), until the judge looks again. That lets the fix loop make progress,
 * and the next judgment decides whether the fix worked; nudging an element can't fake one.
 */
export function createJudgeStore() {
  let recorded: Recorded[] = [];
  let latest: JudgeVerdict | undefined;

  const active = (design: Design) =>
    recorded.filter(({ finding, fingerprint }) => {
      const el = finding.elementId
        ? design.elements.find((e) => e.id === finding.elementId)
        : undefined;
      return el
        ? elementFingerprint(el) === fingerprint
        : designFingerprint(design) === fingerprint;
    });

  const rule = defineRule({
    id: 'visual-judge',
    description:
      'Visible defects an independent vision model found in the rendered design that the rules missed: fake text in images, bad cutouts, artifacts, awkward cropping, clashing colors, things that look off.',
    defaultSeverity: 'warning',
    weight: 2,
    defaultOptions: {},
    check({ design }) {
      return active(design).map(({ finding }): RuleIssue => ({
        severity: SEVERITY[finding.severity],
        elementIds: finding.elementId ? [finding.elementId] : [],
        message: `Visual review (${finding.category}): ${finding.description}${ADVICE[finding.suggestion]}`,
        measured: finding.severity,
        threshold: 'none',
        unit: finding.category,
      }));
    },
  });

  return {
    rule,
    latest: () => latest,
    /** Records a judgment of `design`. Findings naming unknown elements count as design-level. */
    record(design: Design, verdict: JudgeVerdict) {
      latest = verdict;
      const whole = designFingerprint(design);
      recorded = verdict.findings.map((finding) => {
        const el = finding.elementId
          ? design.elements.find((e) => e.id === finding.elementId)
          : undefined;
        return {
          finding: el ? finding : { ...finding, elementId: null },
          fingerprint: el ? elementFingerprint(el) : whole,
        };
      });
    },
    /** Findings still in force for this design. */
    active: (design: Design) => active(design).map((r) => r.finding),
  };
}

export type JudgeStore = ReturnType<typeof createJudgeStore>;

/** The element table the judge gets: ids, types, roles, boxes and text, in paint order. */
export function judgeElements(design: Design): JudgeElement[] {
  return design.elements
    .map((el, index) => ({ el, index }))
    .sort((a, b) => a.el.zIndex - b.el.zIndex || a.index - b.index)
    .map(({ el }) => ({
      id: el.id,
      type: el.type,
      ...(el.role ? { role: el.role } : {}),
      box: { x: el.x, y: el.y, width: el.width, height: el.height },
      ...(el.type === 'text' ? { text: el.content } : {}),
    }));
}

/** The rules' open issues for the judge (its own findings excluded: it judges afresh). */
export function judgeKnownIssues(report: Report): JudgeKnownIssue[] {
  return report.issues
    .filter((i) => i.ruleId !== 'visual-judge' && i.severity !== 'info')
    .map((i) => ({
      ruleId: i.ruleId,
      severity: i.severity,
      message: i.message,
      elementIds: i.elementIds,
    }));
}
