import { describe, expect, it } from 'vitest';
import { check } from '../src/core/check.js';
import { defineRule } from '../src/core/types.js';
import { makeDesign, text } from './helpers.js';

const everyText = defineRule({
  id: 'every-text',
  description: 'Reports one warning per text element (test rule).',
  defaultSeverity: 'warning',
  weight: 1,
  defaultOptions: { minLength: 0 },
  check({ design }, { minLength }) {
    return design.elements
      .filter((el) => el.type === 'text' && el.content.length >= minLength)
      .map((el) => ({
        elementIds: [el.id],
        message: 'text found',
        measured: 1,
        threshold: 0,
      }));
  },
});

const alwaysError = defineRule({
  id: 'always-error',
  description: 'Always reports one error (test rule).',
  defaultSeverity: 'warning',
  weight: 3,
  defaultOptions: {},
  check: () => [{ severity: 'error', elementIds: [], message: 'boom', measured: 1, threshold: 0 }],
});

const design = makeDesign([text({ content: 'a' }), text({ content: 'longer text' })]);
const rules = [everyText, alwaysError];

describe('check engine', () => {
  it('scores rules, weights the overall score and sorts errors first', () => {
    const report = check(design, { rules });
    expect(report.rules).toEqual([
      { ruleId: 'every-text', score: 94, weight: 1, issues: 2 },
      { ruleId: 'always-error', score: 76, weight: 3, issues: 1 },
    ]);
    // Two warnings at weight 1 (x0.97 each) times one error at weight 3 (x0.76).
    expect(report.score).toBe(Math.round(100 * 0.97 * 0.97 * 0.76));
    expect(report.issues[0]!.severity).toBe('error');
    expect(report.passed).toBe(false);
    expect(report.summary).toEqual({ errors: 1, warnings: 2, infos: 0 });
  });

  it('applies config: off, severity override, options and weight', () => {
    const report = check(design, {
      rules,
      config: {
        rules: {
          'always-error': 'off',
          'every-text': { severity: 'info', options: { minLength: 5 }, weight: 2 },
        },
      },
    });
    expect(report.rules).toEqual([{ ruleId: 'every-text', score: 99, weight: 2, issues: 1 }]);
    expect(report.issues[0]!.severity).toBe('info');
    expect(report.passed).toBe(true);
  });

  it('rejects unknown rule ids in config', () => {
    expect(() => check(design, { rules, config: { rules: { nope: 'off' } } })).toThrow(
      /Unknown rule "nope"/,
    );
  });

  it('returns 100 when no rules are enabled', () => {
    expect(check(design, { rules: [] }).score).toBe(100);
  });
});
