import { builtinRules, designJsonSchema } from '@simonlunay/redline';
import type { Design, Fix, Issue } from '@simonlunay/redline';
import { MAX_EDITS_PER_RESPONSE } from './edits.js';
import type { EditRequest } from './types.js';

export const SUBMIT_TOOL_NAME = 'submit_edits';

/**
 * The stable part of the prompt. It never changes between calls (no timestamps, no per-design
 * data), so it is cached once and reused for every iteration and every fixture in an eval.
 */
export function buildSystemPrompt(): string {
  const rules = builtinRules
    .map((r) => `- ${r.id} (weight ${r.weight}): ${r.description}`)
    .join('\n');

  return `You are a senior graphic designer repairing a design (poster, social post or ad) so it passes an automated design checker called Redline.

# How this works
You are called in a loop. Each time you get the current design as JSON, an annotated render, the checker's score (0-100) and its issues, then you respond by calling the ${SUBMIT_TOOL_NAME} tool exactly once with a list of edits. The edits are applied, the design is re-checked, and you are called again with the result. An iteration whose edits LOWER the score is rolled back and you are told what it broke. The loop ends when the score reaches the target with no errors left.

# Edit operations
All coordinates are canvas pixels, origin top-left. Every edit needs a short "reason".
- move {elementId, dx, dy}: shift an element.
- resize {elementId, width, height}: set the box size; the top-left corner stays put. For images, keep the natural aspect ratio (naturalWidth/naturalHeight) unless fit is "cover" or "contain".
- setColor {elementId, color}: text color for text, fill for shapes. Hex only.
- setFontSize {elementId, fontSize} and setFontWeight {elementId, fontWeight}.
- insertShape {behindElementId, kind, x, y, width, height, fill, opacity, cornerRadius}: adds a decoration shape painted directly behind an element. Use it as a backing panel or translucent scrim behind text that sits on a photo (e.g. fill #000000, opacity 0.45-0.65, slightly larger than the text box with ~24px padding). This usually fixes contrast on images while keeping white text, which looks far better than recoloring the text to grey.

# Hard rules
- You cannot and must not change text content, font family or image sources. Only layout and styling.
- Use only element ids that exist in the design (or ids created by your insertShape edits, which are reported back).
- At most ${MAX_EDITS_PER_RESPONSE} edits per response, applied in order. Prefer fewer, deliberate edits.

# Strategy
- Fix errors first, then warnings. Info issues are optional.
- Each issue may include the checker's suggested fix. Treat it as a hint, not an order: it only knows about one rule. Before using it, check the side effects with the layout table, e.g. a text box that grows downwards can run into the element below, and moving an element can break an alignment or margin.
- Reason about the whole layout: keep a consistent left edge or center axis, keep ~5% margins from the canvas edges, keep the headline the most prominent text, and keep key elements (headline, product, logo, CTA) from overlapping.
- If an attempt was rolled back, do not repeat it; read what it broke and try a different approach.
- If there is nothing worth changing, return an empty edits list.

# Checker rules
${rules}

Scoring: each issue removes (8 for errors, 3 for warnings, 0.5 for info) x rule weight percent of its rule's score; the overall score is the product of the rule scores, so every failing rule pulls it down.

# Design format (JSON Schema)
${JSON.stringify(designJsonSchema())}`;
}

function describeFix(fix: Fix): string {
  const { op, ...rest } = fix;
  return `${op} ${JSON.stringify(rest)}`;
}

function formatIssue(issue: Issue, n: number): string {
  const unit = issue.unit === ':1' ? ':1' : issue.unit ? ` ${issue.unit}` : '';
  const lines = [
    `${n}. [${issue.severity}] [${issue.ruleId}] elements ${issue.elementIds.join(', ') || '-'}: ${issue.message} (measured ${issue.measured}${unit}, threshold ${issue.threshold}${unit})`,
  ];
  for (const fix of issue.fix ?? []) lines.push(`   suggested: ${describeFix(fix)}`);
  return lines.join('\n');
}

/** Compact table of every element in paint order, so spatial reasoning doesn't need the JSON. */
export function layoutTable(design: Design): string {
  const rows = design.elements
    .map((el, index) => ({ el, index }))
    .sort((a, b) => a.el.zIndex - b.el.zIndex || a.index - b.index)
    .map(({ el }) => {
      const box = `x=${el.x} y=${el.y} w=${el.width} h=${el.height} (right=${el.x + el.width}, bottom=${el.y + el.height})`;
      const extra =
        el.type === 'text'
          ? `${el.fontSize}px/${el.fontWeight} ${el.color} align=${el.align} "${el.content.slice(0, 40)}"`
          : el.type === 'shape'
            ? `${el.kind} ${el.fill}${el.opacity < 1 ? ` opacity=${el.opacity}` : ''}`
            : `natural ${el.naturalWidth}x${el.naturalHeight} fit=${el.fit}`;
      return `- ${el.id} [${el.type}${el.role ? `, ${el.role}` : ''}] z=${el.zIndex} ${box} ${extra}`;
    });
  return `Canvas ${design.canvas.width}x${design.canvas.height}, background ${design.canvas.background}. Elements bottom to top:\n${rows.join('\n')}`;
}

/** The per-iteration message: everything that changes between calls. */
export function buildUserMessage(req: EditRequest): string {
  const { report } = req;
  const sections = [
    `Iteration ${req.iteration}. Current score ${report.score}/100 (target ${req.target} with no errors). ${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.infos} info.`,
    `# Issues (most severe first)\n${report.issues.map((issue, i) => formatIssue(issue, i + 1)).join('\n') || 'None.'}`,
    `# Layout\n${layoutTable(req.design)}`,
  ];
  if (req.attempts.length > 0) {
    sections.push(
      `# Previous attempts that did not stick\n${req.attempts
        .map((a) => `- iteration ${a.iteration} (${a.outcome}): ${a.message}`)
        .join('\n')}`,
    );
  }
  sections.push(`# Design JSON\n${JSON.stringify(req.design)}`);
  if (req.validationError) {
    sections.push(
      `# Your previous response was invalid\n${req.validationError}\nCall ${SUBMIT_TOOL_NAME} again with corrected input.`,
    );
  }
  sections.push(`Call ${SUBMIT_TOOL_NAME} now.`);
  return sections.join('\n\n');
}
