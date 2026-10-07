import { attentionRules, builtinRules, designJsonSchema } from '@simonlunay/redline';
import type { Design, Fix, Issue } from '@simonlunay/redline';
import { MAX_EDITS_PER_RESPONSE } from './edits.js';
import type { EditRequest } from './types.js';

export const SUBMIT_TOOL_NAME = 'submit_edits';

/**
 * The stable part of the prompt. It never changes between calls (no timestamps, no per-design
 * data), so it is cached once and reused for every iteration and every fixture in an eval.
 */
export function buildSystemPrompt(options: { generation?: boolean } = {}): string {
  const rules = builtinRules
    .map((r) => `- ${r.id} (weight ${r.weight}): ${r.description}`)
    .join('\n');
  const attention = attentionRules
    .map(
      (r) =>
        `- ${r.id} (weight ${r.weight}, only when the attention check is on): ${r.description}`,
    )
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
- setOpacity {elementId, opacity}: 0-1. Useful to tone down a decoration that steals attention.
- insertShape {behindElementId, kind, x, y, width, height, fill, opacity, cornerRadius}: adds a decoration shape painted directly behind an element. Use it as a backing panel or translucent scrim behind text that sits on a photo (e.g. fill #000000, opacity 0.45-0.65, slightly larger than the text box with ~24px padding). This usually fixes contrast on images while keeping white text, which looks far better than recoloring the text to grey.

# Hard rules
- You cannot and must not change text content, font family or image sources. Only layout and styling.${
    options.generation
      ? ' Exceptions (generation mode): images listed as regenerable can be replaced with regenerateImage, and facts flagged by copy-grounded can be replaced with placeholders with replaceText.'
      : ''
  }
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
${attention}

# Attention issues
When the attention check is on, a saliency model (MSI-Net) predicts where viewers will look on the rendered design, and you also get a heatmap image. An element's "share" is the fraction of all predicted attention that lands on it (the top-most element at each point gets the credit; a CTA's button and label count together). It is a model of human eye movements on photos, so it responds to size, contrast, saturation, faces and text, and to isolation (a lone element in calm space draws the eye).
- attention-key-elements: the CTA, headline or product gets too little attention. Good fixes: make it bigger (scale the CTA button and its label together, keeping them centered), raise its contrast or saturation against its surroundings (e.g. a bright CTA button on a dark area), give it calm space around it, or move it away from busy areas. Avoid shrinking other key elements to compensate.
- attention-competition: a decoration or a background area draws more attention than the headline or CTA. Good fixes: shrink or fade the decoration (setOpacity 0.3-0.6, smaller size, a calmer color), or put a translucent dark scrim (insertShape behind the lowest content element) over a busy background area. Moving a key element into the hot area also works.
- Attention changes are holistic: one strong change usually works better than many small ones. Check the heatmap after each iteration's result.

${options.generation ? GENERATION_SECTION : ''}Scoring: each issue removes (8 for errors, 3 for warnings, 0.5 for info) x rule weight percent of its rule's score; the overall score is the product of the rule scores, so every failing rule pulls it down.

# Design format (JSON Schema)
${JSON.stringify(designJsonSchema())}`;
}

/** Extra system-prompt section in generation mode (the images were generated for this design). */
const GENERATION_SECTION = `# Generation mode: regenerating images
This design was generated: its background and subject images were made by an image model from a brief, so they can be remade. You may use one more edit op:
- regenerateImage {elementId, brief, reason}: replaces a regenerable image (listed in the request with its current brief) with a new one generated from your revised brief. The text, layout and other images stay as they are, and regenerations run before your other edits in the same response.
When to use it: only when the problem comes from the image content itself and a layout edit would be clearly worse. Typical cases: text contrast fails because the photo is busy or bright exactly where the text must sit, or attention-competition flags a background region (a face, a bright sun, a high-contrast detail) that steals attention from the headline or CTA. Prefer layout edits (a translucent scrim, moving text to a calm area, a backing panel) when they solve it cleanly; they are free and predictable.
How to write the brief: keep the subject, style and mood of the current brief, and change only what causes the problem, stated concretely and spatially, e.g. "... keep the top-left third plain, dark and low in detail for the headline; move the bright sun to the lower right". Never ask for text, letters or logos in the image.
Limits: regenerations are capped per run (the remaining count is in the request) and cost money even if the result is rolled back, so use at most one per response, and only when it is likely to help. A new image is random: it can fix the problem or create a new one, and the score decides.

# Generation mode: invented facts
The copy was written by an AI art director, which sometimes invents specifics the user never gave (a date, a venue, a price, a website). The copy-grounded rule flags them as errors, because they would ship wrong. Fix each one with:
- replaceText {elementId, find, replace, reason}: replaces the exact substring \`find\` of that text's content. \`replace\` must be a bracketed placeholder for the user to fill in ("[Date]", "[Time]", "[Venue]", "[Price]", "[Website]", "[Name]", "[Phone]") or "" to drop it. \`find\` may include the separator next to the fact (" · City Park") so nothing dangles. Only flagged facts can be replaced; any other change to the copy is refused.
Prefer a placeholder when the design clearly needs that detail (an event without a date), and removal when it was decoration. After replacing, check that the text still fits its box.

`;

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
  if (req.regeneration) {
    const { images, remaining, max } = req.regeneration;
    sections.push(
      remaining > 0 && images.length > 0
        ? `# Regenerable images (${remaining} of ${max} regenerations left)\n${images
            .map(
              (i) =>
                `- ${i.elementId} [${i.kind}${i.role ? `, ${i.role}` : ''}]: current brief: ${i.brief}`,
            )
            .join('\n')}`
        : `# Regenerable images\nNo regenerations left; use layout edits only.`,
    );
  }
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
