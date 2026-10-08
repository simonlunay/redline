/**
 * Cutout quality: measures what goes wrong when a subject is cut out of its backdrop, from the
 * cutout's own pixels. Deterministic, model-free and isomorphic (plain RGBA arrays).
 *
 * The signals come from the failures in the first generation eval, where every broken cutout was
 * made by the backdrop keyer: bites out of a bottle's shoulder, a see-through latte glass, grey
 * discs of backdrop left inside a headband, white floor slabs under a runner and a dog, and a
 * shoe that was never cut out of its photo at all.
 */

export interface CutoutMetrics {
  /** Opaque subject area in px (alpha >= 128). */
  area: number;
  /**
   * Area a morphological closing adds, relative to the subject: notches and tears bitten out of
   * the outline. Concave shapes (a runner's legs) add some too, so the threshold is generous.
   */
  bites: number;
  /** Share of the subject's interior (away from its edge) that is partly transparent. */
  seeThrough: number;
  /** Share of the opaque area in small, detached fragments (stray backdrop bits, torn pieces). */
  fragments: number;
  /** Number of those fragments. */
  fragmentCount: number;
  /** Share of the subject covered by flat, backdrop-colored regions touching its outline. */
  leftoverBackdrop: number;
  /** Image sides (of 4) that the opaque subject runs along for more than 30% of their length. */
  sidesTouched: number;
  /** Outline length relative to a smoothed outline: 1 is clean, higher is jagged. */
  edgeNoise: number;
  /** The backdrop color used for leftoverBackdrop: given, or estimated from the soft edge. */
  backdrop: [number, number, number];
}

export type CutoutProblem =
  'bites' | 'see-through' | 'fragments' | 'leftover-backdrop' | 'uncut' | 'jagged-edges';

export interface CutoutVerdict {
  severity: 'ok' | 'warning' | 'error';
  problems: {
    kind: CutoutProblem;
    severity: 'warning' | 'error';
    measured: number;
    limit: number;
  }[];
  metrics: CutoutMetrics;
}

/**
 * Warning and error levels per signal, tuned on the 26 subject cutouts of the phase 4 eval
 * (9 visibly damaged, labeled by eye). Errors there: 7 of the 9 damaged, none of the 17 good.
 */
export const CUTOUT_THRESHOLDS: Record<
  CutoutProblem,
  { metric: keyof CutoutMetrics; warning: number; error: number }
> = {
  bites: { metric: 'bites', warning: 0.04, error: 0.055 },
  'see-through': { metric: 'seeThrough', warning: 0.04, error: 0.1 },
  fragments: { metric: 'fragments', warning: 0.001, error: 0.005 },
  // Alone this is only ever a warning: a flat white laptop screen or cup looks the same in
  // pixels as backdrop left inside a headband's loop. See judgeCutout.
  'leftover-backdrop': { metric: 'leftoverBackdrop', warning: 0.15, error: 0.2 },
  uncut: { metric: 'sidesTouched', warning: 3, error: 3 },
  'jagged-edges': { metric: 'edgeNoise', warning: 1.3, error: 1.6 },
};

const OPAQUE = 128;

interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/**
 * Chamfer distance transform (3-4 metric, in px): distance from every pixel to the nearest pixel
 * where `inside` is 0. Two passes, O(n). Pixels outside the image are ignored, so a subject cut
 * by the frame isn't eroded from there.
 */
function chamfer(inside: Uint8Array, width: number, height: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? INF : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + 3);
      if (y > 0) {
        v = Math.min(v, d[i - width]! + 3);
        if (x > 0) v = Math.min(v, d[i - width - 1]! + 4);
        if (x < width - 1) v = Math.min(v, d[i - width + 1]! + 4);
      }
      d[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let v = d[i]!;
      if (x < width - 1) v = Math.min(v, d[i + 1]! + 3);
      if (y < height - 1) {
        v = Math.min(v, d[i + width]! + 3);
        if (x < width - 1) v = Math.min(v, d[i + width + 1]! + 4);
        if (x > 0) v = Math.min(v, d[i + width - 1]! + 4);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = d[i]! / 3;
  return d;
}

/** Dilation (r > 0) or erosion (r < 0) of a binary mask by a disc of radius |r| (chamfer). */
function morph(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  if (r >= 0) {
    const inv = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
    const d = chamfer(inv, width, height);
    for (let i = 0; i < mask.length; i++) out[i] = d[i]! <= r ? 1 : 0;
  } else {
    const d = chamfer(mask, width, height);
    for (let i = 0; i < mask.length; i++) out[i] = d[i]! > -r ? 1 : 0;
  }
  return out;
}

const count = (mask: Uint8Array) => mask.reduce((s, v) => s + v, 0);

/** Pixels of `mask` with at least one 4-neighbour outside it (or on the image border). */
function boundaryCount(mask: Uint8Array, width: number, height: number): number {
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (
        (x > 0 && !mask[i - 1]) ||
        (x < width - 1 && !mask[i + 1]) ||
        (y > 0 && !mask[i - width]) ||
        (y < height - 1 && !mask[i + width])
      )
        n++;
    }
  }
  return n;
}

