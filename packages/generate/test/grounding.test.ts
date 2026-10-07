import { check, parseDesign } from '@simonlunay/redline';
import { builtinRules } from '@simonlunay/redline';
import { createFontMeasurer } from '@simonlunay/redline/node';
import { describe, expect, it } from 'vitest';
import { templatePlan } from '../src/director/template.js';
import {
  checkFactReplacement,
  createCopyGroundedRule,
  extractFacts,
  findUngroundedFacts,
  planFactProblems,
} from '../src/grounding.js';
import { brief } from './helpers.js';

const CHARITY = 'poster for a charity 5K, energetic, blue and orange';
const facts = (text: string, prompt = CHARITY) =>
  findUngroundedFacts(text, [prompt]).map((f) => [f.kind, f.text]);

describe('copy-grounded: facts the prompt did not give', () => {
  it('flags the invented date and venue from the live charity run', () => {
    expect(facts('Charity 5K · Saturday, June 14 · City Park')).toEqual([
      ['date', 'Saturday'],
      ['date', 'June 14'],
      ['place', 'City Park'],
    ]);
  });

  it('flags every kind of specific fact', () => {
    expect(facts('Sat, Jun 14 · 9am')).toEqual([
      ['date', 'Sat'],
      ['date', 'Jun 14'],
      ['time', '9am'],
    ]);
    expect(facts('Doors 7:30 PM · 2026')).toEqual([
      ['time', '7:30 PM'],
      ['date', '2026'],
    ]);
    expect(facts('$25 entry · 500+ runners · 50% off')).toEqual([
      ['price', '$25'],
      ['number', '500+'],
      ['price', '50% off'],
    ]);
    expect(facts('Free entry')).toEqual([['price', 'Free entry']]);
    expect(facts('Call (555) 123-4567')).toEqual([['phone', '(555) 123-4567']]);
    expect(facts('www.run5k.org · @runforhope · hello@run.org')).toEqual([
      ['url', 'www.run5k.org'],
      ['url', '@runforhope'],
      ['email', 'hello@run.org'],
    ]);
    expect(facts('Join us at Riverside Park')).toEqual([['place', 'Riverside Park']]);
    expect(facts('featuring DJ Nova, hosted by Acme Running Club')).toEqual([
      ['name', 'DJ Nova'],
      ['name', 'Acme Running Club'],
    ]);
  });

  it('leaves generic copy, titles and placeholders alone', () => {
    for (const text of [
      'Run For Hope',
      'Every Step Counts',
      'Register Now',
      'Hit The Beach',
      'Farmers Market',
      'Run With Heart',
      'Join with Friends',
      'Sun-soaked fun',
      'Charity 5K · [Date] · [Venue]',
      'Run 5 km for a cause',
    ]) {
      expect(facts(text), text).toEqual([]);
    }
  });

  it('accepts facts the prompt gives, in other spellings', () => {
    const prompt =
      'flyer for a bake sale on Saturday June 14th at City Park, 9am-1pm, cookies $2, call 555-123-4567, bakesale.org';
    expect(facts('Saturday, June 14 · City Park', prompt)).toEqual([]);
    expect(facts('Sat 6/14 · 9:00 AM', prompt)).toEqual([]);
    expect(facts('Cookies $2.00 · Call 555 123 4567 · www.bakesale.org', prompt)).toEqual([]);
    // ...but not a different date or venue.
    expect(facts('June 15 · Town Hall', prompt)).toEqual([
      ['date', 'June 15'],
      ['place', 'Town Hall'],
    ]);
  });

  it('does not read "sun" in the prompt as Sunday', () => {
    expect(facts('Sunday Funday', 'sun-drenched beach party')).toEqual([['date', 'Sunday']]);
  });

  it('reports positions so a fix can target the exact text', () => {
    const text = 'Charity 5K · Saturday, June 14 · City Park';
    for (const f of extractFacts(text))
      expect(text.slice(f.index, f.index + f.text.length)).toBe(f.text);
  });
});

describe('copy-grounded rule', () => {
  const design = (subheading: string) =>
    parseDesign({
      version: '0.1',
      canvas: { width: 1080, height: 1350, background: '#123456' },
      elements: [
        {
          id: 'headline',
          type: 'text',
          role: 'headline',
          x: 80,
          y: 100,
          width: 920,
          height: 160,
          content: 'Run For Hope',
          fontSize: 120,
          color: '#ffffff',
        },
        {
          id: 'subheading',
          type: 'text',
          role: 'subheading',
          x: 80,
          y: 300,
          width: 920,
          height: 60,
          content: subheading,
          fontSize: 40,
          color: '#ffffff',
        },
      ],
    });
  const run = (subheading: string) =>
    check(design(subheading), {
      rules: [...builtinRules, createCopyGroundedRule([CHARITY])],
      measurer: createFontMeasurer(),
    });

  it('is an error that keeps the design below the target', () => {
    const report = run('Charity 5K · Saturday, June 14 · City Park');
    const issue = report.issues.find((i) => i.ruleId === 'copy-grounded');
    expect(issue).toMatchObject({ severity: 'error', elementIds: ['subheading'], measured: 3 });
    expect(issue!.message).toContain('"June 14" (date)');
    expect(issue!.message).toContain('[Venue]');
    expect(report.passed).toBe(false);
    expect(report.score).toBeLessThan(95);
  });

  it('passes once the facts are placeholders', () => {
    const report = run('Charity 5K · [Date] · [Venue]');
    expect(report.issues.filter((i) => i.ruleId === 'copy-grounded')).toEqual([]);
  });
});

describe('fact replacements allowed in the fix loop', () => {
  const content = 'Charity 5K · Saturday, June 14 · City Park';
  const allowed = (find: string, replace: string) =>
    checkFactReplacement(content, find, replace, [CHARITY]);

  it('allows replacing flagged facts (with their separators) by a placeholder or nothing', () => {
    expect(allowed('Saturday, June 14', '[Date]')).toBeNull();
    expect(allowed('City Park', '[Venue]')).toBeNull();
    expect(allowed(' · City Park', '')).toBeNull();
    expect(allowed(' · Saturday, June 14 · City Park', ' · [Date] · [Venue]')).toMatch(
      /one placeholder/,
    );
  });

  it('refuses anything else', () => {
    expect(allowed('Charity 5K', '[Event]')).toMatch(/no fact flagged/);
    expect(allowed('City Park', 'Town Hall')).toMatch(/bracketed placeholder/);
    expect(allowed('Charity 5K · Saturday, June 14', '[Date]')).toMatch(/besides the flagged/);
    expect(allowed('June', '[Date]')).toMatch(/no fact flagged/);
    expect(allowed('Sunday', '[Date]')).toMatch(/does not occur/);
  });
});

describe('art director plans', () => {
  it('lists invented facts in the copy for the retry', () => {
    const plan = templatePlan(brief());
    expect(planFactProblems(plan, [CHARITY])).toEqual([]);
    plan.copy.subheading = 'Saturday, June 14 · City Park';
    const problems = planFactProblems(plan, [CHARITY]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"City Park" (place)');
    expect(problems[0]).toContain('[Date] or [Venue]');
  });
});
