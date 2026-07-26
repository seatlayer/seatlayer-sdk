/**
 * Resolve a chart's authored theme into the 3D scene's colours.
 *
 * Every chart already carries a `ChartTheme` — background, brand accent, seat
 * scale — and the 2D renderer and the picker chrome honour it. The 3D view did
 * not: `palette.ts` was a fixed set of constants, so a white-labelled event
 * rendered in SeatLayer's own dark grey whatever the organizer had branded. That
 * is a visible gap in a paid feature, and it is the kind of thing a customer
 * notices immediately when they switch from the 2D map to the 3D view.
 *
 * The palette in `palette.ts` stays the DEFAULT and the reference. This module
 * only rebases it, so an unthemed chart is byte-for-byte what it was.
 *
 * ## How structure is rebased
 *
 * Structure colours are not replaced by the brand colour — a venue rendered in
 * flat brand paint reads as a diagram, not a building, and the look brief is
 * deliberately "desaturated greys for structure, saturated colour only on
 * seats". Instead each structure colour is blended a little way toward the
 * authored background, so the whole venue picks up the brand's cast and sits in
 * its own light, while keeping the tonal relationships (tier above wall, stage
 * warmer than tier) that make the geometry readable.
 */

import type { ChartTheme } from '../core/types';
import { BACKGROUND, SEAT_STATE_COLORS, STRUCTURE, hexToRgb, mix, scaleRgb, type RGB, type SeatState3D } from './palette';

/** How far a structure colour is pulled toward the authored background. */
const BACKGROUND_INFLUENCE = 0.15;

/**
 * The background gradient's two stops as multiples of the authored colour.
 *
 * Fitted to the existing hand-tuned gradient on the default `#0e1117`, whose
 * per-channel ratios are 0.91/0.90/0.89 for the top stop and 1.82/1.80/1.66 for
 * the bottom. A single scalar cannot reproduce a hand-picked triple exactly, so
 * these are the best fit: an authored background lands within ~0.01 of the old
 * look, and an UNTHEMED chart bypasses this path entirely and stays identical.
 * What matters is that a themed chart gets the same vertical falloff around its
 * own colour rather than a flat wash.
 */
const BG_TOP_SCALE = 0.9;
const BG_BOTTOM_SCALE = 1.76;

/** Bounds on the authored seat-size multiplier, matching `ChartTheme.seatScale`. */
const SEAT_SCALE_MIN = 0.7;
const SEAT_SCALE_MAX = 1.6;

export interface Theme3D {
  background: { top: RGB; bottom: RGB };
  structure: typeof STRUCTURE;
  seatStates: Record<SeatState3D, RGB>;
  /** Multiplier on the seat dot's world radius. */
  seatScale: number;
}

/** The unthemed default — the palette exactly as authored in `palette.ts`. */
export function defaultTheme3D(): Theme3D {
  return {
    background: { top: [...BACKGROUND.top] as RGB, bottom: [...BACKGROUND.bottom] as RGB },
    structure: STRUCTURE,
    seatStates: { ...SEAT_STATE_COLORS },
    seatScale: 1,
  };
}

export function resolveTheme3D(theme: ChartTheme | undefined): Theme3D {
  const base = defaultTheme3D();
  if (!theme) return base;

  const bg = hexToRgb(theme.background);
  if (bg) {
    base.background = {
      top: scaleRgb(bg, BG_TOP_SCALE),
      bottom: scaleRgb(bg, BG_BOTTOM_SCALE),
    };
    // Rebase every structure colour onto the authored background. Done as one
    // pass over the palette rather than field by field, so a colour added to
    // STRUCTURE later is themed automatically instead of silently staying fixed.
    const rebased: Record<string, RGB> = {};
    for (const [key, value] of Object.entries(STRUCTURE)) {
      rebased[key] = mix(value as RGB, bg, BACKGROUND_INFLUENCE);
    }
    base.structure = rebased as unknown as typeof STRUCTURE;
  }

  // Selection is the one seat colour a brand owns: it is the buyer's own
  // choice reflected back, and the picker chrome already paints it in `accent`.
  // Availability, held and sold stay fixed — they carry MEANING, and letting a
  // brand recolour "sold" would let a chart mislead about what is for sale.
  const selection = hexToRgb(theme.selectionColor) ?? hexToRgb(theme.accent);
  if (selection) base.seatStates = { ...base.seatStates, selected: selection };

  const scale = theme.seatScale;
  if (typeof scale === 'number' && Number.isFinite(scale)) {
    base.seatScale = Math.min(SEAT_SCALE_MAX, Math.max(SEAT_SCALE_MIN, scale));
  }
  return base;
}

/** Flat LUT (5 × vec3) for the seat fragment shader, in `SEAT_STATES` order. */
export function themeSeatColorLUT(theme: Theme3D, order: readonly SeatState3D[]): number[] {
  const out: number[] = [];
  for (const s of order) out.push(...theme.seatStates[s]);
  return out;
}
