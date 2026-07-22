/**
 * Real-world scale primitives — the ONE place the app fixes chart-unit ↔ metre ↔
 * renderer-world scale, and the section 3D-geometry resolver that rides on it.
 *
 * Everything that converts between chart units, metres, and renderer "world"
 * units derives from {@link METRES_PER_CHART_UNIT}. Renderer world units and
 * chart units are 1:1, so metres → world is exactly {@link CHART_UNITS_PER_METRE}
 * (the single m→world conversion constant Phase B consumers use).
 *
 * This is a leaf module (types only) so both `layout.ts` and `sections.ts` can
 * import it without the two forming an import cycle.
 */
import type { SectionObject } from './types';

/**
 * Chart units → metres. seatSpacing 24 ≈ 0.55 m (a real seat pitch). This single
 * constant anchors every real-world scale in the app; `generatePanorama` and the
 * iso lift both derive from it instead of re-declaring their own 0.55/24.
 */
export const METRES_PER_CHART_UNIT = 0.55 / 24;

/**
 * Metres → chart units, i.e. metres → renderer world units (world == chart units
 * in the engine). THE single m→world conversion constant: the iso view lifts an
 * elevated section by `sectionGeometry(section).height × CHART_UNITS_PER_METRE`.
 */
export const CHART_UNITS_PER_METRE = 1 / METRES_PER_CHART_UNIT;

/**
 * Renderer world units a section lifts per {@link SectionObject.elevation} tier in
 * the legacy iso view (mirror of `SeatmapRenderer`'s old `LIFT_PER_STEP`). Kept so
 * the tier→metres fallback below reproduces today's iso look byte-for-byte.
 */
export const LIFT_PER_STEP_WORLD = 58;

/**
 * Metres of front-edge height one elevation tier represents. Chosen (not guessed)
 * so `elevation × TIER_HEIGHT_M` metres, scaled back through
 * {@link CHART_UNITS_PER_METRE}, equals the legacy `elevation × LIFT_PER_STEP`
 * world lift exactly — an un-authored chart stays pixel-identical. ≈ 1.329 m/tier.
 */
export const TIER_HEIGHT_M = LIFT_PER_STEP_WORLD * METRES_PER_CHART_UNIT;

/** Canonical authored section-geometry bounds. Keep every UI/API/renderer on
 * these constants so a producer cannot silently invent a second unit system. */
export const SECTION_ELEVATION_TIER_MIN = 0;
export const SECTION_ELEVATION_TIER_MAX = 3;
export const SECTION_HEIGHT_MIN_M = 0;
export const SECTION_HEIGHT_MAX_M = 120;
export const SECTION_RAKE_MIN_DEG = 0;
export const SECTION_RAKE_MAX_DEG = 45;

/** Curated charts released before the height field used coarse levels 4–7.
 * Preserve their established lift while drafts/templates migrate to an explicit
 * height. Values above 7 came from broken compiler multipliers and must never be
 * interpreted as physical tiers. */
export const LEGACY_SECTION_ELEVATION_TIER_MAX = 7;

/**
 * Seated spectator eye height above the tier floor (arena ≈ 1.20 m; theatre refs
 * use 1.15 m). Also the flat-ground baseline eye height, so a flat, ground-level
 * seat produces zero elevation offset in the 360° stage-pitch math (back-compat).
 */
export const SEATED_EYE_HEIGHT_M = 1.2;

/**
 * Resolve a section's real 3D geometry, applying the legacy-elevation fallback so
 * old charts and new charts share ONE code path. Every consumer (iso lift, 360°
 * eye-height, author lint, any 2D depth cue) must call this and never read the raw
 * {@link SectionObject.height}/{@link SectionObject.rake} fields — that is what
 * keeps un-authored charts rendering identically to today.
 *
 * - `height`: authored absolute metres if present, else owning-floor base height
 *   plus `elevation × TIER_HEIGHT_M`.
 * - `rake`: authored degrees if present, else 0 (flat).
 *
 * Malformed values are bounded here as a last defensive barrier. Structural
 * validation still reports them so drafts can be repaired instead of silently
 * persisting a renderer-only interpretation.
 *
 * Pure — no document mutation, no side effects.
 */
export interface SectionGeometryContext {
  /** Absolute physical height of the owning floor above the venue datum. */
  floorBaseHeightM?: number;
}

function finiteClamped(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value as number)) : fallback;
}

/** Canonical 0–3 tier exposed by Designer/shared operations. */
export function sectionElevationTier(value: number | undefined): number {
  if (!Number.isFinite(value)) return SECTION_ELEVATION_TIER_MIN;
  return Math.max(
    SECTION_ELEVATION_TIER_MIN,
    Math.min(SECTION_ELEVATION_TIER_MAX, Math.round(value as number)),
  );
}

/** Runtime-only compatibility tier. Released curated charts used integers 4–7;
 * preserve those while bounding compiler mistakes such as 12/55/220 to the
 * canonical maximum. New documents must store only {@link sectionElevationTier}. */
function compatibleAutomaticTier(value: number | undefined): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || (value as number) < 0) return 0;
  if ((value as number) <= LEGACY_SECTION_ELEVATION_TIER_MAX) return value as number;
  return SECTION_ELEVATION_TIER_MAX;
}

export function sectionGeometry(
  section: Pick<SectionObject, 'elevation' | 'height' | 'rake'>,
  context: SectionGeometryContext = {},
): {
  height: number;
  rake: number;
} {
  const floorBaseHeightM = finiteClamped(
    context.floorBaseHeightM,
    SECTION_HEIGHT_MIN_M,
    SECTION_HEIGHT_MAX_M,
    0,
  );
  const automaticHeight = Math.min(
    SECTION_HEIGHT_MAX_M,
    floorBaseHeightM + compatibleAutomaticTier(section.elevation) * TIER_HEIGHT_M,
  );
  const height = section.height === undefined
    ? automaticHeight
    : finiteClamped(section.height, SECTION_HEIGHT_MIN_M, SECTION_HEIGHT_MAX_M, automaticHeight);
  const rake = finiteClamped(section.rake, SECTION_RAKE_MIN_DEG, SECTION_RAKE_MAX_DEG, 0);
  return { height, rake };
}
