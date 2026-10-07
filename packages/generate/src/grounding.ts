import { defineRule } from '@simonlunay/redline';
import type { RuleIssue } from '@simonlunay/redline';

/**
 * Content faithfulness for generated designs: finds specific facts in the copy (dates, times,
 * prices, numbers, places, names, phone numbers, URLs, emails) and flags the ones the user's
 * prompt doesn't support. The checker can't know what's true, but it can know what was given.
 *
 * Pattern-based and deterministic, so it's cheap and predictable. It catches the shapes invented
 * facts usually take ("Saturday, June 14 · City Park", "$25 entry", "www.run5k.org", "featuring
 * DJ Nova"); it doesn't know arbitrary proper nouns, so a made-up place without a place word
 * ("Riverside") gets through. Bracketed placeholders like [Date] are never flagged.
 */

export type FactKind =
  'date' | 'time' | 'price' | 'number' | 'phone' | 'url' | 'email' | 'place' | 'name';

export interface Fact {
  kind: FactKind;
  /** The fact as written in the copy. */
  text: string;
  /** Offset in the copy. */
  index: number;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTH = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?`;
const DAY = String.raw`\d{1,2}(?:st|nd|rd|th)?`;
/** Words that start a capitalized run but aren't part of a name ("Hit The Beach"). */
const STOPWORDS = new Set(
  'a an and at by for from in into of on or our the this that to with your you we us join get be is are now new all'.split(
    ' ',
  ),
);
const CAP_WORD = String.raw`[A-Z][\p{L}'’&-]*`;
const PLACE_WORDS = String.raw`(?:Park|Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Square|Plaza|Hall|Center|Centre|Stadium|Arena|Field|Fields|Beach|Gardens?|Library|Museum|Theat(?:er|re)|Church|School|University|College|Pier|Market|Bridge|Harbou?r|Lake|Trail|Campus|Ballroom|Hotel|Pavilion|Commons|Green|Quay|Wharf)`;

/** Ordered: earlier patterns claim their span first, so "June 14" isn't also a number. */
const PATTERNS: [FactKind, RegExp][] = [
  ['email', /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gu],
  [
    'url',
    /(?:\bhttps?:\/\/|\bwww\.)[^\s,;]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co|edu|gov|app|dev|info|biz|us|uk|ca|au|de|fr|run|events?|shop|store)\b(?:\/[^\s,;]*)?/giu,
  ],
  ['url', /(?<![\w@])@[A-Za-z0-9_]{2,}/gu],
  [
    'date',
    new RegExp(
      String.raw`\b(?:${MONTH}\s+${DAY}(?:,?\s+\d{4})?|${DAY}\s+(?:of\s+)?${MONTH}(?:,?\s+\d{4})?|${MONTH}\s+\d{4})\b`,
      'giu',
    ),
  ],
  [
    'date',
    /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/gu,
  ],
  ['date', /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\.?(?=,\s*(?:\d|[a-z]{3}))/giu],
  ['date', /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/giu],
  // "May" and "March" are also words; alone they only count next to a day (handled above).
  [
    'date',
    /\b(?:january|february|april|june|july|august|september|october|november|december)\b/giu,
  ],
  ['date', /\b(?:19|20)\d{2}\b/gu],
  [
    'time',
    /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])|\b(?:[01]?\d|2[0-3]):[0-5]\d\b/giu,
  ],
  [
    'phone',
    /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\b\d{2,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?\b/gu,
  ],
  [
    'price',
    /[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM]\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\b|\b\d+(?:\.\d+)?\s?%(?:\s*off)?|\bfree\s+(?:entry|admission|registration|tickets?|shipping|delivery|trial|parking)\b/giu,
  ],
  ['number', /\b\d[\d,]*(?:\.\d+)?(?:\s?[kKmM]\b|\+)?/gu],
  [
    'place',
    new RegExp(
      // Only after a separator or a preposition: "· City Park", "at Riverside Park". At the
      // start of a text it's more likely a title ("Farmers Market"), so that isn't flagged.
      String.raw`(?<=(?:[·•|,:;—–(]|\s-|\b(?:at|in|near|on|from|to|@))\s*)(?:\d+\s+)?(?:${CAP_WORD}\s+){0,3}${PLACE_WORDS}\b`,
      'gu',
    ),
  ],
  [
    'name',
    new RegExp(
      String.raw`\b(?:Dr|Mr|Mrs|Ms|Mx|Prof|Chef|Coach|DJ|MC|Rev|Sir|Dame)\.?\s+${CAP_WORD}(?:\s+${CAP_WORD})?`,
      'gu',
    ),
  ],
  [
    'name',
    new RegExp(
      String.raw`(?<=\b(?:[Ff]eaturing|[Ff]eat\.|[Ff]t\.|[Ww]ith|[Hh]osted by|[Pp]resented by|[Ss]ponsored by|[Oo]rgani[sz]ed by|[Ss]tarring|[Bb]y)\s+)${CAP_WORD}(?:\s+${CAP_WORD}){1,3}`,
      'gu',
    ),
  ],
  [
    'name',
    new RegExp(
      String.raw`${CAP_WORD}(?:\s+${CAP_WORD}){0,3}\s+(?:Inc\.?|LLC|Ltd\.?|Co\.|Corp\.?|GmbH)|${CAP_WORD}(?:\s+${CAP_WORD}){0,2}\s?[™®]`,
      'gu',
    ),
  ],
];

