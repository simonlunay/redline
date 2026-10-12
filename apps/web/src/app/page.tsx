import Link from 'next/link';
import { CopyCommand } from '@/components/CopyCommand';
import { Player } from '@/components/Player';
import { RunCard } from '@/components/RunCard';
import { readGalleryIndex, readRun } from '@/lib/gallery/read';

const REPO = 'https://github.com/simonlunay/redline';

/** Only numbers from the README's evals, each linked to where it's measured. */
const FACTS = [
  {
    value: '62.1 → 98.8',
    text: 'Mean score of 21 deliberately broken test designs, before and after the fix loop with Claude Sonnet 5.5 (99.5 with Opus 5.5). Looping the checker’s own fixes without a model reaches 81.8.',
    href: `${REPO}#results-strict-mode`,
    source: 'Strict benchmark, 3 runs per model',
  },
  {
    value: '40 of 42',
    text: 'Before/after pairs where a blind vision judge, shown only the two images, preferred the fixed version. It never preferred the original; the 2 ties were a design the loop left unchanged.',
    href: `${REPO}#how-well-it-works`,
    source: 'Blind pairwise eval',
  },
  {
    value: '4 → 0',
    text: 'Test designs whose call to action got less than 5% of predicted attention: 4 of 21 before the fix loop, and 0 of 63 fixed versions after it, with Sonnet and with Opus alike.',
    href: `${REPO}#results-strict-mode`,
    source: 'Attention check, MSI-Net',
  },
  {
    value: '9 of 14',
    text: 'Designs generated from a one-line prompt that the independent judge would ship. The other 5 are in the gallery too, with what it still objected to.',
    href: `${REPO}/blob/main/docs/phase-5b-report.md#part-2-model-cuts-kept-contact-shadows`,
    source: 'Generate eval, phase 5b',
  },
];

export default function Home() {
  const index = readGalleryIndex();
  const demo = readRun('fix-worst');
  return (
    <main className="page home">
      <section className="hero">
        <div className="hero-text">
          <h1>
            Redline checks a design against real layout rules, then an AI fixes what it finds.
          </h1>
          <p className="lede">
            Every problem is tied to an element and comes with a fix a program can apply: contrast
            measured against what&apos;s actually behind the text, a headline sliding under the
            product, a button label that doesn&apos;t fit. Here, a test design goes from 5 to 100 in
            two rounds.
          </p>
          <div className="row">
            <Link className="button" href="/gallery/">
              Watch the recorded runs
            </Link>
            <Link className="button secondary" href="/check/">
              Check a design
            </Link>
          </div>
        </div>
        <div className="hero-demo">
          <Player record={demo} autoplay loop compact />
        </div>
      </section>

      <section className="facts-section" aria-labelledby="facts">
        <h2 id="facts">What the evals measured</h2>
        <ul className="fact-list">
          {FACTS.map((f) => (
            <li key={f.value}>
              <span className="fact-value">{f.value}</span>
              <p>{f.text}</p>
              <a href={f.href} className="fact-source">
                {f.source}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="runs-section" aria-labelledby="runs">
        <div className="section-head">
          <h2 id="runs">Recorded runs</h2>
          <Link href="/gallery/">All {index.runs.length}</Link>
        </div>
        <ol className="run-grid">
          {index.runs.slice(0, 4).map((run) => (
            <RunCard key={run.id} run={run} />
          ))}
        </ol>
      </section>

      <section className="yourself" aria-labelledby="yourself">
        <h2 id="yourself">Run it yourself</h2>
        <p>
          This site replays recorded runs and checks designs in your browser; it never calls an AI.
          The same tools run on your machine.
        </p>
        <div className="steps">
          <div>
            <h3>Check a design</h3>
            <p className="note">
              Free, offline, no key. Exit code 1 when there are errors, so it can gate CI.
            </p>
            <CopyCommand command="npx @simonlunay/redline check design.json --annotate out.png" />
          </div>
          <div>
            <h3>Fix it with Claude</h3>
            <p className="note">
              Needs <code>ANTHROPIC_API_KEY</code>. About $0.03 per design with Sonnet 5.5 in the
              eval.
            </p>
            <CopyCommand command="npm install @simonlunay/redline @simonlunay/redline-agent" />
            <CopyCommand command="npx redline fix design.json --out fixed.json --render-steps steps/" />
          </div>
          <div>
            <h3>Generate from a prompt</h3>
            <p className="note">
              Not on npm yet: run it from a clone. Needs Anthropic and Replicate keys; the evals
              averaged about $0.09 to $0.10 per design, and <code>--budget</code> caps it.
            </p>
            <CopyCommand command="git clone https://github.com/simonlunay/redline.git && cd redline && npm install" />
            <CopyCommand
              command={
                'npm run redline -- generate "poster for a charity 5K" --out out/charity.json'
              }
            />
          </div>
        </div>
        <p className="note links">
          <a href={REPO}>GitHub</a>
          <a href="https://www.npmjs.com/package/@simonlunay/redline">@simonlunay/redline on npm</a>
          <a href="https://www.npmjs.com/package/@simonlunay/redline-agent">
            @simonlunay/redline-agent on npm
          </a>
        </p>
      </section>
    </main>
  );
}
