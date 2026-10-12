# Design format (v0.1)

A design is JSON validated by a Zod schema (`DesignSchema`). The TypeScript types are inferred from that schema, so the validation and the types can't drift apart. `designJsonSchema()` returns the same schema as JSON Schema, for example to describe the format to an LLM.

```jsonc
{
  "version": "0.1",
  "canvas": { "width": 1080, "height": 1350, "background": "#0f172a" },
  "elements": [
    {
      "id": "headline",
      "type": "text",
      "role": "headline",
      "x": 90,
      "y": 180,
      "width": 900,
      "height": 110,
      "content": "Morning Roast",
      "fontFamily": "Inter",
      "fontSize": 96,
      "fontWeight": 900,
      "color": "#ffffff",
      "lineHeight": 1.1,
      "align": "center",
      "zIndex": 2,
    },
    {
      "id": "product",
      "type": "image",
      "role": "product",
      "x": 340,
      "y": 530,
      "width": 400,
      "height": 400,
      "src": "images/product.png",
      "naturalWidth": 800,
      "naturalHeight": 800,
      "fit": "fill",
    },
    {
      "id": "cta-button",
      "type": "shape",
      "role": "cta",
      "kind": "rect",
      "x": 390,
      "y": 1130,
      "width": 300,
      "height": 90,
      "fill": "#f97316",
      "cornerRadius": 45,
    },
  ],
}
```

## Fields

| Field                                                                             | Applies to | Notes                                                                                                                                    |
| --------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `type`, `x`, `y`, `width`, `height`                                         | all        | Pixels in canvas space. `id`s must be unique.                                                                                            |
| `rotation`                                                                        | all        | Degrees clockwise around the centre. Default `0`.                                                                                        |
| `opacity`                                                                         | all        | `0` to `1`, default `1`.                                                                                                                 |
| `zIndex`                                                                          | all        | Paint order (ties are broken by array order). Default `0`.                                                                               |
| `groupId`                                                                         | all        | Elements in the same group may overlap.                                                                                                  |
| `role`                                                                            | all        | `background` `logo` `headline` `subheading` `body` `cta` `product` `decoration`. Many rules depend on it.                                |
| `content`, `fontFamily`, `fontSize`, `fontWeight`, `color`, `lineHeight`, `align` | text       | `lineHeight` is a multiplier (like CSS). Text wraps at word boundaries within `width`.                                                   |
| `src`, `naturalWidth`, `naturalHeight`, `fit`                                     | image      | `fit`: `fill` (stretch, default), `cover` (crop), `contain` (letterbox).                                                                 |
| `kind`, `fill`, `cornerRadius`, `blur`                                            | shape      | `kind`: `rect` or `ellipse`. `blur`: Gaussian blur radius in px, default `0` (a contact shadow is a blurred ellipse). Rules use the box. |

Colours are hex: `#rgb`, `#rrggbb` or `#rrggbbaa`.

Image `src` paths are resolved relative to the design file. The web app also accepts images embedded as data URLs.

## See also

- [Rules](rules.md): what the checker measures on these fields.
- [Library](library.md): loading, checking and rendering designs from code.