/** 8-connected components: a label per pixel (0 = background) and each label's size. */
function components(mask: Uint8Array, width: number, height: number) {
  const labels = new Int32Array(mask.length);
  const sizes = [0];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = sizes.length;
    sizes.push(0);
    labels[start] = label;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      sizes[label]!++;
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (mask[j] && !labels[j]) {
            labels[j] = label;
            stack.push(j);
          }
        }
      }
    }
  }
  return { labels, sizes };
}

/** sRGB (0-255) to CIELAB, D65. */
export function toLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1]! : 0;
};

/**
 * Measures a cutout. `backdrop` is the color the subject was shot on, when known (the keyer
 * knows it); otherwise it's estimated from the semi-transparent edge, where keyed pixels keep
 * the backdrop's color, falling back to the light grey the subject prompt asks for.
 */
export function measureCutout(image: Rgba, backdrop?: [number, number, number]): CutoutMetrics {
  const { width, height, data } = image;
  const n = width * height;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3]! >= OPAQUE ? 1 : 0;
  const area = count(mask);
  const size = Math.max(width, height);
  const empty: CutoutMetrics = {
    area,
    bites: 0,
    seeThrough: 0,
    fragments: 0,
    fragmentCount: 0,
    leftoverBackdrop: 0,
    sidesTouched: 0,
    edgeNoise: 1,
    backdrop: backdrop ?? [211, 211, 211],
  };
  if (area < 16) return empty;

  // Fragments: everything outside the largest components that hold 95% of the area.
  const { sizes } = components(mask, width, height);
  const order = sizes
    .map((s, label) => ({ s, label }))
    .slice(1)
    .sort((a, b) => b.s - a.s);
  let covered = 0;
  const main = new Set<number>();
  for (const { s, label } of order) {
    if (covered >= 0.95 * area && s < 0.02 * area) break;
    main.add(label);
    covered += s;
  }
  // Specks below this size are noise, not visible fragments.
  const minFragment = Math.max(12, (size * size) / 40_000);
  let fragmentArea = 0;
  let fragmentCount = 0;
  for (const { s, label } of order) {
    if (main.has(label) || s < minFragment) continue;
    fragmentArea += s;
    fragmentCount++;
  }

  // Bites: what a closing with a radius of 1.5% of the subject's size fills in: notches and
  // tears. Natural concavities (between a runner's legs) are mostly wider than that.
  const r = Math.max(2, 0.015 * size);
  const closed = morph(morph(mask, width, height, r), width, height, -r);
  let filled = 0;
  for (let i = 0; i < n; i++) if (closed[i] && !mask[i]) filled++;
  const bites = filled / area;

  // See-through: partly transparent pixels well inside the subject (> 2% of its size from the
  // edge, where soft anti-aliasing is normal). Fully transparent holes count as bites instead.
  const interior = morph(mask, width, height, -Math.max(2, 0.02 * size));
  let interiorArea = 0;
  let partial = 0;
  for (let i = 0; i < n; i++) {
    if (!interior[i]) continue;
    interiorArea++;
    if (data[i * 4 + 3]! < 230) partial++;
  }
  const seeThrough = interiorArea > 0 ? partial / interiorArea : 0;

  // Backdrop color: the soft edge of a keyed cutout keeps the backdrop's color.
  let bg = backdrop;
  if (!bg) {
    const ch: number[][] = [[], [], []];
    for (let i = 0; i < n; i++) {
      const a = data[i * 4 + 3]!;
      if (a > 8 && a < 200) for (let c = 0; c < 3; c++) ch[c]!.push(data[i * 4 + c]!);
    }
    const estimate = ch.map(median) as [number, number, number];
    const [, ea, eb] = toLab(...estimate);
    // Only trust a near-neutral estimate; the prompt asks for a light grey backdrop.
    bg = ch[0]!.length > 50 && Math.hypot(ea, eb) < 12 ? estimate : [211, 211, 211];
  }
  const bgLab = toLab(...bg);

  // Leftover backdrop: flat, near-neutral regions close to the backdrop color. Flat = low local
  // variation, so a white cup's shading or a laptop's UI mostly doesn't count. Enclosed regions
  // count too: the keyer only removes backdrop it can reach from the border, so the inside of a
  // headband's loop stays opaque grey.
  const like = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const lab = toLab(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!);
    const chroma = Math.hypot(lab[1], lab[2]);
    const dE = Math.hypot(lab[0] - bgLab[0], lab[1] - bgLab[1], lab[2] - bgLab[2]);
    if (chroma < 10 && dE < 14) like[i] = 1;
  }
  const flat = new Uint8Array(n);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!like[i]) continue;
      let lo = 255;
      let hi = 0;
      for (const j of [i - width - 1, i - width + 1, i + width - 1, i + width + 1, i]) {
        const v = data[j * 4 + 1]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo <= 10) flat[i] = 1;
    }
  }
  let leftover = 0;
  const minRegion = 0.01 * area;
  for (const s of components(flat, width, height).sizes.slice(1)) if (s >= minRegion) leftover += s;

  // Uncut: the opaque subject runs along an image side (the trim leaves a ~1% margin otherwise).
  const side = (len: number, at: (k: number) => number) => {
    let hits = 0;
    for (let k = 0; k < len; k++) if (mask[at(k)]) hits++;
    return hits / len > 0.3 ? 1 : 0;
  };
  const sidesTouched =
    side(width, (k) => k) +
    side(width, (k) => (height - 1) * width + k) +
    side(height, (k) => k * width) +
    side(height, (k) => k * width + width - 1);

  // Edge noise: outline length against the outline of the same mask after a small open+close.
  const s = Math.max(1, Math.round(0.004 * size));
  const smooth = morph(
    morph(morph(morph(mask, width, height, -s), width, height, s), width, height, s),
    width,
    height,
    -s,
  );
  const edgeNoise =
    boundaryCount(mask, width, height) / Math.max(1, boundaryCount(smooth, width, height));

  return {
    area,
    bites,
    seeThrough,
    fragments: fragmentArea / area,
    fragmentCount,
    leftoverBackdrop: leftover / area,
    sidesTouched,
    edgeNoise,
    backdrop: bg,
  };
}

