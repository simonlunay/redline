# Rules, fixes and scoring

The checker runs ten layout rules by default. Two opt-in rule sets add the [attention check](attention.md) and the [image checks](judge-and-image-checks.md). Run `redline rules` to list every rule with its defaults and weight, and see [Configuration](configuration.md) to change them.

## Default rules

| Rule                 | Checks                                                            | Default thresholds                  |
| -------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| `text-contrast`      | WCAG 2.x contrast between text and **what is actually behind it** | 4.5:1 normal, 3:1 large             |
| `off-canvas`         | Elements partly (warning) or fully (error) outside the canvas     | 1px tolerance                       |
| `min-text-size`      | Text too small for the canvas                                     | 2% of short side (error < 1.4%)     |
| `image-aspect-ratio` | Images stretched compared with their natural aspect ratio         | warn ≥ 2%, error ≥ 10%              |
| `safe-margins`       | Logo, headline, CTA and text too close to the edges               | 5% of short side                    |
| `hierarchy`          | Subheading, body or CTA competing with or beating the headline    | warn at 90% of headline prominence  |
| `unintended-overlap` | Text over text or images, and key elements colliding              | error at 15% overlap                |
| `text-overflow`      | Wrapped text taller or wider than its box                         | 2px tolerance                       |
| `alignment`          | Edges or centres that are _almost_ aligned                        | ≤ 0.8% of short side                |
| `label-centered`     | Button/badge text not centred in its shape, as rendered           | 5% of the shape's short side, ≥ 3px |

## How each rule works

- **text-contrast** samples points along each _wrapped line_ (where the glyphs actually are, not the empty part of the box). At each point it composites everything painted below the text: the canvas, shapes with their opacity, and image pixels mapped through `fit`. It then takes the **worst** ratio. Font sizes are normalised to a 1080px canvas before the WCAG large-text test (24px, or 18.66px bold), so a 2160px canvas isn't judged by phone-pixel sizes. Logos and decorative text are exempt, as in WCAG. Over an image with no pixel data available, it warns that contrast _couldn't be verified_ and doesn't guess. The fix keeps the colour's hue and only shifts its lightness until the text passes.
- **off-canvas** uses the _rotated_ bounding box, so a tilted card that pokes out is caught. Backgrounds are allowed to bleed. Fix: move it back in, scaling it down first if it's bigger than the canvas.
- **min-text-size** scales with the shorter canvas side, so the same config works for a 1080×1080 post (21.6px minimum) and a 1200×628 banner (12.6px minimum).
- **image-aspect-ratio** only checks `fit: "fill"`, because cover and contain can't distort. Fix: keep the width and correct the height.
- **safe-margins** skips elements that are already off-canvas, so the same element isn't reported twice.
- **hierarchy** measures prominence as `fontSize × √(fontWeight / 400)`: size dominates, and weight helps less than linearly. Fix: shrink the competitor to 70% of the headline's prominence.
- **unintended-overlap** treats these as intentional: backgrounds, decorations, elements with the same `groupId`, and text fully on top of a shape (button labels, badges). Fix: move the element on top by the smallest push that clears the other, with a gap. A label poking out of its button is pulled back inside instead.
- **text-overflow** wraps text greedily with the `TextMeasurer` (the same wrapping the renderer uses). Fix: if a font size within 15% of the original fits, it suggests that. Otherwise it grows the box, because shrinking a headline by 40% to make it fit would just create a hierarchy problem.
- **alignment** compares like edges (left with left, centre with centre, and so on) and the canvas centre lines. To avoid false positives, it ignores pairs that are already exactly aligned on another edge (two centred texts of different widths), container/content pairs (a label inside its button), and elements already anchored by an exact alignment elsewhere.
- **label-centered** finds text that is the label of a shape: same `groupId` (a group of one shape and one text), or the only text sitting inside a shape painted below it. Panels and cards (more than 4× the text's height), full-width bands and backgrounds are skipped. It measures where the text **renders**, not its box: lines are wrapped with the `TextMeasurer`, placed by `align`, and stacked from the top of the box, which is how the renderer draws them. So a label whose box fills its button is caught sitting high, and a left-aligned label is caught sitting left. Off-centre is a warning; text touching or crossing the shape's edge is an error. Fix: shrink the box to the text block (narrowing it to the shape only if the line breaks don't change), then move it so the text is centred.

**Simplification:** overlap, margins and contrast use unrotated boxes. Only off-canvas accounts for rotation, since rotation is rare in these layouts.

## Fixes

Every fix is plain data that a program can apply without understanding the rule that produced it:

```ts
type Fix =
  | { op: 'move'; elementId: string; dx: number; dy: number }
  | { op: 'resize'; elementId: string; width: number; height: number }
  | { op: 'setColor'; elementId: string; color: string }
  | { op: 'setFontSize'; elementId: string; fontSize: number }
  | { op: 'setFontWeight'; elementId: string; fontWeight: number }
  | { op: 'setOpacity'; elementId: string; opacity: number }
  | {
      op: 'insertShape';
      behindElementId: string;
      kind: 'rect' | 'ellipse';
      x: number;
      y: number;
      width: number;
      height: number;
      fill: string;
      opacity: number;
      cornerRadius: number;
    };
```

- **`setColor`** sets the text colour on text and the fill on shapes.
- **`setOpacity`** tones an element down, e.g. a decoration that steals attention.
- **`insertShape`** adds a `decoration` shape painted directly behind an element, with a generated id like `headline-backing`. A translucent dark scrim behind white text on a photo is usually a much better contrast fix than recolouring the text grey.

Each issue has `measured` and `threshold` values (e.g. `1.24` vs `3`, unit `:1`), so a program can tell _how far off_ the design is, not only that it failed.

**`applyFixes(design, fixes)`** applies fixes in order and returns `{ design, applied, rejected, insertedIds }`:

- It's pure: the input isn't modified.
- The returned design is always schema-valid.
- Bad ops are **rejected, not thrown**: unknown ids, an op on the wrong element type (e.g. `setFontSize` on an image), invalid colours.
- Out-of-range values are **clamped**: sizes to at least 1px, font size to 1 to 1000, opacity to 0 to 1.
- No op can change text content, font family or image `src`.

**`fixJsonSchema()`** returns the `Fix` schema as JSON Schema. The [fix loop](fix-loop.md) generates its tool schema from the same Zod schema.

## Scoring

- Each issue removes `points × rule weight` percent of its rule's score. Points are error 8, warning 3 and info 0.5, so a contrast error (weight 3) removes 24%.
- The **overall score is the product of the rule scores**.
- A weighted average would let eight passing rules hide a real error: a design with a stretched image would still score 97. With a product, every failing rule pulls the total down, the score never goes negative, and issue order doesn't matter.
- `passed` is `false` whenever there's at least one error.
