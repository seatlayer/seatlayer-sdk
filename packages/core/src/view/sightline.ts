/**
 * Pure sightline math for the auto-360° generator — no DOM, no canvas — so it can
 * be unit-tested and reused headless. Kept out of `generatePanorama.ts` (which
 * touches `document`/`canvas`) on purpose.
 */
import { SEATED_EYE_HEIGHT_M } from '../core/units';

// Stage extents in metres, relative to the flat-ground seated eye baseline — the
// heights the legacy formulas implicitly baked into `atan2(5,…)` / `atan2(1.1,…)`.
export const STAGE_TOP_M = 5;
export const STAGE_BASE_M = -1.1;
/** Plausibility cap: a raised seat never looks further DOWN than this at the stage. */
export const MAX_LOOKDOWN_DEG = 35;

/**
 * Pitch (deg) to the top and base of the stage for a seat whose eye sits
 * `eyeHeightM` above the focal/stage datum, `distM` metres away horizontally.
 *
 * A flat, ground-level seat (`eyeHeightM = SEATED_EYE_HEIGHT_M`) reproduces the
 * legacy `atan2(5,distM)` / `-atan2(1.1,distM)` byte-for-byte. A raised/raked seat
 * (larger `eyeHeightM`) looks DOWN at the stage: both pitches drop and go negative,
 * capped at `MAX_LOOKDOWN_DEG` of depression so a top-balcony view stays plausible.
 */
export function stageSightlinePitch(eyeHeightM: number, distM: number): { topPitch: number; basePitch: number } {
  const extraEyeM = eyeHeightM - SEATED_EYE_HEIGHT_M; // 0 for a flat ground-level seat
  let topPitch = (Math.atan2(STAGE_TOP_M - extraEyeM, distM) * 180) / Math.PI;
  let basePitch = (Math.atan2(STAGE_BASE_M - extraEyeM, distM) * 180) / Math.PI;
  if (basePitch < -MAX_LOOKDOWN_DEG) {
    // Shift the whole stage up so the base rests at the depression cap, preserving
    // its angular height (top stays above base).
    topPitch += -MAX_LOOKDOWN_DEG - basePitch;
    basePitch = -MAX_LOOKDOWN_DEG;
  }
  return { topPitch, basePitch };
}
