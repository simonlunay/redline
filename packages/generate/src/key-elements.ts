import { defineRule } from '@simonlunay/redline';
import type { Design, RuleIssue } from '@simonlunay/redline';

/** Roles a generated design can't do without. */
const KEY_ROLES = new Set(['product', 'headline', 'cta', 'logo']);

/**
 * Generation mode: a key element that was planned must stay visible. Found in the phase 5 eval:
 * out of regenerations, the fixer set a damaged product cutout to opacity 0. That cleared the
 * cutout and judge issues and scored 100, and shipped a latte ad without the latte. Fading or
 * hiding the hero is never a fix, so it's an error the loop can't trade against anything.
 */
export function createKeyElementsVisibleRule(planned: Design) {
  const ids = new Set(
    planned.elements.filter((el) => el.role && KEY_ROLES.has(el.role)).map((el) => el.id),
  );
  return defineRule({
    id: 'key-element-visible',
    description:
      'A planned product, headline, CTA or logo was faded out, hidden or moved off the canvas. Hiding an element is not a fix for a problem with it: regenerate it, or fix it in place.',
    defaultSeverity: 'error',
    weight: 3,
    defaultOptions: { minOpacity: 0.5 },
    check({ design }, { minOpacity }) {
      const issues: RuleIssue[] = [];
      const { width: W, height: H } = design.canvas;
      for (const id of ids) {
        const el = design.elements.find((e) => e.id === id);
        const where = el ? `${el.role} "${el.id}"` : `"${id}"`;
        if (!el) {
          issues.push({
            elementIds: [],
            message: `${where} was removed from the design. Keep it and fix it in place.`,
            measured: 'removed',
            threshold: 'present',
          });
          continue;
        }
        const offCanvas = el.x >= W || el.y >= H || el.x + el.width <= 0 || el.y + el.height <= 0;
        if (el.opacity < minOpacity || offCanvas) {
          issues.push({
            elementIds: [el.id],
            message: `${where} is ${offCanvas ? 'moved off the canvas' : `faded to opacity ${el.opacity}`}. A key element must stay visible; hiding it doesn't fix it. Restore it and regenerate it or fix it in place.`,
            measured: offCanvas ? 'off-canvas' : el.opacity,
            threshold: minOpacity,
            fix: offCanvas ? [] : [{ op: 'setOpacity', elementId: el.id, opacity: 1 }],
          });
        }
      }
      return issues;
    },
  });
}
