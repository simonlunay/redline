import { elementContainsPoint } from '../geometry.js';
import { paintOrder } from '../rules/util.js';
import type { Design, DesignElement, Role } from '../schema.js';
import type { SaliencyMap } from './saliency.js';

/** Roles whose visibility the attention rules care about, in the order they are reported. */
export const KEY_ROLES = ['headline', 'product', 'cta', 'logo'] as const;
export type KeyRole = (typeof KEY_ROLES)[number];

/** The canvas is split into GRID x GRID regions to find background hot spots. */
export const BACKGROUND_GRID = 4;

export interface BackgroundRegion {
  /** e.g. "top-right", "upper-middle-left" */
  name: string;
  col: number;
  row: number;
  /** Canvas-space box of the region. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Share of total attention landing on background inside this region. */
  share: number;
}

export interface AttentionAnalysis {
  /** elementId -> share of total attention (0..1). Background-role elements count as background. */
  elementShares: Record<string, number>;
  /** Sum of element shares per role (a CTA's button + label together). */
  roleShares: Partial<Record<Role, number>>;
  /** Highest attention density (cell value) inside each key role, used for viewing order. */
  rolePeaks: Partial<Record<KeyRole, number>>;
  /** Key roles present in the design, most likely seen first to last. */
  viewingOrder: KeyRole[];
  /** Attention on uncovered canvas and background-role elements. */
  backgroundShare: number;
  backgroundRegions: BackgroundRegion[];
}

const ROW_NAMES = ['top', 'upper-middle', 'lower-middle', 'bottom'];
const COL_NAMES = ['left', 'center-left', 'center-right', 'right'];

/** Element that is visible at a point: the top-most one that covers it and isn't invisible. */
function ownerAt(stack: DesignElement[], x: number, y: number): DesignElement | null {
  for (const el of stack) {
    if (el.opacity > 0 && elementContainsPoint(el, { x, y })) return el;
  }
  return null;
}

/**
 * Turns a heatmap into attention per element and role.
 *
 * Each heatmap cell's attention goes to the top-most visible element at the cell's center
 * (paint order, like the renderer). So a button label beats its button, and a headline beats
 * the photo behind it. Cells with no element, or only a background-role element, count as
 * background and are also bucketed into a 4x4 grid of regions to find hot spots.
 */
export function analyzeAttention(design: Design, map: SaliencyMap): AttentionAnalysis {
  const { width: W, height: H } = design.canvas;
  const stack = paintOrder(design).reverse(); // top-most first
  const elementShares: Record<string, number> = {};
  const peaks = new Map<string, number>();
  const regions = new Float64Array(BACKGROUND_GRID * BACKGROUND_GRID);
  let background = 0;

  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const value = map.data[row * map.width + col]!;
      const x = ((col + 0.5) * W) / map.width;
      const y = ((row + 0.5) * H) / map.height;
      const owner = ownerAt(stack, x, y);
      if (!owner || owner.role === 'background') {
        background += value;
        const rc = Math.min(BACKGROUND_GRID - 1, Math.floor((col / map.width) * BACKGROUND_GRID));
        const rr = Math.min(BACKGROUND_GRID - 1, Math.floor((row / map.height) * BACKGROUND_GRID));
        regions[rr * BACKGROUND_GRID + rc]! += value;
        continue;
      }
      elementShares[owner.id] = (elementShares[owner.id] ?? 0) + value;
      peaks.set(owner.id, Math.max(peaks.get(owner.id) ?? 0, value));
    }
  }

  const roleShares: Partial<Record<Role, number>> = {};
  const rolePeaks: Partial<Record<KeyRole, number>> = {};
  for (const el of design.elements) {
    if (!el.role || el.role === 'background') continue;
    roleShares[el.role] = (roleShares[el.role] ?? 0) + (elementShares[el.id] ?? 0);
    if ((KEY_ROLES as readonly string[]).includes(el.role)) {
      const role = el.role as KeyRole;
      rolePeaks[role] = Math.max(rolePeaks[role] ?? 0, peaks.get(el.id) ?? 0);
    }
  }

  // Winner-take-all proxy for first fixations: the role with the strongest peak is seen first.
  const viewingOrder = (Object.keys(rolePeaks) as KeyRole[]).sort(
    (a, b) => rolePeaks[b]! - rolePeaks[a]! || KEY_ROLES.indexOf(a) - KEY_ROLES.indexOf(b),
  );

  const backgroundRegions: BackgroundRegion[] = [];
  for (let r = 0; r < BACKGROUND_GRID; r++) {
    for (let c = 0; c < BACKGROUND_GRID; c++) {
      backgroundRegions.push({
        name: `${ROW_NAMES[r]}-${COL_NAMES[c]}`,
        col: c,
        row: r,
        x: (c * W) / BACKGROUND_GRID,
        y: (r * H) / BACKGROUND_GRID,
        width: W / BACKGROUND_GRID,
        height: H / BACKGROUND_GRID,
        share: regions[r * BACKGROUND_GRID + c]!,
      });
    }
  }

  return {
    elementShares,
    roleShares,
    rolePeaks,
    viewingOrder,
    backgroundShare: background,
    backgroundRegions,
  };
}

/** "4%" style formatting used in messages and overlays. */
export function pct(share: number): string {
  const p = share * 100;
  return `${p < 10 ? Math.round(p * 10) / 10 : Math.round(p)}%`;
}
