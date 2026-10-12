/**
 * The rule set a design is checked with in the browser. It mirrors the order the CLI and the
 * generate pipeline use (builtin, attention, image, copy-grounded, key-element-visible), because
 * a report's issue order and score depend on it.
 *
 * The attention rules need a saliency model, which the site doesn't ship. For a design the
 * gallery build already checked, its stored attention outputs are replayed by "frozen" rules with
 * the same id, weight and severity, so the score is exactly what the build measured. For an
 * edited design they're left out and reported as paused.
 */
import { attentionRules, builtinRules, defineRule, imageRules } from '@simonlunay/redline';
import type { AnyRule, Design } from '@simonlunay/redline';
import { createCopyGroundedRule, createKeyElementsVisibleRule } from '@simonlunay/redline-generate';
import type { FrozenRuleOutput, RunRules } from './gallery/types';

export const ATTENTION_RULE_IDS: readonly string[] = attentionRules.map((r) => r.id);

/** A rule that returns a stored output instead of measuring (same id, weight and severity). */
export function frozenRule(rule: AnyRule, output: FrozenRuleOutput): AnyRule {
  return defineRule({
    id: rule.id,
    description: rule.description,
    defaultSeverity: rule.defaultSeverity,
    weight: rule.weight,
    defaultOptions: {},
    check: () => ({
      issues: output.issues,
      ...(output.elementScores ? { elementScores: output.elementScores } : {}),
      ...(output.details ? { details: output.details } : {}),
    }),
  });
}

export interface RuleSetup {
  rules: RunRules;
  /** The winner's design, when the key-element rule applies (fix-loop snapshots). */
  plannedDesign?: Design;
  /** Stored attention outputs of the unedited design (uploads have none). */
  frozenAttention?: Record<string, FrozenRuleOutput>;
  /** True once the design differs from the one the stored outputs belong to. */
  edited?: boolean;
}

export interface BrowserRules {
  rules: AnyRule[];
  /** Why the attention rules aren't in the check, when they aren't (shown next to the score). */
  attentionPaused?: 'edited' | 'no-heatmap';
}

export function browserRules(setup: RuleSetup): BrowserRules {
  const rules: AnyRule[] = [...builtinRules];
  let attentionPaused: BrowserRules['attentionPaused'];
  if (setup.rules.attention) {
    const frozen = setup.frozenAttention;
    if (!frozen || !attentionRules.every((r) => frozen[r.id])) attentionPaused = 'no-heatmap';
    else if (setup.edited) attentionPaused = 'edited';
    else rules.push(...attentionRules.map((r) => frozenRule(r, frozen[r.id]!)));
  }
  if (setup.rules.imageChecks) rules.push(...imageRules);
  if (setup.rules.copyGrounded)
    rules.push(createCopyGroundedRule(setup.rules.copyGrounded.sources));
  if (setup.plannedDesign) rules.push(createKeyElementsVisibleRule(setup.plannedDesign));
  return { rules, ...(attentionPaused ? { attentionPaused } : {}) };
}
