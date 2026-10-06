#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { ZodError } from 'zod';
import { checkAsync } from './core/check.js';
import { builtinRules } from './core/rules/index.js';
import { DesignValidationError } from './core/schema.js';
import { createNodeEnv, loadConfig, loadDesign } from './node/index.js';
import { renderAnnotatedPng, renderPng } from './node/render.js';
import { formatPretty } from './node/report-format.js';

/** Exit codes: 0 = no errors, 1 = design has errors, 2 = bad input or usage. */
const EXIT_OK = 0;
const EXIT_ISSUES = 1;
const EXIT_USAGE = 2;

const HELP = `
${pc.bold('redline')} - ESLint for designs

${pc.bold('Usage')}
  redline check <design.json> [options]
  redline rules                      List built-in rules and their defaults

${pc.bold('Options')}
  --format <pretty|json>   Output format (default: pretty)
  --config <path>          JSON config: { "rules": { "<rule-id>": "off" | "warning" | {...} } }
  --render <out.png>       Render the design to a PNG
  --annotate <out.png>     Render the design with issues drawn on top
  -h, --help               Show this help
  -v, --version            Show the version

Exits with code 1 when errors are found, so it can gate CI.
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

async function writePng(path: string, data: Buffer): Promise<void> {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data);
}

function listRules(): void {
  for (const rule of builtinRules) {
    console.log(
      `${pc.bold(rule.id)} ${pc.dim(`(${rule.defaultSeverity}, weight ${rule.weight})`)}`,
    );
    console.log(`  ${rule.description}`);
    console.log(pc.dim(`  options: ${JSON.stringify(rule.defaultOptions)}`));
    console.log('');
  }
}

async function runCheck(file: string, values: Record<string, string | boolean | undefined>) {
  const format = (values.format as string | undefined) ?? 'pretty';
  if (format !== 'pretty' && format !== 'json') {
    throw new UsageError(`Unknown --format "${format}". Use "pretty" or "json".`);
  }
  const config = values.config ? await loadConfig(values.config as string) : undefined;
  const loaded = await loadDesign(file);
  const env = await createNodeEnv(loaded);
  const report = await checkAsync(loaded.design, {
    config,
    measurer: env.measurer,
    sampler: env.sampler,
    render: env.render,
  });

  if (values.render) {
    await writePng(values.render as string, renderPng(loaded.design, { images: env.images }));
  }
  if (values.annotate) {
    await writePng(
      values.annotate as string,
      renderAnnotatedPng(loaded.design, report, { images: env.images }),
    );
  }

  if (format === 'json') {
    console.log(JSON.stringify({ file, ...report, warnings: env.warnings }, null, 2));
  } else {
    console.log(
      formatPretty(report, { title: file, design: loaded.design, warnings: env.warnings }),
    );
    if (values.render) console.log(pc.dim(`  rendered → ${values.render}`));
    if (values.annotate) console.log(pc.dim(`  annotated → ${values.annotate}`));
  }
  return report.passed ? EXIT_OK : EXIT_ISSUES;
}

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      format: { type: 'string' },
      config: { type: 'string' },
      render: { type: 'string' },
      annotate: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) {
    console.log(version());
    return EXIT_OK;
  }
  const [command, file, ...rest] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return values.help ? EXIT_OK : EXIT_USAGE;
  }
  if (command === 'rules') {
    listRules();
    return EXIT_OK;
  }
  if (command !== 'check') throw new UsageError(`Unknown command "${command}".`);
  if (!file) throw new UsageError('Missing design file: redline check <design.json>');
  if (rest.length > 0) throw new UsageError(`Unexpected arguments: ${rest.join(' ')}`);
  return runCheck(file, values);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof DesignValidationError) {
      console.error(pc.red(err.message));
    } else if (err instanceof ZodError) {
      console.error(
        pc.red(
          `Invalid config:\n${err.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
        ),
      );
    } else if (err instanceof UsageError) {
      console.error(pc.red(err.message));
      console.error(HELP);
    } else {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
    }
    process.exitCode = EXIT_USAGE;
  },
);