/** Blanks out bracketed placeholders ([Date], {venue}) so they're never read as facts. */
function maskPlaceholders(text: string): string {
  return text.replace(/\[[^\]]*\]|\{[^}]*\}/g, (m) => ' '.repeat(m.length));
}

/** Trims a capitalized run so it starts at its first non-stopword ("The City Park" -> "City Park"). */
function trimLeadingStopwords(fact: Fact): Fact | null {
  const words = fact.text.split(/(\s+)/);
  let skip = 0;
  let offset = 0;
  while (skip < words.length - 1 && STOPWORDS.has(words[skip]!.toLowerCase())) {
    offset += words[skip]!.length + (words[skip + 1]?.length ?? 0);
    skip += 2;
  }
  const text = words.slice(skip).join('');
  if (!text.trim()) return null;
  return { ...fact, text, index: fact.index + offset };
}

/** All fact-like spans in a piece of copy, in reading order. */
export function extractFacts(text: string): Fact[] {
  const masked = maskPlaceholders(text);
  const taken: boolean[] = new Array(masked.length).fill(false);
  const facts: Fact[] = [];
  for (const [kind, pattern] of PATTERNS) {
    for (const m of masked.matchAll(pattern)) {
      let fact: Fact | null = { kind, text: m[0].trim(), index: m.index + m[0].search(/\S/) };
      if (!fact.text) continue;
      if (kind === 'place' || kind === 'name') {
        fact = trimLeadingStopwords(fact);
        if (!fact) continue;
        // A place needs a real name before its place word: "City Park", not just "Park".
        if (kind === 'place' && !/\s/.test(fact.text.replace(/^\d+\s+/, ''))) continue;
      }
      if (kind === 'phone' && fact.text.replace(/\D/g, '').length < 7) continue;
      const end = fact.index + fact.text.length;
      let overlaps = false;
      for (let i = fact.index; i < end; i++) if (taken[i]) overlaps = true;
      if (overlaps) continue;
      for (let i = fact.index; i < end; i++) taken[i] = true;
      facts.push(fact);
    }
  }
  return facts.sort((a, b) => a.index - b.index);
}

/** Weekday abbreviations that are also words; spelled out in the copy, not in the prompt. */
const AMBIGUOUS_ABBREVIATIONS = new Set(['sat', 'sun']);

/** Lowercase words; ordinals, abbreviated months and weekdays spelled out. */
function normalize(text: string, options: { source?: boolean } = {}): string {
  let s = text
    .toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const expand = (full: string) => (w: string) =>
    full.startsWith(w) && !(options.source && AMBIGUOUS_ABBREVIATIONS.has(w)) ? full : w;
  for (const month of MONTHS) {
    s = s.replace(new RegExp(String.raw`\b${month.slice(0, 3)}[a-z]*\b`, 'g'), expand(month));
  }
  for (const day of WEEKDAYS) {
    s = s.replace(new RegExp(String.raw`\b${day.slice(0, 3)}[a-z]*\b`, 'g'), expand(day));
  }
  return s;
}

