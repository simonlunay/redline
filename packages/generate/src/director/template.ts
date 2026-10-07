import type { DesignPlan, ImageSlot, Layout, PlanElement } from '../plan.js';
import type { ArtDirector, CreativeBrief } from './types.js';

/**
 * Deterministic, offline art director: fixed layout templates scaled to the canvas, copy and
 * colors pulled from the prompt with simple heuristics. It exists so tests, demos without a key
 * and the mock pipeline exercise exactly the same code path as Claude's plans. It is not meant
 * to be a good designer.
 */
export function createTemplateArtDirector(): ArtDirector {
  return {
    name: 'template',
    async plan(brief) {
      return { plan: templatePlan(brief), calls: 0 };
    },
  };
}

const COLORS: Record<string, string> = {
  blue: '#1d4ed8',
  navy: '#1e3a8a',
  orange: '#f97316',
  red: '#dc2626',
  green: '#16a34a',
  teal: '#0d9488',
  purple: '#7c3aed',
  pink: '#db2777',
  yellow: '#facc15',
  gold: '#d4a017',
  black: '#111111',
  white: '#ffffff',
  brown: '#92400e',
};

const titleCase = (s: string) =>
  s
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();

/** "poster for a charity 5K, energetic, blue and orange" -> "Charity 5K". */
export function headlineFromPrompt(prompt: string): string {
  const first = prompt.split(/[,.;:!\n]/)[0] ?? prompt;
  const match = /\b(?:for|about|announcing|promoting)\s+(?:an?\s+|the\s+|our\s+)?(.+)$/i.exec(
    first,
  );
  const phrase = (match?.[1] ?? first).split(/\s+/).slice(0, 6).join(' ');
  return titleCase(phrase) || 'Your Headline';
}

function paletteFromPrompt(brief: CreativeBrief): DesignPlan['palette'] {
  const named = Object.keys(COLORS)
    .map((name) => ({ name, at: brief.prompt.toLowerCase().search(new RegExp(`\\b${name}\\b`)) }))
    .filter((c) => c.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((c) => COLORS[c.name]!);
  const colors = [...(brief.brandColors ?? []), ...named];
  return {
    background: '#0f172a',
    primary: colors[0] ?? '#1d4ed8',
    accent: colors[1] ?? '#f97316',
    text: '#ffffff',
    textOnAccent: '#ffffff',
  };
}

/** Line count for text at `size` in a box `width` wide (generous: bold caps run wide). */
function lines(text: string, size: number, width: number): number {
  const perLine = Math.max(1, Math.floor(width / (size * 0.6)));
  const words = text.split(/\s+/);
  let count = 1;
  let used = 0;
  for (const word of words) {
    const len = word.length + (used > 0 ? 1 : 0);
    if (used + len > perLine && used > 0) {
      count++;
      used = word.length;
    } else used += len;
  }
  return count;
}

function text(
  id: string,
  role: PlanElement['role'],
  content: string,
  box: { x: number; y: number; width: number },
  size: number,
  weight: number,
  color: string,
  align: 'left' | 'center' | 'right',
  zIndex: number,
  lineHeight = 1.15,
): PlanElement {
  const height = Math.ceil(lines(content, size, box.width) * size * lineHeight + size * 0.2);
  return {
    kind: 'text',
    id,
    role,
    ...box,
    height,
    zIndex,
    content,
    fontFamily: 'Inter',
    fontSize: Math.round(size),
    fontWeight: weight,
    color,
    align,
    lineHeight,
  };
}

/** Mood words of a prompt: everything after its first clause (the first clause holds the topic, i.e. the copy). */
function moodOf(prompt: string): string {
  const rest = prompt
    .split(/[,.;:!\n]/)
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean);
  return rest.length ? rest.join(', ') : 'bold, inviting';
}

