/**
 * Which recorded runs go into the gallery. Generate runs are read from out/eval-generate/
 * (gitignored, on the machine that ran the evals); fix runs from committed results files.
 */
export interface GenerateSource {
  kind: 'generate';
  id: string;
  /** Run folder: out/eval-generate/<run>/<prompt>/ */
  dir: string;
  /** The committed results file this run belongs to (provenance). */
  results: string;
  notes?: string[];
}

export interface RecordedFixSource {
  kind: 'fix';
  from: 'recorded';
  id: string;
  fixture: string;
}

export interface StrictFixSource {
  kind: 'fix';
  from: 'strict';
  id: string;
  fixture: string;
  model: string;
  /** 0-based run index in the strict eval's results. */
  run: number;
}

export type GallerySource = GenerateSource | RecordedFixSource | StrictFixSource;

const PART2 = '2026-10-12T03-00-16-784Z_phase5b-shadows';
const SKINCARE = '2026-10-12T03-32-59-260Z_phase5b-shadows-skincare';
const TUNED = '2026-10-12T03-43-41-828Z_phase5b-shadows-tuned';
const results = (run: string) =>
  `packages/generate/eval/results/${run.replace('_', '_generate_')}.json`;

const PART2_PROMPTS = [
  'charity-5k',
  'coffee-latte',
  'sneaker-drop',
  'saas-banner',
  'jazz-night',
  'summer-sale',
  'farmers-market',
  'headphones-launch',
  'yoga-retreat',
  'pizza-delivery',
  'tech-conference',
  'pet-adoption',
  'bookstore-event',
];

export const STRICT_RESULTS =
  'packages/agent/eval/results/2026-10-07T01-25-38-380Z_strict_claude-sonnet-5-5+claude-opus-5-5.json';

export const GALLERY_SOURCES: GallerySource[] = [
  ...PART2_PROMPTS.map((p): GenerateSource => ({
    kind: 'generate',
    id: p,
    dir: `out/eval-generate/${PART2}/${p}`,
    results: results(PART2),
  })),
  {
    kind: 'generate',
    id: 'skincare-serum',
    dir: `out/eval-generate/${SKINCARE}/skincare-serum`,
    results: results(SKINCARE),
    notes: ['Re-run on its own after a Replicate server error (E9828) failed it in the main run.'],
  },
  ...['coffee-latte', 'pet-adoption', 'yoga-retreat'].map((p): GenerateSource => ({
    kind: 'generate',
    id: `${p}-tuned`,
    dir: `out/eval-generate/${TUNED}/${p}`,
    results: results(TUNED),
    notes: [
      'Re-run after the contact shadows were tuned (commit 9af86a2): wider footprint, taller ellipse, stronger default opacity.',
    ],
  })),
  { kind: 'fix', from: 'recorded', id: 'fix-worst', fixture: 'worst' },
  { kind: 'fix', from: 'recorded', id: 'fix-story-concert', fixture: 'story-concert' },
  { kind: 'fix', from: 'recorded', id: 'fix-ad-sneaker-sale', fixture: 'ad-sneaker-sale' },
  {
    kind: 'fix',
    from: 'strict',
    id: 'fix-hard-story-hero',
    fixture: 'hard-story-hero',
    model: 'claude-opus-5-5',
    run: 1,
  },
  {
    kind: 'fix',
    from: 'strict',
    id: 'fix-hard-busy-photo-tiny-cta',
    fixture: 'hard-busy-photo-tiny-cta',
    model: 'claude-opus-5-5',
    run: 0,
  },
];