const contains = (haystack: string, needle: string) =>
  needle !== '' && ` ${haystack} `.includes(` ${needle} `);

/** Numbers as plain digit strings: "$1,250.00" -> "1250", "5K" -> "5". */
function numbersIn(text: string): string[] {
  return [...text.replace(/(\d),(\d{3})/g, '$1$2').matchAll(/\d+(?:\.\d+)?/g)].map((m) =>
    m[0].replace(/\.0+$/, ''),
  );
}

/** Month-day pairs ("6-14") in any format: "June 14", "14th of June", "6/14". */
function monthDays(text: string, options: { source?: boolean } = {}): string[] {
  const n = normalize(text, options);
  const out: string[] = [];
  for (const m of n.matchAll(/\b([a-z]+) (\d{1,2})\b|\b(\d{1,2}) (?:of )?([a-z]+)\b/g)) {
    const month = MONTHS.indexOf(m[1] ?? m[4] ?? '');
    if (month >= 0) out.push(`${month + 1}-${Number(m[2] ?? m[3])}`);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g))
    out.push(`${Number(m[1])}-${Number(m[2])}`);
  for (const m of text.matchAll(/\b\d{4}-(\d{1,2})-(\d{1,2})\b/g))
    out.push(`${Number(m[1])}-${Number(m[2])}`);
  return out;
}

/** "9am", "9:00 AM" and "9 a.m." all become "9:00am"; 24h times stay as they are. */
function times(text: string): string[] {
  return [
    ...text.toLowerCase().matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/g),
  ].flatMap((m) =>
    m[2] === undefined && !m[3] ? [] : [`${Number(m[1])}:${m[2] ?? '00'}${m[3]?.[0] ?? ''}m`],
  );
}

/** True when the sources state this fact (in any of the usual spellings). */
export function isGrounded(fact: Fact, sources: string[]): boolean {
  const joined = sources.join('\n');
  const norm = normalize(joined, { source: true });
  if (contains(norm, normalize(fact.text))) return true;
  switch (fact.kind) {
    case 'date': {
      const days = monthDays(fact.text);
      if (days.length > 0) {
        const known = new Set(monthDays(joined, { source: true }));
        return days.every((d) => known.has(d));
      }
      return false;
    }
    case 'time': {
      const known = new Set(times(joined));
      const mine = times(fact.text);
      return mine.length > 0 && mine.every((t) => known.has(t));
    }
    case 'price':
    case 'number': {
      if (/free/i.test(fact.text)) return /\bfree\b/i.test(joined);
      const known = new Set(numbersIn(joined));
      const mine = numbersIn(fact.text);
      return mine.length > 0 && mine.every((n) => known.has(n));
    }
    case 'phone': {
      const digits = fact.text.replace(/\D/g, '');
      return joined.replace(/\D/g, '').includes(digits);
    }
    case 'url':
    case 'email': {
      const bare = (s: string) => s.toLowerCase().replace(/^https?:\/\/|^www\.|\/$/g, '');
      return joined.toLowerCase().includes(bare(fact.text));
    }
    default:
      return false;
  }
}

/** Facts in `text` that none of the sources (the prompt, supplied descriptions) state. */
export function findUngroundedFacts(text: string, sources: string[]): Fact[] {
  return extractFacts(text).filter((fact) => !isGrounded(fact, sources));
}

const PLACEHOLDER: Record<FactKind, string> = {
  date: '[Date]',
  time: '[Time]',
  price: '[Price]',
  number: '[Number]',
  phone: '[Phone]',
  url: '[Website]',
  email: '[Email]',
  place: '[Venue]',
  name: '[Name]',
};

export const placeholderFor = (kind: FactKind) => PLACEHOLDER[kind];

/** One line per element, e.g. `"Saturday" (date), "City Park" (place)`. */
export function describeFacts(facts: Fact[]): string {
  return facts.map((f) => `"${f.text}" (${f.kind})`).join(', ');
}

