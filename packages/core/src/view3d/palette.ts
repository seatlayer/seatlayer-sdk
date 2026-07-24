/**
 * view3d palette + seat-state model — the single source of colour truth for the
 * OGL venue view. Pure data (no GPU, no DOM) so the scene builder and the unit
 * tests share one definition. Colours are linear-ish RGB triplets in 0..1.
 *
 * Look brief (docs/3d-usp-strategy §3): desaturated cool greys for structure,
 * one warm accent for the stage, availability colours only on seats.
 */

export type SeatState3D = 'available' | 'held' | 'sold' | 'selected' | 'dimmed';

/** Fixed LUT order — the per-instance `iState` float indexes this array, and the
 * fragment shader's `uStateColors` uniform is uploaded in exactly this order. */
export const SEAT_STATES: SeatState3D[] = ['available', 'held', 'sold', 'selected', 'dimmed'];

export function seatStateIndex(state: SeatState3D): number {
  const i = SEAT_STATES.indexOf(state);
  return i < 0 ? 0 : i;
}

export type RGB = [number, number, number];

/** Availability colours — the only saturated colours in the scene. */
export const SEAT_STATE_COLORS: Record<SeatState3D, RGB> = {
  available: [0.24, 0.82, 0.52],
  held: [0.95, 0.66, 0.22],
  sold: [0.34, 0.39, 0.45],
  selected: [0.24, 0.74, 1.0],
  dimmed: [0.28, 0.32, 0.37],
};

/** Flat LUT (5 × vec3) for the seat fragment shader uniform. */
export function seatStateColorLUT(): number[] {
  const out: number[] = [];
  for (const s of SEAT_STATES) out.push(...SEAT_STATE_COLORS[s]);
  return out;
}

/** Colour for a state index (from `iState`) — used to fill the per-instance
 * `iColor` attribute CPU-side, avoiding a dynamically-indexed array uniform. */
export function seatStateColorByIndex(index: number): RGB {
  const state = SEAT_STATES[index] ?? 'available';
  return SEAT_STATE_COLORS[state];
}

/** Structure palette — cool desaturated greys + one warm stage accent. */
export const STRUCTURE = {
  ground: [0.07, 0.085, 0.11] as RGB,
  tierTop: [0.24, 0.28, 0.34] as RGB,
  tierWall: [0.17, 0.20, 0.25] as RGB,
  stageTop: [0.42, 0.36, 0.26] as RGB, // warm, slightly emissive read
  stageWall: [0.26, 0.22, 0.16] as RGB,
  decorTop: [0.22, 0.25, 0.29] as RGB,
  decorWall: [0.15, 0.17, 0.20] as RGB,
  gaTop: [0.24, 0.28, 0.33] as RGB,
  gaWall: [0.16, 0.19, 0.23] as RGB,
} as const;

/** Background vertical gradient (matches the app's dark UI). */
export const BACKGROUND = {
  top: [0.05, 0.06, 0.08] as RGB,
  bottom: [0.10, 0.12, 0.15] as RGB,
};

/** Parse `#rrggbb` (or `#rgb`) to linear-ish 0..1 RGB; null on anything else. */
export function hexToRgb(hex: string | undefined): RGB | null {
  if (!hex) return null;
  let h = hex.trim();
  if (h[0] === '#') h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Mix two colours (a*(1-t) + b*t). */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Desaturate toward its own luma by `amount` (0 = unchanged, 1 = grey). */
export function desaturate(c: RGB, amount: number): RGB {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return mix(c, [l, l, l], amount);
}

/** Scale a colour by a scalar (baked vertex AO), clamped to [0,1]. */
export function scaleRgb(c: RGB, k: number): RGB {
  return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];
}