/**
 * Applies the thresholds. Errors: any signal past its error level (leftover backdrop only with
 * another signal backing it up), two or more stray fragments, or two warnings at once.
 */
export function judgeCutout(metrics: CutoutMetrics): CutoutVerdict {
  const problems: CutoutVerdict['problems'] = [];
  for (const [kind, t] of Object.entries(CUTOUT_THRESHOLDS) as [
    CutoutProblem,
    (typeof CUTOUT_THRESHOLDS)[CutoutProblem],
  ][]) {
    const measured = metrics[t.metric] as number;
    if (measured >= t.error) problems.push({ kind, severity: 'error', measured, limit: t.error });
    else if (measured >= t.warning)
      problems.push({ kind, severity: 'warning', measured, limit: t.warning });
  }
  const leftover = problems.find((p) => p.kind === 'leftover-backdrop');
  const corroborated =
    metrics.edgeNoise >= 1.2 || metrics.sidesTouched >= 1 || metrics.fragmentCount > 0;
  if (leftover?.severity === 'error' && !corroborated) {
    leftover.severity = 'warning';
    leftover.limit = CUTOUT_THRESHOLDS['leftover-backdrop'].warning;
  }
  const fragments = problems.find((p) => p.kind === 'fragments');
  if (fragments && metrics.fragmentCount >= 2) fragments.severity = 'error';
  // Two warnings make an error, unless one of them is an uncorroborated leftover.
  const others = problems.filter((p) => p !== leftover || corroborated);
  const severity =
    problems.some((p) => p.severity === 'error') || others.length >= 2
      ? 'error'
      : problems.length
        ? 'warning'
        : 'ok';
  return { severity, problems, metrics };
}