/**
 * The checker rule for generation mode: an error on every text element that states facts the
 * prompt doesn't. Built per generation from the prompt (and any supplied image descriptions).
 */
export function createCopyGroundedRule(sources: string[]) {
  return defineRule({
    id: 'copy-grounded',
    description:
      "Generated copy that states specific facts (dates, times, places, prices, numbers, names, phone numbers, URLs) the user's prompt didn't give. They look finished but would ship wrong; replace each with a bracketed placeholder like [Date] or remove it.",
    defaultSeverity: 'error',
    weight: 3,
    defaultOptions: {},
    check({ design }) {
      const issues: RuleIssue[] = [];
      for (const el of design.elements) {
        if (el.type !== 'text') continue;
        const facts = findUngroundedFacts(el.content, sources);
        if (facts.length === 0) continue;
        const suggestions = [...new Set(facts.map((f) => placeholderFor(f.kind)))].join(', ');
        issues.push({
          elementIds: [el.id],
          message: `States ${facts.length === 1 ? 'a fact' : 'facts'} the prompt doesn't give: ${describeFacts(facts)}. Replace with a placeholder (${suggestions}) or remove.`,
          measured: facts.length,
          threshold: 0,
          unit: 'facts',
        });
      }
      return issues;
    },
  });
}

/** Separators and small words that may go with a fact when it's replaced (" · at City Park"). */
const CONNECTIVE =
  /^(?:[\s·•|,;:.()–—\-@/&+]|\b(?:at|on|in|from|to|until|and|the|by|with|featuring|feat|ft|call|visit|tickets|entry|doors|starts?|open|opens|only|per|person|each|this|every|runners?|people|participants)\b)*$/iu;

/**
 * Generation-mode guard for the fix loop's replaceText: `find` must cover whole facts that the
 * sources don't give (plus separators), and `replace` must be a bracketed placeholder or nothing.
 * Returns why the replacement isn't allowed, or null.
 */
export function checkFactReplacement(
  content: string,
  find: string,
  replace: string,
  sources: string[],
): string | null {
  const start = content.indexOf(find);
  if (start < 0) return `"${find}" does not occur in the text.`;
  const rest = replace.replace(/\[[^[\]]{1,30}\]/u, '');
  if (rest.length === replace.length && replace.trim() !== '')
    return 'The replacement must be a bracketed placeholder such as "[Date]", or "" to remove the fact.';
  if (!/^[\s·•|,;:–—-]*$/u.test(rest))
    return 'The replacement may only hold one placeholder (plus a separator); other copy changes are not allowed.';
  const end = start + find.length;
  const inside = findUngroundedFacts(content, sources).filter(
    (f) => f.index >= start && f.index + f.text.length <= end,
  );
  if (inside.length === 0)
    return `"${find}" contains no fact flagged by copy-grounded; only flagged facts can be replaced.`;
  let remainder = find;
  for (const f of [...inside].sort((a, b) => b.index - a.index)) {
    const i = f.index - start;
    remainder = remainder.slice(0, i) + ' ' + remainder.slice(i + f.text.length);
  }
  if (!CONNECTIVE.test(remainder))
    return `"${find}" includes copy besides the flagged facts ("${remainder.trim()}"); replace only the facts.`;
  return null;
}

/** The plan's copy with facts the sources don't give, for the art director's retry. */
export function planFactProblems(
  plan: {
    copy: Record<string, string>;
    layouts: { elements: { kind: string; content?: string }[] }[];
  },
  sources: string[],
): string[] {
  const texts = new Set<string>([
    ...Object.values(plan.copy),
    ...plan.layouts.flatMap((l) =>
      l.elements.flatMap((el) => (el.kind === 'text' && el.content ? [el.content] : [])),
    ),
  ]);
  const problems: string[] = [];
  for (const text of texts) {
    const facts = findUngroundedFacts(text, sources);
    if (facts.length > 0) {
      problems.push(
        `"${text}" states ${describeFacts(facts)}, which the prompt doesn't give. Remove ${facts.length === 1 ? 'it' : 'them'} or use a placeholder such as ${[...new Set(facts.map((f) => placeholderFor(f.kind)))].join(' or ')}.`,
      );
    }
  }
  return problems;
}