function slots(prompt: string, calmAreas: string, subject: boolean): ImageSlot[] {
  const mood = moodOf(prompt);
  const list: ImageSlot[] = [
    {
      id: 'background',
      kind: 'background',
      brief: `Atmospheric backdrop with a ${mood} mood. Soft depth of field, gentle gradients of light.`,
      calmAreas,
      style: 'editorial photograph, soft natural light',
      stockQuery: prompt.split(/[,.]/)[0]!.split(/\s+/).slice(-4).join(' '),
      userImageId: '',
    },
  ];
  if (subject) {
    list.push({
      id: 'subject',
      kind: 'subject',
      brief: `A single hero object that fits a ${mood} theme.`,
      calmAreas: '',
      style: 'clean product photograph',
      stockQuery: '',
      userImageId: '',
    });
  }
  return list;
}

/** Rest parameter so object literals are typed as PlanElement; rounds every box. */
const els = (...list: PlanElement[]): PlanElement[] => list.map(round);

function round(el: PlanElement): PlanElement {
  return {
    ...el,
    x: Math.round(el.x),
    y: Math.round(el.y),
    width: Math.round(el.width),
    height: Math.round(el.height),
  };
}

/** Builds 1-3 layouts that scale with the canvas (stacked, bottom panel, split for banners). */
export function templatePlan(brief: CreativeBrief): DesignPlan {
  const { width: W, height: H } = brief.canvas;
  const s = Math.min(W, H);
  const m = Math.round(s * 0.08);
  const palette = paletteFromPrompt(brief);
  const copy = {
    headline: headlineFromPrompt(brief.prompt),
    subheading: 'Join us and make it count',
    body: '',
    cta: /\b(sale|shop|discount|product|launch)\b/i.test(brief.prompt) ? 'Shop now' : 'Sign up',
  };
  const wide = W / H > 1.6;
  const logo = brief.userImages?.find((u) => u.use === 'logo');

  const bg: PlanElement = {
    kind: 'image',
    id: 'background',
    role: 'background',
    x: 0,
    y: 0,
    width: W,
    height: H,
    zIndex: 0,
    slot: 'background',
  };
  const cta = (
    x: number,
    y: number,
    w: number,
    h: number,
    align: 'left' | 'center',
  ): PlanElement[] => [
    {
      kind: 'shape',
      id: 'cta-button',
      role: 'cta',
      x,
      y,
      width: w,
      height: h,
      zIndex: 3,
      shape: 'rect',
      fill: palette.accent,
      cornerRadius: Math.round(h / 2),
      opacity: 1,
    },
    {
      ...text(
        'cta-label',
        'cta',
        copy.cta,
        { x, y: 0, width: w },
        h * 0.38,
        700,
        palette.textOnAccent,
        align === 'left' ? 'center' : 'center',
        4,
        1.2,
      ),
      y: Math.round(y + h * 0.27),
      height: Math.round(h * 0.5),
    } as PlanElement,
  ];
  const logoElements = (x: number, y: number, size: number): PlanElement[] =>
    logo
      ? [
          {
            kind: 'image',
            id: 'logo',
            role: 'logo',
            x,
            y,
            width: Math.round((size * logo.width) / logo.height),
            height: size,
            zIndex: 5,
            slot: 'logo',
          },
        ]
      : [];
  const logoSlot: ImageSlot[] = logo
    ? [
        {
          id: 'logo',
          kind: 'user',
          brief: 'Brand logo',
          calmAreas: '',
          style: '',
          stockQuery: '',
          userImageId: logo.id,
        },
      ]
    : [];

  const layouts: Layout[] = [];

  if (wide) {
    // Split: text on the left 55%, subject on the right.
    const tw = W * 0.5;
    const hs = Math.min(H * 0.2, s * 0.22);
    const headline = text(
      'headline',
      'headline',
      copy.headline,
      { x: m, y: H * 0.16, width: tw },
      hs,
      900,
      palette.text,
      'left',
      2,
      1.08,
    );
    const sub = text(
      'subheading',
      'subheading',
      copy.subheading,
      { x: m, y: headline.y + headline.height + s * 0.03, width: tw },
      hs * 0.42,
      600,
      palette.text,
      'left',
      2,
    );
    const bh = Math.max(s * 0.15, 40);
    layouts.push({
      name: 'split: text left, subject right',
      rationale: 'Banners read left to right: message first, then the hero.',
      imageSlots: [
        ...slots(brief.prompt, 'Keep the left half calm and dark for the text.', true),
        ...logoSlot,
      ],
      elements: els(
        bg,
        headline,
        sub,
        ...cta(
          m,
          Math.min(H - m - bh, sub.y + sub.height + s * 0.06),
          Math.max(s * 0.55, tw * 0.45),
          bh,
          'left',
        ),
        {
          kind: 'image',
          id: 'subject',
          role: 'product',
          x: W * 0.62,
          y: H * 0.12,
          width: W * 0.3,
          height: H * 0.76,
          zIndex: 1,
          slot: 'subject',
        },
        ...logoElements(W - m - s * 0.2, m * 0.6, s * 0.12),
      ),
    });
  } else {
    // Stacked: headline top, subject center, CTA bottom.
    const hs = s * 0.1;
    const headline = text(
      'headline',
      'headline',
      copy.headline,
      { x: m, y: m * 1.2, width: W - 2 * m },
      hs,
      900,
      palette.text,
      'center',
      2,
      1.08,
    );
    const sub = text(
      'subheading',
      'subheading',
      copy.subheading,
      { x: m, y: headline.y + headline.height + s * 0.015, width: W - 2 * m },
      s * 0.042,
      600,
      palette.text,
      'center',
      2,
    );
    const bw = s * 0.46;
    const bh = s * 0.12;
    const by = H - m - bh;
    const subjectTop = sub.y + sub.height + s * 0.05;
    const subjectHeight = by - s * 0.06 - subjectTop;
    layouts.push({
      name: 'stacked: headline top, subject center, CTA bottom',
      rationale: 'Classic poster hierarchy with a clear vertical reading order.',
      imageSlots: [
        ...slots(brief.prompt, 'Keep the top third and the bottom strip calm for text.', true),
        ...logoSlot,
      ],
      elements: els(
        bg,
        headline,
        sub,
        {
          kind: 'image',
          id: 'subject',
          role: 'product',
          x: W * 0.2,
          y: subjectTop,
          width: W * 0.6,
          height: subjectHeight,
          zIndex: 1,
          slot: 'subject',
        },
        ...cta((W - bw) / 2, by, bw, bh, 'center'),
        ...logoElements(m, H - m - s * 0.08, s * 0.08),
      ),
    });

    // Bottom panel: a translucent panel holds all text over a full-bleed photo.
    const py = H * 0.6;
    const pad = s * 0.05;
    const ph = H - m - py;
    const ths = s * 0.085;
    const h2 = text(
      'headline',
      'headline',
      copy.headline,
      { x: m + pad, y: py + pad, width: W - 2 * m - 2 * pad },
      ths,
      900,
      palette.text,
      'left',
      3,
      1.08,
    );
    const s2 = text(
      'subheading',
      'subheading',
      copy.subheading,
      { x: m + pad, y: h2.y + h2.height + s * 0.01, width: W - 2 * m - 2 * pad },
      s * 0.04,
      600,
      palette.text,
      'left',
      3,
    );
    const bh2 = s * 0.11;
    layouts.push({
      name: 'bottom panel over a full-bleed photo',
      rationale: 'Lets the photo carry the mood while the panel guarantees legible text.',
      imageSlots: [
        ...slots(
          brief.prompt,
          'Keep the bottom 40% calm; put the main interest in the upper half.',
          false,
        ),
        ...logoSlot,
      ],
      elements: els(
        bg,
        {
          kind: 'shape',
          id: 'panel',
          role: 'decoration',
          x: m,
          y: py,
          width: W - 2 * m,
          height: ph,
          zIndex: 1,
          shape: 'rect',
          fill: palette.background,
          cornerRadius: Math.round(s * 0.03),
          opacity: 0.82,
        },
        h2,
        s2,
        ...cta(
          m + pad,
          Math.min(py + ph - pad - bh2, s2.y + s2.height + s * 0.04),
          s * 0.42,
          bh2,
          'left',
        ),
        ...logoElements(m, m, s * 0.08),
      ),
    });
  }

  return {
    concept: `A bold, direct take on: ${brief.prompt}`,
    palette,
    copy,
    layouts: layouts.slice(0, Math.max(1, brief.layouts)),
  };
}
