/**
 * Distance-based seat level-of-detail (v1). Beyond a bounds-derived threshold the
 * dots shrink and fade toward the tier colour (both uniform-driven, no geometry
 * change); below it they stay full. The POINTS fallback rung can come later.
 */

export interface SeatLod {
  /** Multiplier on the seat world radius (1 = full). */
  scale: number;
  /** Fade toward the tier/fade colour (0 = pure state colour). */
  fade: number;
}

export function computeSeatLod(distance: number, radius: number): SeatLod {
  const near = radius * 1.4;
  const far = radius * 3.2;
  if (distance <= near) return { scale: 1, fade: 0 };
  const t = Math.min(1, (distance - near) / Math.max(1e-3, far - near));
  return {
    scale: 1 - t * 0.4,
    fade: t * 0.55,
  };
}
